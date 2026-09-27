import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexArgs, runCodex } from "../../src/agents/codex.js";

test("sandbox arguments", () => {
    const args = codexArgs("12345678-1234-1234-1234-123456789abc");
    assert.deepEqual(args.slice(-3), [
        "resume",
        "12345678-1234-1234-1234-123456789abc",
        "-",
    ]);
    assert.ok(args.includes('sandbox_mode="workspace-write"'));
    assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("Codex execution", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const exe = path.join(dir, "fake-codex");
    await writeFile(
        exe,
        `#!/usr/bin/env node
let input = "";

process.stdin.on("data", (chunk) => {
    input += chunk;
});

process.stdin.on("end", () => {
    if (input === "timeout") {
        setTimeout(() => {}, 10000);
        return;
    }

    if (input === "fail") {
        process.stdout.write(JSON.stringify({ type: "turn.failed" }) + "\\n");
        process.exitCode = 1;
        return;
    }

    for (const event of [
        {
            type: "thread.started",
            thread_id: "12345678-1234-1234-1234-123456789abc",
        },
        {
            type: "item.completed",
            item: { type: "agent_message", text: input },
        },
        { type: "turn.completed" },
    ]) {
        process.stdout.write(JSON.stringify(event) + "\\n");
    }
});`,
    );
    await chmod(exe, 0o755);
    const result = await runCodex({
        cwd: dir,
        prompt: "$(touch bad) hello",
        executable: exe,
    });
    assert.equal(result.answer, "$(touch bad) hello");
    await assert.rejects(
        runCodex({ cwd: dir, prompt: "fail", executable: exe }),
    );
    await assert.rejects(
        runCodex({
            cwd: dir,
            prompt: "timeout",
            executable: exe,
            timeout: 100,
        }),
    );
    const controller = new AbortController();
    const cancelled = runCodex({
        cwd: dir,
        prompt: "timeout",
        executable: exe,
        signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(cancelled);
});
