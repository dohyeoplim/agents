import test from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../../src/tools/registry.js";

const id = "05d1b22a-cf4f-484f-8d22-60a44e9932f7";

test("short remote command", async () => {
    const calls = [];
    const tools = createTools({ remote: { run: (...args) => { calls.push(args); return { id }; } } });
    assert.deepEqual(await tools.call("remote_exec", { id, command: "nvidia-smi", timeoutSeconds: 30 }, {}), { id });
    assert.equal(calls[0][1].timeoutSeconds, 30);
    assert.equal(calls[0][1].cwd, "/workspace");
    const definition = tools.definitions.find((tool) => tool.name === "remote_exec");
    assert.equal(definition.inputSchema.properties.timeoutSeconds.minimum, 1);
    await tools.call("remote_exec", { id, command: "true", timeoutSeconds: 1 }, {});
});

test("actionable argument errors", async () => {
    let calls = 0;
    const tools = createTools({ remote: { run: () => { calls++; } } });
    await assert.rejects(tools.call("remote_exec", { id, command: "true", timeoutSeconds: 0 }, {}),
        /timeoutSeconds: must be at least 1/);
    await assert.rejects(tools.call("remote_exec", { id: "not-a-uuid", command: "true" }, {}),
        /id: must be a valid UUID/);
    await assert.rejects(tools.call("remote_exec", { command: "true" }, {}), /id: expected string/);
    await assert.rejects(tools.call("remote_exec", { id, command: "true", timeoutSeconds: 900000 }, {}),
        /timeoutSeconds: must be at most 604800/);
    await assert.rejects(tools.call("remote_exec", { id, command: "true", "secret-token": "private" }, {}),
        (error) => !error.message.includes("secret-token") && !error.message.includes("private") &&
            error.message.includes("nothing was executed"));
    assert.equal(calls, 0);
});
