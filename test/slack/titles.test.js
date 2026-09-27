import test from "node:test";
import assert from "node:assert/strict";
import { createThreadTitles, suggestTitle, normalizeTitle } from "../../src/slack/titles.js";

const context = { team: "T1", user: "U1", channel: "C1", thread: "100.001", key: "T1:C1:100.001:assistant" };

function fixture(results = []) {
    const data = { threads: { [context.key]: {} } };
    const calls = [];
    const state = { snapshot: () => structuredClone(data), update: async (change) => change(data) };
    const titles = createThreadTitles({
        state, token: "test",
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: { agent: "assistant" } } }),
        request: async (url, options) => {
            calls.push({ method: url.split("/").at(-1), ...JSON.parse(options.body) });
            return { ok: true, json: async () => results.shift() || { ok: true } };
        },
    });
    return { titles, data, calls };
}

test("title suggestion", () => {
    assert.equal(suggestTitle("# **Review** [paper](https://example.com)\nPlease"), "Review paper Please");
    assert.ok(suggestTitle("🙂".repeat(100)).length <= 200);
    assert.ok(suggestTitle("Review sk-test-secret").includes("[REDACTED]"));
    assert.throws(() => normalizeTitle(" "));
    assert.throws(() => normalizeTitle("x".repeat(201)));
});

test("automatic title", async () => {
    const { titles, calls, data } = fixture();
    await titles.ensure(context, "Initial request");
    await titles.ensure(context, "Follow up");
    assert.equal(calls.length, 1);
    assert.equal(data.threads[context.key].title, "Initial request");
});

test("session creation", async () => {
    const { titles, calls } = fixture([{ ok: false, error: "session_not_found" }]);
    assert.equal((await titles.set(context, "Research notes")).synced, true);
    assert.equal(calls[1].method, "agents.sessions.setStatus");
    assert.equal(calls[1].initiator_user_id, "U1");
    assert.equal(calls[1].title, "Research notes");
});

test("title permissions", async () => {
    const { titles, data } = fixture([
        { ok: false, error: "not_authorized" }, { ok: false, error: "missing_scope" },
    ]);
    assert.equal((await titles.set(context, "Saved title")).synced, false);
    assert.equal(data.threads[context.key].title, "Saved title");
    assert.equal(data.threads[context.key].titleSynced, false);
});

test("Slack title edits", async () => {
    const { titles, data, calls } = fixture();
    const event = { channel: "C1", thread_ts: "100.001", user: "U1", title: "User title" };
    await titles.changed({ body: { team_id: "T1" }, event });
    await titles.ensure(context, "Another title");
    assert.equal(data.threads[context.key].title, "User title");
    assert.equal(calls.length, 0);
    await titles.changed({ body: { team_id: "T1" }, event: { ...event, user: "U2", title: "Wrong" } });
    assert.equal(data.threads[context.key].title, "User title");
});
