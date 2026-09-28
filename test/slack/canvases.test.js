import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvases } from "../../src/slack/canvases.js";
import { PersistentState } from "../../src/shared/state.js";
import { createTools } from "../../src/tools/registry.js";
import { validateState } from "../../src/storage/records.js";
import { createToolServer } from "../../src/tools/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const context = { id: "task", team: "T1", channel: "C1", user: "U1" };
const input = { title: "확률론 복습", markdown: "# 조건부확률\n\n- [ ] 문제 풀기\n\n**복습**" };

async function setup(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "state.json");
    const state = await new PersistentState(file, { tasks: { task: { ...context, status: "running" } } }).load();
    const calls = [];
    const options = { token: "test-secret", state, workspaceUrl: "https://example.slack.com/",
        request: async (url, options) => {
            calls.push({ url, ...options, body: JSON.parse(options.body) });
            return { ok: true, json: async () => ({ ok: true, canvas_id: "F1234567" }) };
        } };
    return { file, state, calls, options, canvases: createCanvases(options) };
}

test("Canvas creation", async (t) => {
    const f = await setup(t);
    const tools = createTools({ canvases: f.canvases });
    const definition = tools.definitions.find((tool) => tool.name === "slack_canvas_create");
    assert.equal(definition.annotations.readOnlyHint, false);
    assert.equal(definition.annotations.idempotentHint, false);
    const result = await tools.call("slack_canvas_create", input, context);
    assert.equal(result.url, "https://example.slack.com/docs/T1/F1234567");
    assert.equal(result.channel, "C1");
    assert.deepEqual(f.calls[0].body, { title: input.title, channel_id: "C1",
        document_content: { type: "markdown", markdown: input.markdown } });
    assert.equal(f.calls[0].redirect, "error");
    assert.equal(f.calls[0].headers.Authorization, "Bearer test-secret");
    const reloaded = await new PersistentState(f.file, {}).load();
    validateState(reloaded.snapshot());
    assert.deepEqual(await createCanvases({ ...f.options, state: reloaded }).create(input, context), result);
    assert.equal(f.calls.length, 1);
});

test("concurrent requests", async (t) => {
    const f = await setup(t);
    const results = await Promise.allSettled([
        f.canvases.create(input, context), f.canvases.create(input, context),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(f.calls.length, 1);
});

test("creation authorization", async (t) => {
    const f = await setup(t);
    for (const args of [{ ...input, channel: "C2" }, { ...input, markdown: " " },
        { ...input, markdown: "a".repeat(20001) }]) {
        await assert.rejects(f.canvases.create(args, context));
    }
    for (const patch of [{ channel: "C2" }, { user: "U2" }, { team: "T2" }, { id: "missing" }]) {
        await assert.rejects(f.canvases.create(input, { ...context, ...patch }), /authorized/);
    }
    await f.state.update((draft) => { draft.tasks.task.status = "completed"; });
    await assert.rejects(f.canvases.create(input, context), /authorized/);
    assert.equal(f.calls.length, 0);
});

test("uncertain outcomes", async (t) => {
    const f = await setup(t);
    let calls = 0;
    const canvases = createCanvases({ ...f.options, request: async () => {
        calls++;
        throw Error("connection lost test-secret");
    } });
    await assert.rejects(canvases.create(input, context), /outcome is unknown/);
    const reloaded = await new PersistentState(f.file, {}).load();
    await assert.rejects(createCanvases({ ...f.options, state: reloaded }).create(input, context), /outcome is unknown/);
    assert.equal(calls, 1);
    assert.equal(f.calls.length, 0);
});

test("Slack rejections", async (t) => {
    const f = await setup(t);
    const canvases = createCanvases({ ...f.options, request: async () => ({ ok: true,
        json: async () => ({ ok: false, error: "missing_scope", detail: "test-secret" }),
    }) });
    await assert.rejects(canvases.create(input, context), /needs canvases:write/);
    assert.equal(Object.keys(f.state.snapshot().tasks.task.canvasCreations).length, 0);
    assert.equal((await f.canvases.create(input, context)).canvasId, "F1234567");
});

test("receipt failure", async (t) => {
    const f = await setup(t);
    let updates = 0;
    const canvases = createCanvases({ ...f.options, state: { update: (change) => {
        if (++updates === 2) throw Error("Database unavailable");
        return f.state.update(change);
    } } });
    const result = await canvases.create(input, context);
    assert.equal(result.canvasId, "F1234567");
    assert.match(result.warning, /Do not create it again/);
    await assert.rejects(f.canvases.create(input, context), /outcome is unknown/);
    assert.equal(f.calls.length, 1);
});

test("creation cancellation", async (t) => {
    const f = await setup(t);
    await assert.rejects(f.canvases.create(input, context, AbortSignal.abort()));
    const canvases = createCanvases({ ...f.options, state: {
        update: async () => { throw Error("Database unavailable"); },
    } });
    await assert.rejects(canvases.create(input, context), /Database unavailable/);
    assert.equal(f.calls.length, 0);
});

test("Canvas tool", async (t) => {
    const f = await setup(t);
    const bridge = createToolServer({ tools: createTools({ canvases: f.canvases }), state: f.state,
        personal: async () => ({ owner: "U1" }),
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: {} } }),
    });
    await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
    const client = new Client({ name: "canvas-test", version: "1" });
    t.after(async () => {
        await client.close();
        bridge.server.closeAllConnections();
        await new Promise((resolve) => bridge.server.close(resolve));
    });
    const grant = bridge.grant(context);
    const url = new URL(`http://127.0.0.1:${bridge.server.address().port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: "Bearer " + grant.token } },
    }));
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "slack_canvas_create"));
    const markdown = "확률론 복습\n".repeat(2000);
    assert.ok(Buffer.byteLength(markdown) > 32000);
    const result = await client.callTool({ name: "slack_canvas_create", arguments: { title: input.title, markdown } });
    assert.notEqual(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).canvasId, "F1234567");
    assert.equal(f.calls[0].body.document_content.markdown, markdown.trim());
    grant.revoke();
    await assert.rejects(client.callTool({ name: "slack_canvas_create", arguments: input }));
    assert.equal(f.calls.length, 1);
});
