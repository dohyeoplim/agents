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
        personal: async () => null,
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
    assert.equal(calls[0].body.notionAccess, false);
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

test("research uses a fresh provider session without normal history, streaming, activity or timeout", async () => {
    const controller = new AbortController();
    let sent;
    const execute = createTaskExecutor({
        state: { snapshot: () => ({ threads: { thread: { session } } }) },
        personal: async () => null,
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: { agent: "assistant" } } }),
        activity: () => assert.fail("No ordinary activity"),
        streams: { update: () => assert.fail("No ordinary stream") },
        historyContext: { hydrate: () => assert.fail("No ordinary conversation history") },
        request: async (url, options) => {
            assert.equal(options.signal, controller.signal);
            sent = JSON.parse(options.body);
            return { ok: true, json: async () => ({ session, answer: "Research" }) };
        },
    });
    await execute({ ...task, researchId: session, researchRunId: session,
        researchStage: "counter", provider: "claude" }, controller.signal);
    assert.equal(sent.session, undefined);
    assert.equal(sent.researchId, session);
    assert.equal(sent.researchRunId, session);
    assert.equal(sent.researchStage, "counter");
    assert.equal(sent.provider, "claude");
    assert.equal(sent.stream, true);
});

test("tool grant lifetime", async () => {
    const events = [];
    const execute = createTaskExecutor({ state: { snapshot: () => ({}) },
        personal: async () => null,
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

test("Notion access follows the configured owner and requires a task grant", async () => {
    const cases = [
        { settings: { owner: "U2" }, user: "U2", grant: true, allowed: true },
        { settings: { owner: "U2" }, user: "U1", grant: true, allowed: false },
        { settings: null, user: "U1", grant: true, allowed: true },
        { settings: null, user: "U2", grant: true, allowed: false },
        { settings: { owner: "U2" }, user: "U2", grant: false, allowed: false },
    ];
    for (const example of cases) {
        for (const extra of [{}, { scheduleId: "daily" }, { briefingDate: "2026-01-01" }]) {
            let sent;
            const execute = createTaskExecutor({
                state: { snapshot: () => ({}) },
                personal: async () => example.settings,
                config: async () => ({ team: "T1", users: ["U1", "U2"],
                    channels: { C1: { agent: "assistant" } } }),
                activity: async (context, run) => run(),
                briefingContext: async () => "{}",
                toolServer: { grant: () => example.grant ? { token: "task-token", revoke() {} } : undefined },
                request: async (url, options) => {
                    sent = JSON.parse(options.body);
                    return { ok: true, json: async () => ({ session, answer: "Done" }) };
                },
            });
            await execute({ ...task, user: example.user, ...extra }, new AbortController().signal);
            assert.equal(sent.notionAccess, example.allowed, JSON.stringify({ example, extra }));
            assert.equal(sent.owner, undefined);
            assert.equal(sent.personal, undefined);
        }
    }
});

test("Notion owner must still be authorized for the task", async () => {
    const execute = createTaskExecutor({
        state: {},
        personal: async () => assert.fail("Must authorize the task before reading private settings"),
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: { agent: "assistant" } } }),
        toolServer: { grant: () => assert.fail("Must not grant unauthorized tasks") },
        request: async () => assert.fail("Must not execute unauthorized tasks"),
    });
    await assert.rejects(execute({ ...task, user: "U2" }, new AbortController().signal), /no longer authorized/);
});
