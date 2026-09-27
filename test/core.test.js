import test from "node:test";
import assert from "node:assert/strict";
import {
    mkdtemp,
    mkdir,
    symlink,
    writeFile,
    chmod,
    rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    validate,
    routeEvent,
    confined,
    Store,
    SerialQueue,
    chunks,
} from "../src/core.js";
import { codexArgs, runCodex } from "../src/codex.js";

const config = validate({
    team: "T1",
    users: ["U1"],
    channels: { C1: { agent: "assistant", cwd: "project" } },
});
const event = {
    channel: "C1",
    user: "U1",
    ts: "123.456",
    text: "<@BOT> hello",
};

test("message routing", () => {
    const select = (e, team = "T1", known = () => false) =>
        routeEvent(config, { team_id: team }, e, "BOT", known);
    assert.equal(select(event).prompt, "hello");
    for (const e of [
        { ...event, user: "U2" },
        { ...event, channel: "C2" },
        { ...event, bot_id: "B1" },
        { ...event, subtype: "message_changed" },
        { ...event, text: "ordinary chat" },
    ])
        assert.equal(select(e), null);
    assert.equal(select(event, "T2"), null);
    assert.ok(
        select(
            { ...event, thread_ts: "120.000", text: "follow up" },
            "T1",
            () => true,
        ),
    );
    assert.equal(
        select({ ...event, thread_ts: "120.000", text: "follow up" }),
        null,
    );
});

test("path confinement", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(path.join(dir, "root"));
    await mkdir(path.join(dir, "outside"));
    await symlink(path.join(dir, "outside"), path.join(dir, "root", "link"));
    await assert.rejects(confined(path.join(dir, "root"), "link"));
    await assert.rejects(confined(path.join(dir, "root"), "../outside"));
    assert.equal(
        await confined(path.join(dir, "root"), "."),
        await (
            await import("node:fs/promises")
        ).realpath(path.join(dir, "root")),
    );
    assert.throws(() =>
        validate({
            ...config,
            channels: { C1: { agent: "assistant", cwd: "../escape" } },
        }),
    );
});

test("session persistence", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "store-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new Store(path.join(dir, "state.json"));
    await store.load();
    store.data.threads.a = { session: "abc" };
    await store.save();
    const next = new Store(store.file);
    await next.load();
    assert.equal(next.data.threads.a.session, "abc");
});

test("queue recovery", async () => {
    const q = new SerialQueue();
    const order = [];
    const a = q.run(async () => {
        await new Promise((r) => setTimeout(r, 15));
        order.push(1);
        throw Error("expected");
    });
    const b = q.run(async () => order.push(2));
    await assert.rejects(a);
    await b;
    assert.deepEqual(order, [1, 2]);
});

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

test("Unicode chunks", () =>
    assert.equal(chunks("🙂".repeat(6000)).join(""), "🙂".repeat(6000)));
