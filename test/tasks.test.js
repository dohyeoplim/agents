import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PersistentState } from "../src/state.js";
import { TaskRuntime, sessionFor } from "../src/tasks.js";

const context = { team: "T1", user: "U1", channel: "C1", thread: "1.1", key: "T1:C1:1.1:assistant" };
const input = { ...context, profile: "assistant", prompt: "hello" };
const result = { answer: "Answer", session: "12345678-1234-1234-1234-123456789abc" };

async function fixture(t, execute = async () => result) {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-tasks-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = await new PersistentState(path.join(root, "state.json"), { threads: {}, tasks: {} }).load();
    const delivered = [];
    const runtime = new TaskRuntime({
        store, execute, deliver: async (task, answer) => delivered.push({ task, answer }),
    });
    return { store, runtime, delivered };
}

test("completed tasks persist their session and answer before delivery", async (t) => {
    const { store, runtime, delivered } = await fixture(t);
    const id = await runtime.enqueue(input);
    await runtime.idle();
    assert.equal(store.snapshot().tasks[id].status, "completed");
    assert.equal(store.snapshot().tasks[id].delivery, "delivered");
    assert.equal(sessionFor(store.snapshot(), input), result.session);
    assert.equal(delivered[0].answer, result.answer);
});

test("stop cancels running work while other commands remain available", async (t) => {
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const { store, runtime } = await fixture(t, async (task, signal) => {
        started();
        await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Error("Stopped"))));
    });
    const id = await runtime.enqueue(input);
    await ready;
    await assert.rejects(runtime.cancel({ ...context, user: "U2" }, id));
    await runtime.cancel(context, id.slice(0, 8));
    await runtime.idle();
    assert.equal(store.snapshot().tasks[id].status, "cancelled");
});

test("restart interrupts running tasks without executing them again", async (t) => {
    let executions = 0;
    const { store, runtime } = await fixture(t, async () => {
        executions++;
        return result;
    });
    runtime.closed = true;
    const id = await runtime.enqueue(input);
    await store.update((data) => { data.tasks[id].status = "running"; });
    await runtime.recover();
    runtime.closed = false;
    runtime.wake();
    await runtime.idle();
    assert.equal(executions, 0);
    assert.equal(store.snapshot().tasks[id].status, "interrupted");
    const retry = await runtime.retry(context, id);
    await runtime.idle();
    assert.notEqual(retry, id);
    assert.equal(executions, 1);
});

test("uncertain Slack delivery is retried without rerunning the task", async (t) => {
    let executions = 0;
    const { store, runtime } = await fixture(t, async () => {
        executions++;
        return result;
    });
    runtime.deliver = async () => { throw Error("Disconnected"); };
    const id = await runtime.enqueue(input);
    await runtime.idle();
    assert.equal(store.snapshot().tasks[id].delivery, "uncertain");
    runtime.deliver = async () => {};
    await runtime.redeliver(context, id);
    await runtime.idle();
    assert.equal(executions, 1);
    assert.equal(store.snapshot().tasks[id].delivery, "delivered");
});

test("specialist sessions do not overwrite the original conversation", () => {
    const data = { threads: { [input.key]: { session: "old", sessions: { scholar: "specialist" } } } };
    assert.equal(sessionFor(data, input), "old");
    assert.equal(sessionFor(data, { ...input, profile: "scholar", delegated: true }), "specialist");
    assert.equal(sessionFor(data, { ...input, profile: "engineer", delegated: true }), undefined);
});

test("user memories are not carried into another user's Codex session", () => {
    const data = { threads: { [input.key]: { owner: "U1", session: "private", sessions: {} } } };
    assert.equal(sessionFor(data, input), "private");
    assert.equal(sessionFor(data, { ...input, user: "U2" }), undefined);
    assert.equal(sessionFor(data, { ...input, scheduleId: "S1" }), undefined);
});

test("unchanged scheduled answers are suppressed after the first delivery", async (t) => {
    const { store, runtime, delivered } = await fixture(t);
    await store.update((data) => { data.schedules = { S1: { onChange: true } }; });
    await runtime.enqueue({ ...input, scheduleId: "S1" });
    await runtime.idle();
    const id = await runtime.enqueue({ ...input, scheduleId: "S1" });
    await runtime.idle();
    assert.equal(delivered.length, 1);
    assert.equal(store.snapshot().tasks[id].delivery, "suppressed");
});
