import test from "node:test";
import assert from "node:assert/strict";
import { createMessageHandler, createMessageSender } from "../../src/slack/messages.js";
import { loadProfiles } from "../../src/agents/profiles.js";
import { loadSkills } from "../../src/agents/skills.js";

function fixture() {
    const data = { events: {}, threads: {}, entries: {}, tasks: {}, schedules: {} };
    const jobs = [];
    const replies = [];
    const handler = createMessageHandler({
        state: { snapshot: () => structuredClone(data), update: async (change) => change(data) },
        runtime: { pumping: false, enqueue: async (task) => { jobs.push(task); return "task-id"; } },
        bot: "BOT",
        post: async (context, text) => replies.push({ context, text }),
        config: async () => ({
            team: "T1", users: ["U1"],
            channels: { C1: { agent: "assistant", name: "inbox", cwd: "inbox" } },
        }),
        profiles: () => loadProfiles(new URL("../../config/profiles.json", import.meta.url)),
        skills: () => loadSkills(new URL("../../config/skills.json", import.meta.url)),
    });
    const send = (text, extra = {}) => handler.handle({
        body: { team_id: "T1" },
        event: { channel: "C1", user: "U1", ts: "100.001", text, ...extra },
    });
    return { data, jobs, replies, send };
}

test("message deduplication", async () => {
    const { jobs, send } = fixture();
    await Promise.all([send("<@BOT> hello"), send("<@BOT> hello")]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].prompt, "hello");
    await send("follow up", { ts: "100.002", thread_ts: "100.001" });
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].key, jobs[1].key);
});

test("command dispatch", async () => {
    const { data, jobs, replies, send } = fixture();
    await send("<@BOT> !remember shared Use short answers");
    assert.equal(Object.keys(data.entries).length, 1);
    await send("!help", { ts: "100.002", thread_ts: "100.001" });
    assert.ok(replies[1].text.includes("!schedule"));
    await send("!profile", { ts: "100.003", thread_ts: "100.001" });
    assert.ok(replies[2].text.includes("Current profile: assistant"));
    assert.equal(jobs.length, 0);
});

test("message delivery", async () => {
    const sent = [];
    const post = createMessageSender({ chat: { postMessage: async (message) => sent.push(message) } });
    await post({ channel: "C1", thread: "100.001" }, "a".repeat(12000) + " xoxb-test-placeholder");
    assert.equal(sent.length, 2);
    assert.ok(sent[1].markdown_text.endsWith("[REDACTED]"));
    assert.ok(sent.every((message) => message.thread_ts === "100.001" && message.text === undefined));
});

test("thread attachments", async () => {
    const { jobs, send } = fixture();
    await send("<@BOT> Review this", { subtype: "file_share", files: [{ id: "F123456" }] });
    assert.deepEqual(jobs[0].fileIds, ["F123456"]);
    await send("Explain more", { ts: "100.002", thread_ts: "100.001" });
    assert.deepEqual(jobs[1].fileIds, ["F123456"]);
});
