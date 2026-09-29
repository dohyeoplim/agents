import test from "node:test";
import assert from "node:assert/strict";
import { createMessageHandler, createMessageSender } from "../../src/slack/messages.js";
import { loadProfiles } from "../../src/agents/profiles.js";
import { loadSkills } from "../../src/agents/skills.js";

function fixture({ beforeCommit = () => {}, postReply = () => {}, research, cancelThread, titles, resources } = {}) {
    const data = { events: {}, threads: {}, entries: {}, tasks: {}, schedules: {} };
    const jobs = [];
    const replies = [];
    const current = {
        team: "T1", users: ["U1"],
        channels: { C1: { agent: "assistant", name: "inbox", cwd: "inbox" } },
    };
    const handler = createMessageHandler({
        state: {
            snapshot: () => structuredClone(data),
            update: async (change) => {
                const draft = structuredClone(data);
                const result = change(draft);
                beforeCommit(draft, data);
                Object.assign(data, draft);
                return structuredClone(result);
            },
        },
        research,
        titles,
        resources,
        runtime: { pumping: false, cancelThread: cancelThread || (async () => []), wake: () => {
            for (const task of Object.values(data.tasks)) {
                if (!jobs.some((job) => job.id === task.id)) jobs.push(task);
            }
        } },
        bot: "BOT",
        post: async (context, text) => { postReply(context, text); replies.push({ context, text }); },
        config: async () => structuredClone(current),
        profiles: () => loadProfiles(new URL("../../config/profiles.json", import.meta.url)),
        skills: () => loadSkills(new URL("../../config/skills.json", import.meta.url)),
    });
    const send = (text, extra = {}) => handler.handle({
        body: { team_id: "T1" },
        event: { channel: "C1", user: "U1", ts: "100.001", text, ...extra },
    });
    return { data, jobs, replies, send, handler, current };
}

const revokedRoutes = {
    team: (current) => { current.team = "T2"; },
    user: (current) => { current.users = []; },
    channel: (current) => { delete current.channels.C1; },
    disabled: (current) => { current.channels.C1.enabled = false; },
    profile: (current) => { current.channels.C1.profile = "scholar"; },
    agent: (current) => { current.channels.C1.agent = "replacement"; },
};

test("pending request authorization", async (test) => {
    for (const [name, revoke] of Object.entries(revokedRoutes)) {
        await test.test(name, async () => {
            let unavailable = true;
            const { data, jobs, replies, send, handler, current } = fixture({ beforeCommit: (draft) => {
                if (unavailable && Object.keys(draft.tasks).length) throw Error("Storage unavailable");
            } });
            await assert.rejects(send("<@BOT> hello"), /Storage unavailable/);
            unavailable = false;
            revoke(current);
            await handler.recover();
            assert.equal(data.inbox["C1:100.001"].status, "rejected");
            assert.equal(jobs.length, 0);
            assert.equal(replies.length, 0);
        });
    }
});

test("pending response authorization", async (test) => {
    for (const [name, revoke] of Object.entries(revokedRoutes)) {
        await test.test(name, async () => {
            let unavailable = true;
            const { data, replies, send, handler, current } = fixture({ beforeCommit: (draft) => {
                if (unavailable && draft.inbox?.["C1:100.001"]?.delivery === "sending") {
                    throw Error("Storage unavailable");
                }
            } });
            await assert.rejects(send("<@BOT> !help"), /Storage unavailable/);
            assert.equal(data.inbox["C1:100.001"].delivery, "pending");
            unavailable = false;
            revoke(current);
            await handler.recover();
            assert.equal(data.inbox["C1:100.001"].delivery, "suppressed");
            assert.equal(replies.length, 0);
        });
    }
});

test("message recovery", async () => {
    let unavailable = true;
    const { data, jobs, send, handler } = fixture({ beforeCommit: (draft) => {
        if (unavailable && Object.keys(draft.tasks).length) throw Error("Storage unavailable");
    } });
    await assert.rejects(send("<@BOT> hello"), /Storage unavailable/);
    assert.equal(data.inbox["C1:100.001"].status, "pending");
    assert.equal(data.inbox["C1:100.001"].text, "<@BOT> hello");
    assert.equal(data.events["C1:100.001"], undefined);
    assert.equal(Object.keys(data.tasks).length, 0);
    unavailable = false;
    await handler.recover();
    await send("<@BOT> hello");
    assert.equal(jobs.length, 1);
    assert.equal(data.inbox["C1:100.001"].taskId, jobs[0].id);
    assert.equal(data.inbox["C1:100.001"].status, "processed");
    assert.ok(data.events["C1:100.001"]);
});

test("interrupted commands", async () => {
    let unavailable = true;
    const { data, send, handler, replies } = fixture({ beforeCommit: (draft) => {
        if (unavailable && draft.inbox?.["C1:100.001"]?.status === "processed") {
            throw Error("Storage unavailable");
        }
    } });
    await assert.rejects(send("<@BOT> !remember shared Keep answers short"), /Storage unavailable/);
    assert.equal(Object.keys(data.entries).length, 1);
    assert.equal(data.inbox["C1:100.001"].status, "processing");
    unavailable = false;
    await handler.recover();
    await send("<@BOT> !remember shared Keep answers short");
    assert.equal(Object.keys(data.entries).length, 1);
    assert.equal(data.inbox["C1:100.001"].status, "uncertain");
    assert.match(replies[0].text, /Check its result/);
});

test("command redelivery", async () => {
    const { data, send, handler } = fixture({ postReply: () => { throw Error("Slack unavailable"); } });
    await send("<@BOT> !remember shared Keep answers short");
    await handler.recover();
    assert.equal(Object.keys(data.entries).length, 1);
    assert.equal(data.inbox["C1:100.001"].status, "processed");
    assert.equal(data.inbox["C1:100.001"].delivery, "uncertain");
    assert.match(data.inbox["C1:100.001"].response, /Saved memory/);
});

test("message deduplication", async () => {
    const { jobs, send } = fixture();
    await Promise.all([send("<@BOT> hello"), send("<@BOT> hello")]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].prompt, "hello");
    assert.equal(jobs[0].messageTs, "100.001");
    await send("follow up", { ts: "100.002", thread_ts: "100.001" });
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].key, jobs[1].key);
    assert.equal(jobs[1].messageTs, "100.002");
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
    assert.deepEqual(jobs[1].fileIds, []);
});

test("sender names", async () => {
    const sent = [];
    const profiles = () => loadProfiles(new URL("../../config/profiles.json", import.meta.url));
    const post = createMessageSender({ chat: { postMessage: async (message) => sent.push(message) } }, profiles);
    for (const profile of ["assistant", "scholar", "engineer"]) {
        await post({ channel: "C1", thread: "100.001", profile }, "Answer");
    }
    assert.deepEqual(sent.map((message) => message.username), ["Assistant", "Scholar", "Engineer"]);
    assert.ok(sent.every((message) => message.markdown_text === "Answer" && !message.icon_emoji && !message.icon_url));
});

test("sender permissions", async () => {
    const sent = [];
    const post = createMessageSender({ chat: { postMessage: async (message) => {
        sent.push(message);
        if (message.username) throw Object.assign(Error("Missing scope"), { data: { error: "missing_scope" } });
    } } }, async () => ({ scholar: { name: "Scholar" } }));
    await post({ channel: "C1", thread: "100.001", profile: "scholar" }, "Answer");
    assert.equal(sent.length, 2);
    assert.equal(sent[1].username, undefined);
    assert.equal(sent[1].markdown_text, "Answer");
});


test("combined stop", async () => {
    const operations = [];
    const { send, data } = fixture({
        cancelThread: async (context) => {
            operations.push(["cancel", context.thread]);
            return ["task"];
        },
        research: { handle: async (context) => {
            operations.push(["pause", context.thread]);
            return true;
        } },
    });
    await send("<@BOT> !stop");
    assert.deepEqual(operations, [["cancel", "100.001"], ["pause", "100.001"]]);
    assert.equal(data.inbox["C1:100.001"].status, "processed");
});

test("ordinary stop", async () => {
    let cancellations = 0;
    const { send, replies } = fixture({ cancelThread: async () => {
        cancellations++;
        return ["12345678-1234-1234-1234-123456789abc"];
    } });
    await send("<@BOT> !stop");
    assert.equal(cancellations, 1);
    assert.match(replies[0].text, /Cancellation requested: 12345678/);
});

test("channel isolation", { timeout: 2000 }, async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const { send, current, data } = fixture({ titles: { ensure: async () => {
        entered.resolve();
        await release.promise;
    } }, cancelThread: async () => ["12345678"] });
    current.channels.C2 = { ...current.channels.C1 };
    const first = send("<@BOT> work");
    try {
        await entered.promise;
        await send("<@BOT> !stop", { channel: "C2", ts: "100.002" });
        assert.equal(data.inbox["C2:100.002"].status, "processed");
    } finally {
        release.resolve();
        await first;
    }
});

test("priority cancellation", { timeout: 2000 }, async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const { send, data, jobs, replies, handler } = fixture({ resources: { catalog: async () => {
        entered.resolve();
        await release.promise;
        return { items: [], folders: [], notices: [] };
    } } });
    const first = send("<@BOT> !sources");
    let queued;
    try {
        await entered.promise;
        queued = send("start research", { thread_ts: "100.001", ts: "100.002" });
        await send("!stop", { thread_ts: "100.001", ts: "100.003" });
        assert.equal(data.inbox["C1:100.002"].status, "cancelled");
        assert.equal(data.inbox["C1:100.003"].status, "processed");
        assert.match(replies[0].text, /Pending requests cancelled/);
    } finally {
        release.resolve();
        await Promise.all([first, queued]);
    }
    await handler.recover();
    assert.equal(jobs.length, 0);
});

test("thread ordering", { timeout: 2000 }, async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const { send, jobs, handler } = fixture({ resources: { catalog: async () => {
        entered.resolve();
        await release.promise;
        return { items: [], folders: [], notices: [] };
    } } });
    const first = send("<@BOT> !sources");
    await entered.promise;
    const second = send("follow up", { thread_ts: "100.001", ts: "100.002" });
    await send("<@BOT> separate thread", { ts: "100.003" });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].prompt, "separate thread");
    release.resolve();
    await Promise.all([first, second, handler.idle()]);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].prompt, "follow up");
});
