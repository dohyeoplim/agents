import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createSshTransport } from "../src/remote/ssh.js";

const config = { host: "gpu.example.org", port: 2222, user: "agent",
    identityFile: "/remote/id_ed25519", knownHostsFile: "/remote/known_hosts" };

function setup() {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal) => { child.killed = signal; };
    const calls = [];
    const transport = createSshTransport(config, { spawnImpl: (...args) => { calls.push(args); return child; } });
    return { child, calls, transport };
}

test("SSH isolation", async () => {
    const { child, calls, transport } = setup();
    const payload = { operation: "exec", args: { command: "echo 'hello'; $(date)" }, namespace: "owner" };
    const pending = transport.request(payload);
    const [binary, args, options] = calls[0];
    assert.equal(binary, "ssh");
    assert.deepEqual(args.slice(0, 3), ["-F", "/dev/null", "-T"]);
    for (const option of ["StrictHostKeyChecking=yes", "BatchMode=yes", "ClearAllForwardings=yes",
        "ForwardAgent=no", "ControlMaster=no", "ControlPath=none", "IdentitiesOnly=yes", "ConnectTimeout=10"]) {
        assert.ok(args.includes(option));
    }
    assert.equal(args.at(-2), config.host);
    assert.ok(args.at(-1).startsWith("python3 -c '"));
    assert.ok(!args.join(" ").includes(payload.args.command));
    assert.deepEqual(Object.keys(options.env).sort(), ["LANG", "PATH"]);
    assert.deepEqual(JSON.parse(child.stdin.read().toString()), payload);
    child.stdout.write('{"ok":true,"result":{"text":"한글"}}');
    child.emit("close", 0);
    assert.deepEqual(await pending, { ok: true, result: { text: "한글" } });
});

test("SSH cancellation", async () => {
    const { child, transport } = setup();
    const controller = new AbortController();
    const pending = transport.request({ operation: "exec" }, controller.signal);
    controller.abort();
    await assert.rejects(pending, { code: "TASK_CANCELLED", uncertain: true });
    assert.equal(child.killed, "SIGKILL");
    child.emit("close", 0);
});

test("SSH preabort", async () => {
    const { calls, transport } = setup();
    await assert.rejects(transport.request({}, AbortSignal.abort()), { code: "TASK_CANCELLED" });
    assert.equal(calls.length, 0);
});

test("SSH output limit", async () => {
    const { child, transport } = setup();
    const pending = transport.request({});
    child.stdout.write(Buffer.alloc(128 * 1024 + 1));
    await assert.rejects(pending, { code: "REMOTE_OUTPUT", uncertain: true });
    assert.equal(child.killed, "SIGKILL");
});

test("SSH protocol errors", async () => {
    for (const output of ["banner\n{}", "null", "[]", '{"ok":true}garbage']) {
        const { child, transport } = setup();
        const pending = transport.request({});
        child.stdout.write(output);
        child.emit("close", 0);
        await assert.rejects(pending, { code: "REMOTE_PROTOCOL" });
    }
});

test("SSH safe errors", async () => {
    const { child, transport } = setup();
    const pending = transport.request({});
    child.stderr.write("SECRET PRIVATE CREDENTIAL");
    child.emit("error", Error("SECRET PRIVATE CREDENTIAL"));
    await assert.rejects(pending, (error) => {
        assert.equal(error.code, "REMOTE_CONNECT");
        assert.ok(!error.message.includes("SECRET"));
        assert.ok(error.message.includes("do not retry automatically"));
        return true;
    });
});

test("SSH exit failure", async () => {
    const { child, transport } = setup();
    const pending = transport.request({});
    child.stdout.write('{"ok":true}');
    child.emit("close", 255);
    await assert.rejects(pending, { code: "REMOTE_CONNECT" });
});

test("SSH timeout", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { child, transport } = setup();
    const pending = transport.request({});
    context.mock.timers.tick(45000);
    await assert.rejects(pending, { code: "REMOTE_TIMEOUT" });
    assert.equal(child.killed, "SIGKILL");
});

test("SSH invalid settings", () => {
    for (const override of [{ host: "-oProxyCommand=bad" }, { port: 0 }, { user: "a\nb" },
        { identityFile: "relative" }, { knownHostsFile: "/remote/known\nhosts" }]) {
        assert.throws(() => createSshTransport({ ...config, ...override }), { code: "REMOTE_CONFIG" });
    }
});
