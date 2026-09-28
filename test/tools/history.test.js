import test from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../../src/tools/registry.js";

test("history tool validation", async () => {
    const calls = [];
    const history = Object.fromEntries(["read", "search", "message"].map((method) => [method,
        async (...args) => { calls.push({ method, args }); return { messages: [] }; }]));
    const tools = createTools({ history });
    const context = { id: "task", team: "T1", channel: "C1", user: "U1" };
    const signal = new AbortController().signal;
    const definitions = tools.definitions.filter((tool) => tool.name.startsWith("slack_message"));
    assert.equal(definitions.length, 3);
    assert.ok(definitions.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
    await tools.call("slack_messages_read", {}, context, signal);
    await tools.call("slack_messages_search", { query: "coursework" }, context, signal);
    await tools.call("slack_message_read", { ts: "1700000000.000001" }, context, signal);
    assert.deepEqual(calls.map((call) => call.method), ["read", "search", "message"]);
    assert.ok(calls.every((call) => call.args[1] === context && call.args[2] === signal));
    await assert.rejects(tools.call("slack_messages_read", { channel: "C2" }, context), /Invalid tool arguments/);
    await assert.rejects(tools.call("slack_messages_search", { query: "" }, context), /Invalid tool arguments/);
    await assert.rejects(tools.call("slack_messages_read", { oldest: "bad", latest: "1700000000.000001" }, context),
        /Invalid tool arguments/);
    await assert.rejects(tools.call("slack_message_read", { ts: "1700000000.000001", offset: 6000 }, context),
        /Invalid tool arguments/);
    assert.equal(calls.length, 3);
});
