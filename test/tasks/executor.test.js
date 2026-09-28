import test from "node:test";
import assert from "node:assert/strict";
import { createTaskExecutor } from "../../src/tasks/executor.js";

const session = "12345678-1234-1234-1234-123456789abc";
const task = {
    id: session, key: "thread", team: "T1", user: "U1", channel: "C1",
    thread: "100.001", profile: "assistant", prompt: "hello",
};

test("worker request", async () => {
    const calls = [];
    const execute = createTaskExecutor({
        state: { snapshot: () => ({ threads: { thread: { session } } }) },
        token: "test",
        resources: { collect: async () => ({ sources: [{ id: "F123456", text: "Source text" }], notices: [] }) },
        historyContext: { hydrate: async (input, currentSession) => {
            assert.equal(input.id, task.id);
            assert.equal(currentSession, session);
            return { text: "Earlier thread", receipt: { hashes: { "100.0": "revision" } } };
        } },
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: { agent: "assistant" } } }),
        activity: async (context, run) => run(),
        request: async (url, options) => {
            calls.push({ url, body: JSON.parse(options.body) });
            return { ok: true, json: async () => ({ session, answer: "Done" }) };
        },
    });
    const result = await execute(task, new AbortController().signal);
    assert.equal(result.answer, "Done");
    assert.equal(calls[0].url, "http://assistant:8080/run");
    assert.equal(calls[0].body.session, session);
    assert.equal(calls[0].body.profile, "assistant");
    assert.equal(JSON.parse(calls[0].body.sourceContext).sources[0].text, "Source text");
    assert.equal(calls[0].body.historyContext, "Earlier thread");
    assert.deepEqual(result.historyReceipt, { hashes: { "100.0": "revision" } });
});

test("worker access", async () => {
    const execute = createTaskExecutor({
        state: {}, token: "test",
        config: async () => ({ team: "T1", users: ["U1"], channels: {} }),
        request: async () => assert.fail("Unexpected request"),
    });
    await assert.rejects(execute(task, new AbortController().signal), /no longer authorized/);
});

test("tool grant lifetime", async () => {
    const events = [];
    const execute = createTaskExecutor({ state: { snapshot: () => ({}) },
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: { agent: "assistant" } } }),
        briefingContext: async () => { events.push("prepare"); return "{}"; },
        toolServer: { grant: () => {
            events.push("grant");
            return { token: "test", revoke: () => events.push("revoke") };
        } },
        request: async () => {
            events.push("run");
            return { ok: true, json: async () => ({ session, answer: "Done" }) };
        },
    });
    await execute({ ...task, briefingDate: "2026-01-01" }, new AbortController().signal);
    assert.deepEqual(events, ["prepare", "grant", "run", "revoke"]);
});
