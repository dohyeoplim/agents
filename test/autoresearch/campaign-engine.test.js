import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCampaignEngine } from "../../src/autoresearch/campaign-engine.js";

const command = { kind: "command", purpose: "Measure baseline", command: "python train.py", cwd: "/workspace",
    timeoutSeconds: 10 };
const report = (text) => ({ kind: "report", text });

function setup(options = {}) {
    const job = { id: randomUUID(), runId: randomUUID(), mode: "campaign", status: "running", revision: 0,
        team: "T1", user: "U1", channel: "C1", thread: "1.0", key: "key", profile: "assistant",
        executionDeadline: Date.now() + 100000,
        campaign: { objective: "Improve training", title: "Study", timezone: "Asia/Seoul", maxSteps: 24,
            maxCommands: 24, wallSeconds: 100, gpuSeconds: 400, trialSeconds: 20, gpus: 4 }, ...options.job };
    let data = { autoresearchJobs: { [job.id]: structuredClone(job) }, tasks: {} };
    const state = { snapshot: () => structuredClone(data), update: async (change) => {
        const next = structuredClone(data);
        const result = change(next);
        data = next;
        return structuredClone(result);
    } };
    const answers = [...(options.answers || [command, report("Draft"), report("Critique"), report("Final")])];
    const tasks = [];
    const calls = [];
    const posts = [];
    const saved = [];
    const engine = createCampaignEngine({ state, pollMs: 1,
        execute: async (task, signal) => {
            tasks.push(task);
            if (options.execute) return options.execute(task, signal, state);
            return { answer: JSON.stringify(answers.shift()) };
        },
        remote: { run: async (operation, args, context, signal) => {
            if (operation === "status") return { connected: options.connected !== false };
            calls.push({ operation, args, context, signal });
            if (options.remote) return options.remote(operation, args, context, signal, state);
            return { status: "completed", output: "accuracy=0.9", nextOffset: 12, exitCode: 0 };
        } },
        artifacts: { put: async (text, metadata) => {
            saved.push({ text, metadata });
            return { id: "a".repeat(64) };
        } },
        publish: async () => {}, post: async (value, text) => {
            posts.push(text);
            if (options.postError) throw Error();
        },
    });
    return { job, state, engine, tasks, calls, posts, saved, current: () => state.snapshot().autoresearchJobs[job.id] };
}

test("campaign full flow", async () => {
    const f = setup();
    await f.engine.run(f.job);
    assert.equal(f.current().status, "completed");
    assert.equal(f.current().revision, 1);
    assert.equal(f.current().campaignState.commands, 1);
    assert.equal(f.current().campaignState.gpuSeconds, 40);
    assert.equal(f.current().campaignState.history[0].output, "accuracy=0.9");
    assert.deepEqual(f.tasks.map((task) => task.provider), ["codex", "codex", "claude", "codex"]);
    assert.equal(f.tasks[2].researchStage, "campaign-review");
    assert.equal(JSON.parse(f.tasks[3].prompt).finalOnly, true);
    assert.equal(JSON.parse(f.tasks[3].prompt).review, "Critique");
    assert.equal(f.saved[0].text, "Final");
    assert.equal(f.saved[0].metadata.source.fileId, f.job.id);
    assert.equal(f.current().finalReportId, f.current().campaignState.finalReportId);
    assert.ok(f.calls.every((call) => !call.context.researchId));
    assert.ok(Object.values(f.state.snapshot().tasks).every((task) => task.delivery === "suppressed"));
});

test("campaign resume command", async () => {
    const id = randomUUID();
    const f = setup({ answers: [report("Draft"), report("Review"), report("Final")],
        job: { campaignState: { steps: 1, commands: 1, gpuSeconds: 40, history: [],
            pending: { purpose: command.purpose, submitted: false,
                args: { id, command: command.command, cwd: command.cwd, timeoutSeconds: 10 } } } } });
    await f.engine.run(f.job);
    assert.equal(f.calls.find((call) => call.operation === "exec").args.id, id);
    assert.equal(f.current().campaignState.commands, 1);
    assert.equal(f.current().campaignState.gpuSeconds, 40);
    assert.equal(f.current().campaignState.pending, undefined);
});

test("campaign budget limit", async () => {
    const f = setup({ job: { campaignState: { steps: 24, commands: 24, gpuSeconds: 0, history: [] } } });
    await f.engine.run(f.job);
    assert.equal(f.current().status, "limited");
    assert.equal(f.calls.length, 0);
    assert.equal(f.posts.length, 1);
    assert.equal(f.current().finalReportId, "a".repeat(64));
});

test("campaign cancel pending", async () => {
    const controller = new AbortController();
    const f = setup({ remote: async (operation) => {
        if (operation === "cancel") return { status: "cancelled" };
        if (operation === "job") {
            controller.abort();
            return new Promise(() => {});
        }
        return { status: "running" };
    } });
    await assert.rejects(f.engine.run(f.job, controller.signal));
    const cancellation = f.calls.find((call) => call.operation === "cancel");
    assert.ok(cancellation);
    assert.equal(cancellation.signal.aborted, false);
    assert.equal(cancellation.args.id, f.current().campaignState.pending.args.id);
});

test("campaign stale run", async () => {
    const f = setup({ execute: async (task, signal, state) => {
        await state.update((data) => { data.autoresearchJobs[task.autoresearchId].runId = randomUUID(); });
        return { answer: JSON.stringify(command) };
    } });
    await assert.rejects(f.engine.run(f.job), { code: "CAMPAIGN_STOPPED" });
    assert.equal(f.calls.length, 0);
    assert.equal(f.current().campaignState.commands, 0);
});

test("campaign blocked question", async () => {
    const f = setup({ answers: [{ kind: "blocked", question: "Which dataset?" }] });
    await f.engine.run(f.job);
    assert.equal(f.current().status, "awaiting_input");
    assert.deepEqual(f.current().questions, ["Which dataset?"]);
    assert.equal(f.calls.length, 0);
});

test("campaign delivery failure", async () => {
    const f = setup({ postError: true, answers: [report("Draft"), report("Review"), report("Final")] });
    await f.engine.run(f.job);
    assert.equal(f.current().status, "completed");
    assert.equal(f.current().statusDelivery, "unconfirmed");
});

test("campaign final restriction", async () => {
    const f = setup({ answers: [report("Draft"), report("Review"), command] });
    await assert.rejects(f.engine.run(f.job));
    assert.equal(f.calls.length, 0);
    assert.equal(f.saved.length, 0);
});

test("campaign uncertain submission", async () => {
    const f = setup({ remote: async (operation) => {
        if (operation === "exec") throw Object.assign(Error("Connection lost"), { uncertain: true });
        return { cancelRequested: false };
    } });
    await assert.rejects(f.engine.run(f.job), /Connection lost/);
    assert.equal(f.current().campaignState.pending.submitted, false);
    assert.equal(f.current().campaignState.commands, 1);
    assert.equal(f.current().campaignState.gpuSeconds, 40);
    assert.equal(f.calls[0].args.id, f.current().campaignState.pending.args.id);
});

test("campaign paged logs", async () => {
    const f = setup({ remote: async (operation, args) => {
        if (operation === "exec") return { status: "running" };
        return args.offset === 0 ? { status: "completed", output: "x".repeat(16000),
            nextOffset: 16000, hasMore: true } : { status: "completed", output: "final metric", nextOffset: 16012 };
    } });
    await f.engine.run(f.job);
    const history = f.current().campaignState.history;
    assert.ok(history[0].output.endsWith("final metric"));
    assert.ok(history[0].output.length <= 12000);
    assert.equal(history[0].outputTruncated, true);
    assert.ok(JSON.stringify(history).length <= 30000);
    assert.equal(f.calls.filter((call) => call.operation === "job").length, 2);
});

test("campaign elapsed deadline", async () => {
    const f = setup({ job: { executionDeadline: Date.now() - 1 } });
    await f.engine.run(f.job);
    assert.equal(f.current().status, "limited");
    assert.equal(f.current().limitReason, "time");
    assert.equal(f.calls.length, 0);
    assert.equal(f.tasks.length, 0);
});

test("campaign finalization reserve", async () => {
    const f = setup({ answers: [report("Draft"), report("Review"), report("Final")],
        job: { campaignState: { steps: 21, commands: 2, gpuSeconds: 80,
            history: [{ purpose: "Baseline", command: "python train.py",
                output: "x".repeat(11000) + "metric=0.9" }] } } });
    await f.engine.run(f.job);
    assert.equal(f.current().status, "completed");
    assert.equal(f.current().campaignState.steps, 24);
    assert.equal(JSON.parse(f.tasks[0].prompt).finalOnly, true);
    assert.ok(JSON.parse(f.tasks[2].prompt).history[0].output.endsWith("metric=0.9"));
    assert.equal(f.calls.length, 0);
});

test("campaign orphan uncertainty", async () => {
    const f = setup({ remote: async (operation) => operation === "cancel" ?
        { status: "interrupted", cancelRequested: false } : { status: "interrupted" } });
    await f.engine.run(f.job);
    assert.equal(f.current().status, "awaiting_input");
    assert.equal(f.current().campaignState.cleanupPending, true);
    assert.ok(f.current().campaignState.pending);
});

test("campaign disconnected workspace", async () => {
    const f = setup({ connected: false });
    await assert.rejects(f.engine.run(f.job), /not connected/);
    assert.equal(f.tasks.length, 0);
    assert.equal(f.calls.length, 0);
});

test("campaign cancellation confirmation", async () => {
    const controller = new AbortController();
    let reads = 0;
    const f = setup({ remote: async (operation) => {
        if (operation === "job" && ++reads === 1) controller.abort();
        return { status: reads > 1 ? "cancelled" : "running" };
    } });
    await assert.rejects(f.engine.run(f.job, controller.signal));
    assert.equal(reads, 2);
    assert.equal(f.current().campaignState.cleanupPending, false);
    assert.equal(f.current().campaignState.pending.stoppedConfirmed, true);
});
