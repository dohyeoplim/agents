import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("../src/remote/bridge.py", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const active = (job) => ["starting", "running"].includes(job.status);

async function waitFor(check, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await check();
        if (result) return result;
        await delay(50);
    }
    throw Error("Condition timed out");
}

async function stopped(pid) {
    try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
    } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
    }
}

async function fixture(t) {
    const home = await mkdtemp(join(tmpdir(), "agents-remote-test-"));
    const namespace = hash(randomUUID());
    const ids = new Set();
    async function call(operation, args = {}, scope = namespace) {
        const child = spawn("python3", [bridge], { env: { ...process.env, HOME: home },
            stdio: ["pipe", "pipe", "pipe"] });
        let output = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        const response = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(Error("Bridge timed out")); }, 10000);
            child.on("error", (error) => { clearTimeout(timeout); reject(error); });
            child.on("close", (code) => {
                clearTimeout(timeout);
                try {
                    assert.equal(code, 0, stderr);
                    resolve(JSON.parse(output));
                } catch (error) { reject(error); }
            });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify({ namespace: scope, operation, args }));
        return response;
    }
    async function run(operation, args = {}) {
        if (operation === "exec") ids.add(args.id);
        const response = await call(operation, args);
        assert.equal(response.ok, true, JSON.stringify(response));
        return response.result;
    }
    const finish = (id) => waitFor(async () => {
        const job = await run("job", { id });
        return !active(job) && job;
    });
    t.after(async () => {
        try {
            for (const id of ids) {
                const response = await call("cancel", { id });
                if (response.ok && active(response.result)) await finish(id);
            }
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
    return { home, root: join(home, ".local/state/agents-remote", namespace), call, run, finish };
}

test("execution idempotency", async (t) => {
    const { home, run, call, finish } = await fixture(t);
    const id = randomUUID();
    const args = { id, command: "printf x >> count; printf complete", cwd: home, timeoutSeconds: 30 };
    const starts = await Promise.all([run("exec", args), run("exec", args)]);
    assert.ok(starts.every((job) => job.id === id));
    const result = await finish(id);
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "complete");
    assert.equal((await run("exec", args)).status, "completed");
    assert.equal(await readFile(join(home, "count"), "utf8"), "x");
    assert.deepEqual(await call("exec", { ...args, command: "printf duplicate >> count" }),
        { ok: false, error: "REMOTE_ID_CONFLICT" });
    assert.equal(await readFile(join(home, "count"), "utf8"), "x");
});

test("log pagination", async (t) => {
    const { home, run, call, finish } = await fixture(t);
    const id = randomUUID();
    await run("exec", { id, command: "python3 -c 'print(\"a\" * 20000, end=\"\")'",
        cwd: home, timeoutSeconds: 30 });
    const first = await finish(id);
    assert.equal(first.output, "a".repeat(16000));
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 16000);
    assert.equal(first.hasMore, true);
    const second = await run("job", { id, offset: first.nextOffset });
    assert.equal(second.output, "a".repeat(4000));
    assert.equal(second.nextOffset, 20000);
    assert.equal(second.hasMore, false);
    const jobs = await run("jobs");
    assert.deepEqual(jobs.jobs.map((job) => job.id), [id]);
    assert.equal(jobs.truncated, false);
    const other = await call("jobs", {}, hash("other"));
    assert.deepEqual(other.result.jobs, []);
});

test("unicode pagination", async (t) => {
    const { home, run, finish } = await fixture(t);
    const id = randomUUID();
    const expected = "a" + "한글🙂".repeat(5000);
    await run("exec", { id, command: "python3 -c 'print(\"a\" + \"한글🙂\" * 5000, end=\"\")'",
        cwd: home, timeoutSeconds: 30 });
    let page = await finish(id);
    let output = page.output;
    assert.equal(page.hasMore, true);
    assert.ok(page.nextOffset < 16000);
    assert.equal(page.nextOffset, Buffer.byteLength(page.output));
    while (page.hasMore) {
        const offset = page.nextOffset;
        page = await run("job", { id, offset });
        assert.ok(page.nextOffset > offset);
        output += page.output;
        assert.equal(page.nextOffset, Buffer.byteLength(output));
    }
    assert.equal(output, expected);
});

test("process cancellation", async (t) => {
    const { home, run, finish } = await fixture(t);
    const id = randomUUID();
    await run("exec", { id, cwd: home, timeoutSeconds: 30,
        command: "trap '' TERM; sleep 60 & child=$!; printf '%s' \"$child\" > child.pid; wait" });
    const pid = await waitFor(async () => {
        try { return Number(await readFile(join(home, "child.pid"), "utf8")); } catch { return false; }
    });
    assert.equal((await run("cancel", { id })).cancelRequested, true);
    assert.equal((await finish(id)).status, "cancelled");
    await waitFor(() => stopped(pid));
    assert.equal((await run("cancel", { id })).cancelRequested, false);
});

test("orphan cancellation", async (t) => {
    const { home, root, run } = await fixture(t);
    const id = randomUUID();
    await run("exec", { id, command: "sleep 60", cwd: home, timeoutSeconds: 30 });
    const child = await waitFor(async () => {
        try { return JSON.parse(await readFile(join(root, id, "child.json"), "utf8")); }
        catch { return false; }
    });
    t.after(async () => {
        if (!await stopped(child.pid)) {
            try { process.kill(-child.pid, "SIGKILL"); }
            catch (error) { if (error.code !== "ESRCH") throw error; }
            await waitFor(() => stopped(child.pid));
        }
    });
    const supervisor = JSON.parse(await readFile(join(root, id, "launch.json"), "utf8"));
    process.kill(supervisor.pid, "SIGKILL");
    await waitFor(() => stopped(supervisor.pid));
    assert.equal((await run("job", { id })).status, "interrupted");
    assert.equal(await stopped(child.pid), false);
    const result = await run("cancel", { id });
    assert.equal(result.cancelRequested, true);
    assert.equal(result.orphanStopped, true);
    await waitFor(() => stopped(child.pid));
    assert.equal((await run("cancel", { id })).cancelRequested, false);
});

test("execution timeout", async (t) => {
    const { home, run, finish } = await fixture(t);
    const id = randomUUID();
    await run("exec", { id, command: "sleep 30", cwd: home, timeoutSeconds: 0.1 });
    const job = await finish(id);
    assert.equal(job.status, "timed_out");
    assert.notEqual(job.exitCode, 0);
});

test("file revisions", async (t) => {
    const { home, run, call } = await fixture(t);
    const path = join(home, "file.txt");
    const content = "한".repeat(17000);
    const created = await run("write", { path, content, expectedHash: null });
    assert.equal(created.hash, hash(content));
    assert.equal(created.bytes, Buffer.byteLength(content));
    const first = await run("read", { path });
    assert.equal(first.content, "한".repeat(16000));
    assert.equal(first.hash, created.hash);
    assert.equal(first.nextOffset, 16000);
    const second = await run("read", { path, offset: first.nextOffset });
    assert.equal(second.content, "한".repeat(1000));
    assert.equal(second.nextOffset, null);
    assert.deepEqual(await call("write", { path, content: "bad", expectedHash: null }),
        { ok: false, error: "REMOTE_FILE_CHANGED" });
    await run("write", { path, content: "updated", expectedHash: created.hash });
    assert.deepEqual(await call("write", { path, content: "stale", expectedHash: created.hash }),
        { ok: false, error: "REMOTE_FILE_CHANGED" });
    assert.equal(await readFile(path, "utf8"), "updated");
});

test("fifo rejection", async (t) => {
    const { home, run, call, finish } = await fixture(t);
    const id = randomUUID();
    await run("exec", { id, command: "mkfifo pipe", cwd: home, timeoutSeconds: 30 });
    assert.equal((await finish(id)).status, "completed");
    const path = join(home, "pipe");
    assert.deepEqual(await call("read", { path }), { ok: false, error: "REMOTE_FILE_INVALID" });
    assert.deepEqual(await call("write", { path, content: "blocked", expectedHash: null }),
        { ok: false, error: "REMOTE_FILE_INVALID" });
});

test("missing directory", async (t) => {
    const { home, run, finish } = await fixture(t);
    const id = randomUUID();
    await run("exec", { id, command: "true", cwd: join(home, "missing"), timeoutSeconds: 30 });
    const job = await finish(id);
    assert.equal(job.status, "failed");
    assert.equal(job.error, "REMOTE_COMMAND_FAILED");
});
