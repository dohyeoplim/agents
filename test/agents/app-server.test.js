import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAppServer, threadOptions } from "../../src/agents/app-server.js";

test("thread policy", () => {
    const options = threadOptions("/workspace/inbox");
    assert.equal(options.approvalPolicy, "never");
    assert.equal(options.sandbox, "workspace-write");
    assert.equal(options.config["sandbox_workspace_write.network_access"], false);
    assert.equal(options.config["shell_environment_policy.inherit"], "none");
});

test("app server", async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "app-server-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const executable = path.join(home, "codex");
    await writeFile(executable, `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const threadId = "12345678-1234-1234-1234-123456789abc";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method.startsWith("thread/")) {
        const personal = request.params.config["mcp_servers.personal"];
        if (process.env.PERSONAL_TOOLS_TOKEN && personal.default_tools_approval_mode !== "approve") process.exit(1);
        send({ id: request.id, result: { thread: { id: threadId } } });
        return;
    }
    send({ id: request.id, result: {} });
    if (request.method !== "turn/start") return;
    const prompt = request.params.input[0].text;
    if (prompt === "wait") return;
    const notify = (method, params) => send({ method, params: { threadId, ...params } });
    notify("item/started", { item: { id: "private", type: "reasoning" } });
    notify("item/reasoning/textDelta", { itemId: "private", delta: "hidden" });
    notify("item/started", { item: { id: "answer", type: "agentMessage", phase: "final_answer" } });
    const text = request.params.input.length === 2 ? "Image received" : "Hello world";
    for (const delta of [text.slice(0, 5), text.slice(5)]) {
        notify("item/agentMessage/delta", { itemId: "answer", delta });
    }
    notify("item/completed", { item: { id: "answer", type: "agentMessage", phase: "final_answer", text } });
    notify("turn/completed", { turn: { status: prompt === "fail" ? "failed" : "completed" } });
});
`, { mode: 0o755 });
    const updates = [];
    const options = { home, cwd: home, executable, timeout: 2000 };
    const first = await runAppServer({ ...options, prompt: "hello", onText: (text) => updates.push(text) });
    assert.deepEqual(updates, ["Hello", "Hello world", "Hello world"]);
    const resumed = await runAppServer({ ...options, session: first.session, prompt: "image", images: ["data:test"],
        toolToken: "t".repeat(43) });
    assert.equal(resumed.answer, "Image received");
    await assert.rejects(runAppServer({ ...options, prompt: "fail" }));
    await assert.rejects(runAppServer({ ...options, prompt: "wait", timeout: 100 }));
    const controller = new AbortController();
    const running = runAppServer({ ...options, prompt: "wait", signal: controller.signal });
    controller.abort();
    await assert.rejects(running);
});
