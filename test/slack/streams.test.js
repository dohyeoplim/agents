import test from "node:test";
import assert from "node:assert/strict";
import { createSlackStreams } from "../../src/slack/streams.js";
import { streamText } from "../../src/slack/formatting.js";

const task = { id: "task", channel: "C1", thread: "100.001", team: "T1", user: "U1", profile: "scholar" };

function fixture(fail) {
    const data = { tasks: { task: {} } };
    const calls = [];
    const posted = [];
    let time = 0;
    const streams = createSlackStreams({
        state: { snapshot: () => structuredClone(data), update: async (fn) => fn(data) }, token: "test",
        post: async (context, text) => posted.push(text), profiles: async () => ({ scholar: { name: "Scholar" } }),
        now: () => time,
        request: async (url, options) => {
            const method = url.split("/").at(-1);
            const input = JSON.parse(options.body);
            calls.push({ method, input });
            return Response.json(fail?.(method, input) || { ok: true, ts: "101.001" });
        },
    });
    return { streams, data, calls, posted, tick: () => { time += 1100; } };
}

test("stream delivery", async () => {
    const { streams, data, calls, posted, tick } = fixture();
    await streams.update(task, "Hello ");
    tick();
    await streams.update(task, "Hello world ");
    await streams.deliver(task, "Hello world!");
    assert.equal(data.tasks.task.streamTs, "101.001");
    assert.deepEqual(calls.map((call) => call.method),
        ["chat.startStream", "chat.appendStream", "chat.stopStream", "chat.update"]);
    assert.equal(calls[0].input.username, "Scholar");
    assert.equal(calls[0].input.recipient_user_id, "U1");
    assert.equal(calls[1].input.markdown_text, "world ");
    assert.equal(calls[3].input.markdown_text, "Hello world!");
    assert.equal(posted.length, 0);
});

test("stream fallback", async () => {
    const { streams, posted } = fixture(() => ({ ok: false, error: "not_in_channel" }));
    await streams.update(task, "Hello ");
    await streams.deliver(task, "Complete answer");
    assert.deepEqual(posted, ["Complete answer"]);
});

test("stream recovery", async () => {
    const { streams, data, calls } = fixture((method) =>
        method === "chat.stopStream" ? { ok: false, error: "message_not_in_streaming_state" } : undefined);
    data.tasks.task.streamTs = "101.001";
    await streams.deliver(task, "Task cancelled.");
    assert.equal(calls.at(-1).input.markdown_text, "Task cancelled.");
});

test("stream boundaries", () => {
    assert.equal(streamText("Hello xoxb-sec"), "Hello ");
    assert.equal(streamText("Hello xoxb-secret "), "Hello [REDACTED] ");
    assert.equal(streamText("Hello <@U123"), "Hello ");
    assert.ok(!streamText("Hello <@U123> ").includes("<@U123>"));
});

test("scheduled delivery", async () => {
    const { streams, calls, posted } = fixture();
    await streams.update({ ...task, scheduleId: "schedule" }, "Hello ");
    await streams.deliver(task, "Hello");
    assert.equal(calls.length, 0);
    assert.deepEqual(posted, ["Hello"]);
});
