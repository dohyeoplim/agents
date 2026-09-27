import test from "node:test";
import assert from "node:assert/strict";
import { withSlackActivity } from "../src/activity.js";

function mockStatus(results = []) {
    const calls = [];
    const request = async (url, options) => {
        calls.push({ method: url.split("/").at(-1), ...JSON.parse(options.body) });
        return { ok: true, json: async () => results.shift() || { ok: true } };
    };
    return { calls, request };
}

test("activity is shown during work and cleared after completion", async () => {
    const { calls, request } = mockStatus();
    const result = await withSlackActivity({ token: "test", channel: "C1", thread: "123.456", request }, async () => {
        assert.equal(calls.at(-1).status, "processing");
        return "done";
    });
    assert.equal(result, "done");
    assert.deepEqual(calls.map((call) => call.status), ["processing", "active"]);
    assert.ok(calls.every((call) => call.channel_id === "C1" && call.thread_ts === "123.456"));
});

test("activity clears when the worker fails without hiding its error", async () => {
    const { calls, request } = mockStatus();
    await assert.rejects(withSlackActivity({ token: "test", channel: "C1", thread: "123.456", request }, async () => {
        throw Error("Worker failure");
    }), /Worker failure/);
    assert.equal(calls.at(-1).status, "active");
});

test("unsupported agent sessions fall back to thread status and clear it", async () => {
    const { calls, request } = mockStatus([{ ok: false, error: "feature_disabled" }]);
    await withSlackActivity({ token: "test", channel: "C1", thread: "123.456", request }, async () => {});
    assert.deepEqual(calls.map((call) => call.method), [
        "agents.sessions.setStatus",
        "assistant.threads.setStatus",
        "assistant.threads.setStatus",
    ]);
    assert.equal(calls[1].status, "is working on your request...");
    assert.equal(calls[2].status, "");
});

test("Slack status failures do not prevent the reply task", async () => {
    const request = async () => { throw Error("Network unavailable"); };
    const result = await withSlackActivity(
        { token: "test", channel: "C1", thread: "123.456", request },
        async () => 42,
    );
    assert.equal(result, 42);
});

test("legacy status works when agent sessions are not authorized for the app", async () => {
    const { calls, request } = mockStatus([{ ok: false, error: "not_authorized" }]);
    await withSlackActivity({ token: "test", channel: "C1", thread: "123.456", request }, async () => {});
    assert.equal(calls[1].method, "assistant.threads.setStatus");
    assert.equal(calls.at(-1).status, "");
});

test("long tasks refresh activity and release the timer after finishing", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { calls, request } = mockStatus();
    let finish;
    const task = new Promise((resolve) => { finish = resolve; });
    const run = withSlackActivity({ token: "test", channel: "C1", thread: "123.456", request }, () => task);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(60000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((call) => call.status === "processing").length, 2);
    finish();
    await run;
    const count = calls.length;
    t.mock.timers.tick(120000);
    assert.equal(calls.length, count);
    assert.equal(calls.at(-1).status, "active");
});
