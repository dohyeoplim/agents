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

test("Claude tool access", () => {
    const args = claudeArguments("secret-token");
    assert.ok(args.includes("--restricted"));
    assert.ok(args.includes("dontAsk"));
    assert.equal(args[args.indexOf("--tools") + 1], "WebSearch,WebFetch");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    for (const tool of ["Read", "Glob", "Grep", "Bash", "Agent"]) {
        assert.ok(settings.permissions.deny.includes(tool));
    }
    const allowed = args[args.indexOf("--allowedTools") + 1];
    assert.ok(allowed.includes("mcp__personal__research_source_save"));
    assert.ok(!allowed.includes("canvas_update"));
    assert.ok(!args.join(" ").includes("secret-token"));
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    assert.equal(config.mcpServers.personal.headers.Authorization, "Bearer ${PERSONAL_TOOLS_TOKEN}");
});

test("Claude idle timeout", async () => {
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

test("Claude output", async () => {
    const child = processStub();
    const activity = [];
    const promise = runClaude({ cwd: "/tmp", prompt: "Investigate", toolToken: "token",
        onActivity: (...args) => activity.push(args),
        spawnProcess: (command, args, options) => {
            assert.equal(command, "claude");
            assert.equal(options.detached, true);
            assert.equal(options.env.PERSONAL_TOOLS_TOKEN, "token");
            assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
            return child;
        } });
    child.stdout.write('{"type":"unknown","message":"ignored"}\n');
    child.stdout.write('{"type":"assistant","message":"internal"}\n');
    child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
        session_id: "12345678-1234-1234-1234-123456789abc", result: "Evidence" }) + "\n");
    child.emit("close", 0);
    assert.equal((await promise).answer, "Evidence");
    assert.deepEqual(activity, [[], []]);
});

test("Claude failure handling", async () => {
    for (const cancel of [true, false]) {
        const child = processStub();
        const controller = new AbortController();
        const promise = runClaude({ cwd: "/tmp", prompt: "Investigate", signal: controller.signal,
            spawnProcess: () => child });
        if (cancel) controller.abort();
        else child.stdout.write('{"type":"result","is_error":true,"result":"private auth details"}\n');
        await assert.rejects(promise, (error) => error.code === (cancel ? "TASK_CANCELLED" : "PROVIDER_FAILED") &&
            !error.message.includes("private"));
    }
});

test("Claude error categories", async () => {
    for (const [event, stderr, code] of [
        [undefined, "401 invalid token sk-fake-secret", "AUTH_REQUIRED"],
        ["invalid json\n", "", "PROVIDER_PROTOCOL"],
        [JSON.stringify({ type: "result", is_error: true, errors: ["Rate limit exceeded"] }) + "\n",
            "", "RATE_LIMITED"],
    ]) {
        const child = processStub();
        const promise = runClaude({ cwd: "/tmp", prompt: "Research", spawnProcess: () => child });
        child.stderr.write(stderr);
        if (event) child.stdout.write(event);
        else child.emit("close", 1);
        await assert.rejects(promise, (error) => error.code === code && !error.message.includes("sk-fake-secret"));
    }
});
