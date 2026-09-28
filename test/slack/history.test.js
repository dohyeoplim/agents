import test from "node:test";
import assert from "node:assert/strict";
import { createSlackHistory } from "../../src/slack/history.js";
import { createTools } from "../../src/tools/registry.js";

const context = { id: "task", team: "T1", channel: "C1", user: "U1" };
const ts = (value) => `18000000${String(value).padStart(2, "0")}.000001`;
const item = (value, text = `Message ${value}`, extra = {}) => ({ ts: ts(value), text, user: "U2", ...extra });

function setup(pages) {
    const calls = [];
    const history = createSlackHistory({ token: "test-token", workspaceUrl: "https://example.slack.com/",
        request: async (url, options) => {
            calls.push({ url: new URL(url), options });
            options.signal.throwIfAborted();
            const page = pages.shift();
            assert.ok(page, "Unexpected Slack request");
            return page instanceof Response ? page : Response.json({ ok: true, ...page });
        } });
    return { history, calls, tools: createTools({ history }) };
}

test("history validation", async () => {
    const f = setup([{ messages: [item(1)] }]);
    for (const [name, args] of [
        ["slack_messages_read", { channel: "C2" }],
        ["slack_messages_read", { oldest: ts(2), latest: ts(1) }],
        ["slack_messages_read", { limit: 31 }],
        ["slack_messages_read", { thread: "invalid" }],
        ["slack_messages_search", { query: "  " }],
        ["slack_message_read", { ts: ts(1), offset: 6000 }],
    ]) await assert.rejects(f.tools.call(name, args, context), /Invalid tool arguments/);
    assert.equal(f.calls.length, 0);
    const result = await f.tools.call("slack_messages_read", {}, context);
    assert.equal(result.channel, "C1");
    assert.equal(f.calls[0].url.searchParams.get("channel"), "C1");
    assert.equal(f.calls[0].url.pathname, "/api/conversations.history");
    assert.equal(f.calls[0].options.headers.Authorization, "Bearer test-token");
    assert.equal(f.calls[0].options.redirect, "error");
    for (const definition of f.tools.definitions.filter((entry) => entry.name.startsWith("slack_message"))) {
        assert.equal(definition.annotations.readOnlyHint, true);
        assert.equal(definition.annotations.destructiveHint, false);
    }
});

test("cursor pagination", async () => {
    const f = setup([{ messages: [item(5), item(4)], response_metadata: { next_cursor: "page-two" } },
        { messages: [item(3)] }]);
    const first = await f.history.read({ oldest: ts(1), latest: ts(6), limit: 2 }, context);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.next, { oldest: ts(1), latest: ts(6), limit: 2, cursor: "page-two" });
    const second = await f.history.read(first.next, context);
    assert.equal(f.calls[1].url.searchParams.get("cursor"), "page-two");
    assert.equal(second.messages[0].ts, ts(3));
    assert.equal(second.hasMore, false);
    assert.equal(second.next, null);
});

test("timestamp pagination", async () => {
    const f = setup([{ messages: [item(5), item(4)], has_more: true },
        { messages: [item(2), item(3)], has_more: true }]);
    const channel = await f.history.read({ oldest: ts(1), latest: ts(6) }, context);
    assert.equal(channel.next.latest, ts(4));
    assert.equal(channel.next.oldest, ts(1));
    const thread = await f.history.read({ thread: ts(1), oldest: ts(1), latest: ts(6) }, context);
    assert.equal(thread.next.oldest, ts(3));
    assert.equal(thread.next.latest, ts(6));
    assert.equal(thread.next.thread, ts(1));
    assert.equal(f.calls[1].url.pathname, "/api/conversations.replies");
    assert.equal(f.calls[1].url.searchParams.get("ts"), ts(1));
});

test("message filtering", async () => {
    const f = setup([{ messages: [item(1), item(2), item(3, "deleted", { subtype: "message_deleted" }),
        item(4), item(5)] }]);
    const result = await f.history.read({ oldest: ts(1), latest: ts(4) }, context);
    assert.deepEqual(result.messages.map((entry) => entry.ts), [ts(2)]);
    assert.equal(result.scanned, 1);
    assert.equal(f.calls[0].url.searchParams.get("inclusive"), "false");
});

test("empty search pages", async () => {
    const f = setup([{ messages: [item(4, "Unrelated discussion")], has_more: true,
        response_metadata: { next_cursor: "older" } }, { messages: [item(2, "Bayes THEOREM exercise")] }]);
    const first = await f.history.search({ query: "theorem", oldest: ts(1), latest: ts(5) }, context);
    assert.deepEqual(first.messages, []);
    assert.equal(first.scanned, 1);
    assert.equal(first.next.query, "theorem");
    assert.equal(first.next.oldest, ts(1));
    assert.equal(first.next.latest, ts(5));
    const second = await f.history.search(first.next, context);
    assert.equal(second.messages[0].ts, ts(2));
    assert.match(second.coverage, /replies.*not fully searched/i);
    assert.match(second.match, /literal/i);
});

test("thread search", async () => {
    const f = setup([{ messages: [item(1, "Root"), item(2, "Solve a+b", { thread_ts: ts(1) }),
        item(3, "Solve aaab", { thread_ts: ts(1) })] }]);
    const result = await f.history.search({ query: "A+B", thread: ts(1) }, context);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].threadTs, ts(1));
    const url = new URL(result.messages[0].url);
    assert.equal(url.pathname, `/archives/C1/p${ts(2).replace(".", "")}`);
    assert.equal(url.searchParams.get("thread_ts"), ts(1));
    assert.match(result.coverage, /this thread only/);
});

test("missing continuation", async () => {
    const f = setup([{ messages: [], has_more: true }]);
    const result = await f.history.read({}, context);
    assert.equal(result.hasMore, true);
    assert.equal(result.next, null);
    assert.match(result.notice, /without a continuation/);
});

test("message chunks", async () => {
    const text = "Study ".repeat(2200);
    const f = setup(Array.from({ length: 4 }, () => ({ messages: [item(2, text, { thread_ts: ts(1) })] })));
    const page = await f.history.read({ thread: ts(1) }, context);
    assert.equal(page.messages[0].text.length, 1500);
    assert.equal(page.messages[0].truncated, true);
    assert.equal(page.messages[0].textLength, text.length);
    const first = await f.history.message({ ts: ts(2), thread: ts(1) }, context);
    const second = await f.history.message({ ts: ts(2), thread: ts(1), offset: first.nextOffset,
        revision: first.revision }, context);
    const third = await f.history.message({ ts: ts(2), thread: ts(1), offset: second.nextOffset,
        revision: second.revision }, context);
    assert.equal(first.text + second.text + third.text, text);
    assert.equal(third.offset, 12000);
    assert.equal(third.nextOffset, null);
    assert.equal(f.calls[1].url.searchParams.get("inclusive"), "true");
    assert.equal(f.calls[1].url.searchParams.get("oldest"), ts(2));
    assert.equal(f.calls[1].url.searchParams.get("latest"), ts(2));
});

test("stale continuation", async () => {
    const f = setup([{ messages: [item(2, "a".repeat(7000))] },
        { messages: [item(2, "b".repeat(7000), { edited: { ts: ts(3) } })] }]);
    const first = await f.history.message({ ts: ts(2) }, context);
    await assert.rejects(f.history.message({ ts: ts(2), offset: first.nextOffset,
        revision: first.revision }, context), /Message changed/);
});

test("unmarked revisions", async () => {
    const f = setup([{ messages: [item(2, "a".repeat(7000))] },
        { messages: [item(2, "b".repeat(7000))] }]);
    const first = await f.history.message({ ts: ts(2) }, context);
    await assert.rejects(f.history.message({ ts: ts(2), offset: first.nextOffset,
        revision: first.revision }, context), /Message changed/);
});

test("search snippets", async () => {
    const text = "x".repeat(5000) + "Bayes theorem";
    const f = setup([{ messages: [item(2, text)] }]);
    const result = await f.history.search({ query: "bayes" }, context);
    assert.match(result.messages[0].text, /Bayes theorem/);
    assert.ok(result.messages[0].offset > 0);
    assert.equal(result.messages[0].truncated, true);
    assert.equal(result.messages[0].textLength, text.length);
});

test("repeated cursors", async () => {
    const f = setup([{ messages: [item(4)], has_more: true, response_metadata: { next_cursor: "stuck" } },
        { messages: [item(4)], has_more: true }]);
    const first = await f.history.read({ cursor: "stuck", latest: ts(5) }, context);
    assert.equal(first.next.cursor, undefined);
    assert.equal(first.next.latest, ts(4));
    const second = await f.history.read(first.next, context);
    assert.equal(second.next, null);
    assert.match(second.notice, /without a continuation/);
});

test("timestamp precision", async () => {
    const oldest = "1000000000000000.000001";
    const middle = "1000000000000000.000002";
    const latest = "1000000000000000.000003";
    const f = setup([{ messages: [{ ts: oldest, text: "old" }, { ts: middle, text: "middle" },
        { ts: latest, text: "new" }] }]);
    const result = await f.history.read({ oldest, latest }, context);
    assert.deepEqual(result.messages.map((entry) => entry.ts), [middle]);
});

test("missing messages", async () => {
    const f = setup([{ messages: [item(3)] }, { messages: [item(2, "gone", { subtype: "message_deleted" })] }]);
    await assert.rejects(f.history.message({ ts: ts(2) }, context), /unavailable/);
    await assert.rejects(f.history.message({ ts: ts(2) }, context), /unavailable/);
});

test("file references", async () => {
    const f = setup([{ messages: [item(2, "", { files: [{ id: "F1", title: "Course notes" }] })] }]);
    const result = await f.history.read({}, context);
    assert.deepEqual(result.messages[0].files, [{ id: "F1", title: "Course notes" }]);
    assert.match(result.messages[0].notice, /contents.*not been read/);
});

test("Slack errors", async () => {
    for (const [error, expected] of [["missing_scope", /Reinstall/], ["not_in_channel", /join this channel/],
        ["not_allowed_token_type", /token type/], ["invalid_cursor", /expired/]]) {
        const f = setup([Response.json({ ok: false, error })]);
        await assert.rejects(f.history.read({}, context), expected);
    }
});

test("rate limits", async () => {
    const f = setup([new Response("limited", { status: 429, headers: { "retry-after": "60" } })]);
    await assert.rejects(f.history.read({}, context), /rate limited/);
    await assert.rejects(f.history.search({ query: "test" }, context), /rate limited/);
    assert.equal(f.calls.length, 1);
});

test("invalid responses", async () => {
    for (const page of [Response.json({ ok: true }), Response.json({ ok: true, messages: [{ ts: "bad" }] }),
        new Response("unavailable", { status: 503 }), Response.json(null)]) {
        const f = setup([page]);
        await assert.rejects(f.history.search({ query: "test" }, context));
    }
});

test("history cancellation", async () => {
    const f = setup([{ messages: [] }]);
    const signal = AbortSignal.abort(new Error("Task cancelled"));
    await assert.rejects(f.tools.call("slack_messages_read", {}, context, signal), /Task cancelled/);
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.history.read({}, context, signal), /Task cancelled/);
});
