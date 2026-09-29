import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createToolServer } from "../../src/tools/server.js";

test("gateway readiness", async (t) => {
    let ready = true;
    const bridge = createToolServer({ healthy: async () => ready });
    await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        bridge.server.closeAllConnections();
        await new Promise((resolve) => bridge.server.close(resolve));
    });
    const url = `http://127.0.0.1:${bridge.server.address().port}/health`;
    assert.equal((await fetch(url)).status, 200);
    ready = false;
    assert.equal((await fetch(url)).status, 503);
    assert.equal((await fetch(url, { method: "POST" })).status, 404);
});

test("tool authorization", async (t) => {
    const data = { tasks: { task: { status: "running" } } };
    const bridge = createToolServer({
        state: { snapshot: () => data }, personal: async () => ({ owner: "U1" }),
        config: async () => ({ team: "T1", users: ["U1", "U2"], channels: { C1: {} } }),
        tools: { definitions: [{ name: "test", description: "Test", inputSchema: { type: "object" } }],
            call: async () => ({ value: "ok" }) },
    });
    await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        bridge.server.closeAllConnections();
        await new Promise((resolve) => bridge.server.close(resolve));
    });
    const url = new URL(`http://127.0.0.1:${bridge.server.address().port}/mcp`);
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    const grant = bridge.grant({ id: "task", team: "T1", user: "U1", channel: "C1" });
    const client = new Client({ name: "test", version: "1" });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: "Bearer " + grant.token } },
    }));
    assert.equal((await client.listTools()).tools[0].name, "test");
    assert.equal(JSON.parse((await client.callTool({ name: "test", arguments: {} })).content[0].text).value, "ok");
    data.tasks.task.status = "completed";
    await assert.rejects(client.listTools());
    grant.revoke();
    const revoked = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + grant.token } });
    assert.equal(revoked.status, 401);
    const other = bridge.grant({ id: "task", team: "T1", user: "U2", channel: "C1" });
    data.tasks.task.status = "running";
    const forbidden = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + other.token } });
    assert.equal(forbidden.status, 403);
});

test("research grants", async (t) => {
    const task = { id: "task", team: "T1", user: "U1", channel: "C1", researchId: "job",
        researchRunId: "run", researchStage: "explore" };
    const data = { tasks: { task: { status: "running" } }, researchJobs: {
        job: { team: "T1", user: "U1", channel: "C1", runId: "run", status: "running" },
    } };
    let calls = 0;
    const bridge = createToolServer({ state: { snapshot: () => data }, personal: async () => null,
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: {} } }),
        tools: { definitions: ["research_source_save", "slack_canvas_create"].map((name) =>
            ({ name, description: name, inputSchema: { type: "object" } })),
        call: async () => ({ calls: ++calls }) },
    });
    await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        bridge.server.closeAllConnections();
        await new Promise((resolve) => bridge.server.close(resolve));
    });
    const url = new URL(`http://127.0.0.1:${bridge.server.address().port}/mcp`);
    const grant = bridge.grant(task);
    const client = new Client({ name: "test", version: "1" });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: "Bearer " + grant.token } },
    }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["research_source_save"]);
    assert.equal((await client.callTool({ name: "slack_canvas_create", arguments: {} })).isError, true);
    assert.equal(calls, 0);
    for (let index = 0; index < 85; index++) {
        assert.notEqual((await client.callTool({ name: "research_source_save", arguments: {} })).isError, true);
    }
    assert.equal(calls, 85);
    data.researchJobs.job.runId = "replacement";
    await assert.rejects(client.listTools());
});

test("control grants", async (t) => {
    const owner = { id: "task", team: "T1", user: "U1", channel: "C1" };
    const data = { tasks: { task: { status: "running" } }, researchJobs: {
        job: { ...owner, runId: "run", status: "running" },
    } };
    const names = ["research_status", "research_propose", "research_control", "research_result",
        "research_source_save", "research_report_read", "autoresearch_status", "autoresearch_propose",
        "autoresearch_control", "autoresearch_manifest"];
    const bridge = createToolServer({ state: { snapshot: () => data }, personal: async () => null,
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: {} } }),
        tools: { definitions: names.map((name) => ({ name, inputSchema: { type: "object" } })),
            call: async () => ({ accepted: true }) },
    });
    await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        bridge.server.closeAllConnections();
        await new Promise((resolve) => bridge.server.close(resolve));
    });
    const url = new URL(`http://127.0.0.1:${bridge.server.address().port}/mcp`);
    const research = { researchId: "job", researchRunId: "run", researchStage: "clarify" };
    for (const [extra, allowed] of [[{}, [...names.slice(0, 4), ...names.slice(6)]], [{ scheduleId: "schedule" }, []],
        [{ briefingDate: "2026-09-29" }, []],
        [research, ["research_report_read"]]]) {
        const grant = bridge.grant({ ...owner, ...extra });
        const client = new Client({ name: "test", version: "1" });
        try {
            await client.connect(new StreamableHTTPClientTransport(url, {
                requestInit: { headers: { Authorization: "Bearer " + grant.token } },
            }));
            assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), allowed);
            const result = await client.callTool({ name: "research_control", arguments: {} });
            assert.equal(result.isError === true, !allowed.includes("research_control"));
            const auto = await client.callTool({ name: "autoresearch_control", arguments: {} });
            assert.equal(auto.isError === true, !allowed.includes("autoresearch_control"));
        } finally {
            await client.close();
            grant.revoke();
        }
    }
});
