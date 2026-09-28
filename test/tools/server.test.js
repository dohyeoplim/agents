import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createToolServer } from "../../src/tools/server.js";

test("tool authorization", async (t) => {
    const data = { tasks: { task: { status: "running" } } };
    let now = 0;
    const bridge = createToolServer({
        now: () => now,
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
    now += 30 * 60000;
    assert.equal((await client.listTools()).tools[0].name, "test");
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
