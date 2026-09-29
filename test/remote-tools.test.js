import test from "node:test";
import assert from "node:assert/strict";
import { loadRemoteConfig } from "../src/remote/config.js";
import { createRemoteTools, execInput, jobInput, readInput, writeInput } from "../src/remote/tools.js";

const id = "05d1b22a-cf4f-484f-8d22-60a44e9932f7";

test("optional remote", () => {
    assert.equal(loadRemoteConfig({}), null);
    assert.equal(loadRemoteConfig({ REMOTE_HOST: "" }), null);
    assert.deepEqual(loadRemoteConfig({ REMOTE_HOST: "gpu.example.org" }), {
        host: "gpu.example.org", port: 2222, user: "agent",
        identityFile: "/run/secrets/gpu_agent", knownHostsFile: "/run/secrets/gpu_known_hosts",
    });
    const config = loadRemoteConfig({ REMOTE_HOST: "192.168.0.4", REMOTE_PORT: "2200", REMOTE_USER: "research",
        REMOTE_IDENTITY_FILE: "/keys/identity", REMOTE_KNOWN_HOSTS_FILE: "/keys/hosts" });
    assert.equal(config.port, 2200);
    assert.equal(config.user, "research");
    assert.equal(config.identityFile, "/keys/identity");
    assert.equal(config.knownHostsFile, "/keys/hosts");
});

test("invalid remote", () => {
    for (const host of ["-oProxyCommand=cmd", "user@host", "host:22", "::1", "a b", "a\nb", "999.1.1.1"]) {
        assert.throws(() => loadRemoteConfig({ REMOTE_HOST: host }));
    }
    for (const [key, values] of Object.entries({ REMOTE_PORT: ["", "0", "65536", "1.5", "abc"],
        REMOTE_USER: ["", "-root", "user@host", "user name"],
        REMOTE_IDENTITY_FILE: ["", "relative", "/key\nfile"],
        REMOTE_KNOWN_HOSTS_FILE: ["", "relative", "/key\0file"] })) {
        for (const value of values) assert.throws(() => loadRemoteConfig({ REMOTE_HOST: "gpu", [key]: value }));
    }
});

test("execution boundaries", () => {
    assert.deepEqual(execInput.parse({ id, command: "nvidia-smi" }),
        { id, command: "nvidia-smi", cwd: "/workspace", timeoutSeconds: 86400 });
    for (const args of [{ command: "true" }, { id, command: "" }, { id, command: "a\0b" },
        { id, command: "x".repeat(16001) }, { id, command: "true", cwd: "relative" },
        { id, command: "true", timeoutSeconds: 0 }, { id, command: "true", timeoutSeconds: 604801 },
        { id, command: "true", host: "other" }]) assert.equal(execInput.safeParse(args).success, false);
});

test("file boundaries", () => {
    assert.equal(readInput.parse({ path: "/workspace/file" }).offset, 0);
    assert.equal(jobInput.parse({ id }).offset, 0);
    for (const value of [-1, 0.5]) {
        assert.equal(readInput.safeParse({ path: "/workspace/file", offset: value }).success, false);
        assert.equal(jobInput.safeParse({ id, offset: value }).success, false);
    }
    assert.equal(writeInput.parse({ path: "/workspace/file", content: "", expectedHash: null }).expectedHash, null);
    assert.equal(writeInput.parse({ path: "/workspace/file", content: "new", expectedHash: "a".repeat(64) })
        .expectedHash, "a".repeat(64));
    for (const args of [{ path: "/file", content: "new" }, { path: "file", content: "", expectedHash: null },
        { path: "/file", content: "x".repeat(64001), expectedHash: null },
        { path: "/file", content: "", expectedHash: "A".repeat(64) }]) {
        assert.equal(writeInput.safeParse(args).success, false);
    }
});

test("service routing", async () => {
    const calls = [];
    const service = { run: (...args) => { calls.push(args); return "result"; } };
    const tools = createRemoteTools(service);
    const context = { user: "U1", channel: "C1" };
    const signal = new AbortController().signal;
    for (const [operation, args] of Object.entries({ status: {}, exec: { id, command: "true" }, jobs: {},
        job: { id }, cancel: { id }, read: { path: "/workspace/file" },
        write: { path: "/workspace/file", content: "", expectedHash: null } })) {
        const tool = tools[`remote_${operation}`];
        const parsed = tool.schema.parse(args);
        assert.equal(await tool.run(parsed, context, signal), "result");
        assert.deepEqual(calls.at(-1), [operation, parsed, context, signal]);
        assert.equal(tool.readOnly, !["exec", "cancel", "write"].includes(operation));
    }
    assert.deepEqual(createRemoteTools(), {});
    for (const operation of ["status", "jobs"]) {
        assert.equal(tools[`remote_${operation}`].schema.safeParse({ unexpected: true }).success, false);
    }
});
