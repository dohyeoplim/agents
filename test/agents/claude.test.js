import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { claudeArguments, runClaude } from "../../src/agents/claude.js";

function processStub() {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
}

test("Claude permits search and explicit research tools without embedding bearer credentials", () => {
    const args = claudeArguments("secret-token");
    assert.ok(args.includes("--restricted"));
    assert.ok(args.includes("dontAsk"));
    assert.equal(args[args.indexOf("--tools") + 1], "WebSearch,WebFetch,Read,Glob,Grep");
    const allowed = args[args.indexOf("--allowedTools") + 1];
    assert.ok(allowed.includes("mcp__personal__research_source_save"));
    assert.ok(!allowed.includes("canvas_update"));
    assert.ok(!args.join(" ").includes("secret-token"));
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    assert.equal(config.mcpServers.personal.headers.Authorization, "Bearer ${PERSONAL_TOOLS_TOKEN}");
});

test("Claude distinguishes provider inactivity from total duration", async () => {
    const child = processStub();
    const promise = runClaude({ cwd: "/tmp", prompt: "Research", idleTimeout: 20,
        spawnProcess: () => child });
    let count = 0;
    const timer = setInterval(() => {
        child.stdout.write('{"type":"stream_event","event":{"type":"content_block_delta"}}\n');
        if (++count === 6) clearInterval(timer);
    }, 5);
    try {
        await assert.rejects(promise, (error) => error.code === "RESEARCH_STALLED");
        assert.equal(count, 6);
    } finally { clearInterval(timer); }
});

test("Claude parses final JSON and suppresses intermediate output", async () => {
    const child = processStub();
    const promise = runClaude({ cwd: "/tmp", prompt: "Investigate", toolToken: "token",
        spawnProcess: (command, args, options) => {
            assert.equal(command, "claude");
            assert.equal(options.detached, true);
            assert.equal(options.env.PERSONAL_TOOLS_TOKEN, "token");
            assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
            return child;
        } });
    child.stdout.write('{"type":"assistant","message":"internal"}\n');
    child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
        session_id: "12345678-1234-1234-1234-123456789abc", result: "Evidence" }) + "\n");
    child.emit("close", 0);
    assert.equal((await promise).answer, "Evidence");
});

test("Claude rejects errors and cancellation without exposing provider output", async () => {
    for (const cancel of [true, false]) {
        const child = processStub();
        const controller = new AbortController();
        const promise = runClaude({ cwd: "/tmp", prompt: "Investigate", signal: controller.signal,
            spawnProcess: () => child });
        if (cancel) controller.abort();
        else child.stdout.write('{"type":"result","is_error":true,"result":"private auth details"}\n');
        await assert.rejects(promise, (error) => error.code === "CLAUDE_FAILED" &&
            !error.message.includes("private"));
    }
});
