import test from "node:test";
import assert from "node:assert/strict";
import { createTaskExecutor } from "../../src/tasks/executor.js";
import { createHistoryContext } from "../../src/slack/history-context.js";

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

test("research execution", async () => {
    const controller = new AbortController();
    let sent;
    const execute = createTaskExecutor({
        state: { snapshot: () => ({ threads: { thread: { session } } }) },
        personal: async () => null,
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: { agent: "assistant" } } }),
        activity: () => assert.fail("No ordinary activity"),
        streams: { update: () => assert.fail("No ordinary stream") },
        resources: { collect: async (input, signal, options) => {
            assert.equal(options.discover, false);
            return { sources: [], notices: [] };
        } },
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

function telemetry(events, { beforeUpdate, mutate } = {}) {
    const input = { ...task, researchId: "research", researchRunId: "run", researchStage: "explore",
        status: "running" };
    const data = { tasks: { [input.id]: structuredClone(input) },
        researchJobs: { research: { runId: "run", status: "running" } } };
    mutate?.(data);
    const controller = new AbortController();
    const state = { snapshot: () => structuredClone(data), update: async (change) => {
        await beforeUpdate?.(controller);
        return change(data);
    } };
    const execute = createTaskExecutor({ state, personal: async () => null,
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: { agent: "assistant" } } }),
        request: async (url) => {
            if (url.endsWith("/cancel")) return { ok: true };
            return new Response([...events, { type: "result", session, answer: "Done" }]
                .map((event) => JSON.stringify(event) + "\n").join(""),
            { headers: { "content-type": "application/x-ndjson" } });
        },
    });
    return { run: () => execute(input, controller.signal), data, input };
}

test("research telemetry", async () => {
    const progress = (providerEvents, lastActivityAt) => ({ type: "progress", providerEvents, lastActivityAt });
    const f = telemetry([progress(2, 1000), { type: "heartbeat" }, progress(1, 2000), progress(3, 900)]);
    assert.equal((await f.run()).answer, "Done");
    assert.equal(f.data.tasks[f.input.id].providerEvents, 2);
    assert.equal(f.data.tasks[f.input.id].lastActivityAt, 1000);
    const empty = telemetry([{ type: "heartbeat" }]);
    await empty.run();
    assert.equal(empty.data.tasks[empty.input.id].providerEvents, undefined);
    assert.equal(empty.data.tasks[empty.input.id].lastActivityAt, undefined);
});

test("campaign telemetry", async () => {
    const f = telemetry([{ type: "progress", providerEvents: 1, lastActivityAt: 1000 }]);
    f.input.autoresearchId = "research";
    f.input.researchStage = "campaign";
    f.data.autoresearchJobs = { research: { runId: "run", status: "running", mode: "campaign" } };
    delete f.data.researchJobs;
    await f.run();
    assert.equal(f.data.tasks[f.input.id].providerEvents, 1);
    f.data.autoresearchJobs.research.runId = "other";
    f.data.tasks[f.input.id].providerEvents = 0;
    await f.run();
    assert.equal(f.data.tasks[f.input.id].providerEvents, 0);
});

test("stale telemetry", async () => {
    for (const mutate of [
        (data) => { data.researchJobs.research.runId = "replacement"; },
        (data) => { data.researchJobs.research.status = "paused"; },
        (data) => { data.tasks[task.id].status = "cancelled"; },
        (data) => { data.tasks[task.id].researchRunId = "replacement"; },
    ]) {
        const f = telemetry([{ type: "progress", providerEvents: 2, lastActivityAt: 1000 }], { mutate });
        const before = structuredClone(f.data);
        await f.run();
        assert.deepEqual(f.data, before);
    }
});

test("cancelled telemetry", async () => {
    const f = telemetry([{ type: "progress", providerEvents: 2, lastActivityAt: 1000 }],
        { beforeUpdate: (controller) => controller.abort() });
    const before = structuredClone(f.data);
    await assert.rejects(f.run(), { name: "AbortError" });
    assert.deepEqual(f.data, before);
});

test("telemetry storage", async () => {
    const failure = Error("Database unavailable");
    const f = telemetry([{ type: "progress", providerEvents: 2, lastActivityAt: 1000 }],
        { beforeUpdate: () => { throw failure; } });
    await assert.rejects(f.run(), (error) => error === failure);
    assert.equal(f.data.tasks[f.input.id].providerEvents, undefined);
});

test("clarification history", async () => {
    const state = { snapshot: () => ({ threads: { thread: { session } } }) };
    const messages = [
        { ts: "100.000001", user: "U1", text: "Compare offline methods for mobile devices" },
        { ts: "100.000002", user: "U1", text: "Keep memory use under 4 GB" },
        { ts: "100.000003", user: "U1", text: "Start research" },
        { ts: "100.000004", user: "U1", text: "A later request" },
    ];
    let sent;
    let unavailable = false;
    const historyContext = createHistoryContext({ state, history: { read: async (args, context) => {
        assert.equal(args.thread, "100.000001");
        assert.equal(args.latest, "100.000003");
        assert.equal(context.channel, task.channel);
        if (unavailable) throw Error("History unavailable");
        return { messages };
    } } });
    const execute = createTaskExecutor({ state, historyContext, personal: async () => null,
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: { agent: "assistant" } } }),
        request: async (url, options) => {
            sent = JSON.parse(options.body);
            return { ok: true, json: async () => ({ session, answer: "Plan" }) };
        },
    });
    const input = { ...task, researchId: session, researchStage: "clarify",
        thread: "100.000001", messageTs: "100.000003" };
    await execute(input, new AbortController().signal);
    assert.equal(sent.session, undefined);
    assert.deepEqual(JSON.parse(sent.historyContext).messages.map((message) => message.text),
        messages.slice(0, 2).map((message) => message.text));
    unavailable = true;
    await execute(input, new AbortController().signal);
    assert.match(sent.historyContext, /could not be fully loaded/);
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

test("Notion grants", async () => {
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

test("Notion owner authorization", async () => {
    const execute = createTaskExecutor({
        state: {},
        personal: async () => assert.fail("Must authorize the task before reading private settings"),
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: { agent: "assistant" } } }),
        toolServer: { grant: () => assert.fail("Must not grant unauthorized tasks") },
        request: async () => assert.fail("Must not execute unauthorized tasks"),
    });
    await assert.rejects(execute({ ...task, user: "U2" }, new AbortController().signal), /no longer authorized/);
});
