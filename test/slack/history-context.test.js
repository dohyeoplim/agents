import test from "node:test";
import assert from "node:assert/strict";
import { createHistoryContext } from "../../src/slack/history-context.js";

const task = { key: "thread", profile: "assistant", user: "U1", thread: "100.000001", messageTs: "100.000003" };
const message = { ts: "100.000001", text: "Original discussion", user: "U2", url: "https://slack.test/first" };

function fixture(messages = [message], extra = {}) {
    const data = { threads: { thread: {} } };
    const calls = [];
    const service = createHistoryContext({
        state: { snapshot: () => structuredClone(data) },
        history: { read: async (...args) => {
            calls.push(args);
            return { messages, ...extra };
        } },
    });
    const commit = (receipt, session = "session1") => {
        data.threads.thread.historyContexts = { "assistant:U1": { ...receipt, session } };
    };
    return { service, calls, commit, messages };
}

test("thread hydration", async () => {
    const { service, calls, commit } = fixture([
        message, { ...message, ts: task.messageTs, text: "Current trigger" },
        { ...message, ts: "100.000004", text: "Later request" },
    ]);
    const initial = await service.hydrate(task, undefined);
    assert.deepEqual(JSON.parse(initial.text).messages.map((entry) => entry.text), ["Original discussion"]);
    assert.equal(calls[0][0].latest, task.messageTs);
    assert.equal(calls[0][0].limit, 30);
    commit(initial.receipt);
    assert.equal((await service.hydrate(task, "session1")).text, "");
    assert.match((await service.hydrate(task, "session2")).text, /Original discussion/);
    assert.match((await service.hydrate(task, undefined)).text, /Original discussion/);
});

test("receipt isolation", async () => {
    const { service, commit, messages } = fixture();
    commit((await service.hydrate(task, "session1")).receipt);
    messages[0] = { ...message, text: "Corrected discussion" };
    const updated = JSON.parse((await service.hydrate(task, "session1")).text);
    assert.equal(updated.messages[0].changed, true);
    assert.equal(updated.messages[0].text, "Corrected discussion");
    const other = JSON.parse((await service.hydrate({ ...task, user: "U3" }, "session1")).text);
    assert.equal(other.messages[0].changed, false);
});

test("hydration limits", async () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
        ...message, ts: `99.${String(index).padStart(6, "0")}`, text: "content".repeat(1000),
    }));
    const { service, commit } = fixture(messages, { hasMore: true, nextCursor: "cursor" });
    const initial = await service.hydrate(task, "session1");
    const output = JSON.parse(initial.text);
    assert.ok(initial.text.length <= 12000);
    assert.equal(output.nextCursor, undefined);
    assert.equal(output.next.oldest, initial.receipt.watermark);
    assert.equal(output.next.oldest, output.messages.at(-1).ts);
    assert.equal(output.next.latest, task.messageTs);
    assert.ok(output.next.oldest < messages.at(-1).ts);
    assert.match(output.notices.join(" "), /partial thread/);
    assert.match(output.notices.join(" "), /omitted/);
    assert.match(output.notices.join(" "), /excerpts/);
    assert.ok(output.messages.every((entry) => entry.truncated));
    assert.equal(Object.keys(initial.receipt.hashes).length, output.messages.length);
    commit(initial.receipt);
    const next = JSON.parse((await service.hydrate(task, "session1")).text);
    assert.ok(next.messages.length > 0);
    assert.ok(next.messages.every((entry) => !initial.receipt.hashes[entry.ts]));
});

test("history exclusions", async () => {
    const { service, calls } = fixture();
    for (const input of [
        { ...task, messageTs: task.thread }, { ...task, messageTs: undefined },
        { ...task, scheduleId: "S1" }, { ...task, briefingDate: "2026-09-28" },
    ]) assert.equal((await service.hydrate(input)).text, "");
    assert.equal(calls.length, 0);
});

test("history failures", async () => {
    const service = createHistoryContext({ state: { snapshot: () => ({}) },
        history: { read: async () => { throw Error("secret"); } } });
    const result = await service.hydrate(task, undefined);
    assert.match(result.text, /could not be fully loaded/);
    assert.ok(!result.text.includes("secret"));
    assert.equal(result.receipt, undefined);
    await assert.rejects(service.hydrate(task, undefined, AbortSignal.abort()), /cancelled/);
});

test("hydration continuation", async () => {
    const data = { threads: { thread: {} } };
    const calls = [];
    const service = createHistoryContext({ state: { snapshot: () => data }, history: {
        read: async (args) => {
            calls.push(args);
            const index = args.oldest ? Number(args.oldest.split(".")[1]) + 1 : 1;
            const ts = `99.${String(index).padStart(6, "0")}`;
            return { messages: [{ ...message, ts }], hasMore: true,
                next: { ...args, oldest: ts }, notice: "Live data" };
        },
    } });
    const first = await service.hydrate(task);
    assert.equal(calls.length, 3);
    assert.equal(first.receipt.watermark, "99.000003");
    data.threads.thread.historyContexts = { "assistant:U1": { ...first.receipt, session: "session1" } };
    const second = await service.hydrate(task, "session1");
    assert.equal(calls.length, 6);
    assert.equal(calls[4].oldest, "99.000003");
    assert.equal(second.receipt.watermark, "99.000005");
    assert.equal(JSON.parse(second.text).next.oldest, "99.000005");
    assert.match(second.text, /Live data/);
});

test("excerpt revisions", async () => {
    const { service, commit, messages } = fixture([{ ...message, truncated: true, revision: "original" }]);
    commit((await service.hydrate(task, "session1")).receipt);
    messages[0] = { ...messages[0], revision: "edited-tail" };
    const updated = JSON.parse((await service.hydrate(task, "session1")).text);
    assert.equal(updated.messages[0].changed, true);
});

test("reply progression", async () => {
    const data = { threads: { thread: {} } };
    let end = 0;
    const service = createHistoryContext({ state: { snapshot: () => data }, history: {
        read: async (args) => {
            const start = args.oldest ? Number(args.oldest.split(".")[1]) + 1 : 1;
            const stop = args.oldest ? Math.min(start + 29, end) : Math.min(30, end);
            const messages = Array.from({ length: Math.max(0, stop - start + 1) }, (_, index) => ({
                ...message, text: "short", ts: `99.${String(start + index).padStart(6, "0")}`,
            }));
            return { messages, hasMore: stop < end,
                next: stop < end ? { ...args, oldest: messages.at(-1).ts } : undefined };
        },
    } });
    let last;
    for (let turn = 1; turn <= 8; turn += 1) {
        end = turn * 20;
        last = await service.hydrate(task, "session1");
        data.threads.thread.historyContexts = { "assistant:U1": { ...last.receipt, session: "session1" } };
    }
    assert.ok(Object.keys(last.receipt.hashes).length <= 120);
    assert.ok(last.receipt.hashes["99.000001"]);
    assert.ok(last.receipt.hashes["99.000030"]);
    assert.equal(last.receipt.watermark, "99.000160");
    assert.ok(JSON.parse(last.text).messages.every((entry) => entry.ts > "99.000140"));
});
