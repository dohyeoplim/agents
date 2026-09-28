import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PersistentState } from "../../src/shared/state.js";
import { TaskRuntime, sessionFor } from "../../src/tasks/runtime.js";

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

test("task persistence", async (t) => {
    const { store, runtime, delivered } = await fixture(t);
    const id = await runtime.enqueue(input);
    await runtime.idle();
    assert.equal(store.snapshot().tasks[id].status, "completed");
    assert.equal(store.snapshot().tasks[id].delivery, "delivered");
    assert.equal(sessionFor(store.snapshot(), input), result.session);
    assert.equal(delivered[0].answer, result.answer);
});

test("task cancellation", async (t) => {
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

test("task recovery", async (t) => {
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

test("answer redelivery", async (t) => {
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

test("specialist sessions", () => {
    const data = { threads: { [input.key]: { session: "old", sessions: { scholar: "specialist" } } } };
    assert.equal(sessionFor(data, input), "old");
    assert.equal(sessionFor(data, { ...input, profile: "scholar", delegated: true }), "specialist");
    assert.equal(sessionFor(data, { ...input, profile: "engineer", delegated: true }), undefined);
});

test("user session isolation", () => {
    const data = { threads: { [input.key]: { owner: "U1", session: "private", sessions: {} } } };
    assert.equal(sessionFor(data, input), "private");
    assert.equal(sessionFor(data, { ...input, user: "U2" }), undefined);
    assert.equal(sessionFor(data, { ...input, scheduleId: "S1" }), undefined);
});

test("unchanged answers", async (t) => {
    const { store, runtime, delivered } = await fixture(t);
    await store.update((data) => { data.schedules = { S1: { onChange: true } }; });
    await runtime.enqueue({ ...input, scheduleId: "S1" });
    await runtime.idle();
    const id = await runtime.enqueue({ ...input, scheduleId: "S1" });
    await runtime.idle();
    assert.equal(delivered.length, 1);
    assert.equal(store.snapshot().tasks[id].delivery, "suppressed");
});

test("history receipts commit with successful sessions and survive delivery failure", async (t) => {
    const historyReceipt = { hashes: { "1.000001": "revision" } };
    const { store, runtime } = await fixture(t, async () => ({ ...result, historyReceipt }));
    runtime.deliver = async () => { throw Error("Disconnected"); };
    const id = await runtime.enqueue({ ...input, messageTs: "1.000002" });
    await runtime.idle();
    assert.equal(store.snapshot().tasks[id].messageTs, "1.000002");
    assert.equal(store.snapshot().tasks[id].delivery, "uncertain");
    assert.deepEqual(store.snapshot().threads[input.key].historyContexts["assistant:U1"], {
        ...historyReceipt, session: result.session,
    });
});

test("failed and cancelled executions never advance history receipts", async (t) => {
    for (const outcome of ["failed", "cancelled"]) {
        await t.test(outcome, async (t) => {
            let started;
            const ready = new Promise((resolve) => { started = resolve; });
            const { store, runtime } = await fixture(t, async (task, signal) => {
                if (outcome === "failed") throw Error("Worker failed");
                started();
                await new Promise((resolve) => signal.addEventListener("abort", resolve));
                return { ...result, historyReceipt: { hashes: { newer: "new" } } };
            });
            const previous = { hashes: { older: "old" }, session: result.session };
            await store.update((data) => {
                data.threads[input.key] = { historyContexts: { "assistant:U1": previous } };
            });
            const id = await runtime.enqueue(input);
            if (outcome === "cancelled") {
                await ready;
                await runtime.cancel(context, id);
            }
            await runtime.idle();
            assert.equal(store.snapshot().tasks[id].status, outcome);
            assert.deepEqual(store.snapshot().threads[input.key].historyContexts["assistant:U1"], previous);
        });
    }
});
