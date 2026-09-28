import test from "node:test";
import assert from "node:assert/strict";
import { createResearch } from "../../src/research/service.js";
import { createMessageHandler } from "../../src/slack/messages.js";
import { createResearchSlack } from "../../src/research/slack.js";

const context = { team: "T1", user: "U1", channel: "C1", thread: "100.001",
    key: "T1:C1:100.001:assistant", profile: "assistant", messageTs: "100.001" };
const plan = { ready: true, title: "Methods", brief: "Compare methods and limitations", questions: [] };
const proposal = { title: plan.title, brief: plan.brief, questions: [] };
const taskContext = { ...context, id: "task1" };
const deferred = () => Promise.withResolvers();

function fixture(run, send, authorize) {
    let data = { researchJobs: {}, researchSources: {}, tasks: {}, threads: {}, events: {} };
    let tail = Promise.resolve();
    const state = { snapshot: () => structuredClone(data), update: (change) => {
        const next = tail.then(() => {
            const draft = structuredClone(data);
            const result = change(draft);
            data = draft;
            return structuredClone(result);
        });
        tail = next.catch(() => {});
        return next;
    } };
    const reports = new Map();
    const library = { saveReport: async (job, stage, text, { provider }) => {
        const report = { id: String(reports.size + 1), stage, provider, runId: job.runId };
        reports.set(report.id, text);
        await state.update((draft) => { draft.researchJobs[job.id].reports.push(report); });
        return report;
    }, readReport: async (_, id) => ({ text: reports.get(id), nextOffset: null }) };
    const calls = [];
    const sent = [];
    const published = [];
    const current = { team: "T1", users: ["U1", "U2"], channels: { C1: { agent: "assistant" } } };
    const config = async () => { await authorize?.(); return structuredClone(current); };
    const execute = async (task, signal) => {
        calls.push(task);
        const answer = await run?.(task, signal);
        return { answer: answer ?? (task.researchStage === "clarify" ? JSON.stringify(plan) :
            task.researchStage === "review" ? JSON.stringify({ verdict: "ready", feedback: [], gaps: [] }) :
                `${task.provider} ${task.researchStage} result`) };
    };
    const post = async (job, text) => { sent.push({ job, text }); await send?.(job, text); };
    let now = 100001;
    const service = createResearch({ state, execute, library, config, post, now: () => now,
        personal: async () => ({ owner: "U1" }) });
    service.attach({ publish: async (job) => { published.push(job); } });
    const job = () => Object.values(state.snapshot().researchJobs).at(-1);
    async function ready() {
        await service.propose(proposal, taskContext);
        await service.idle();
        assert.equal(job().status, "ready");
        return job();
    }
    return { service, state, calls, sent, published, current, config, post, job, ready,
        setTime: (value) => { now = value; } };
}

test("conversation routing", async () => {
    const f = fixture();
    await f.ready();
    const before = f.state.snapshot().researchJobs;
    const messages = ["진행중이야?", "이어서 진행", "기술 성능이 더 중요해", "!research Compare methods"];
    for (const text of messages) {
        assert.equal(await f.service.handle(context, text), false);
    }
    let woke = false;
    const handler = createMessageHandler({ state: f.state, research: f.service, config: f.config,
        bot: "BOT", post: f.post, runtime: { wake: () => { woke = true; } },
        profiles: async () => ({ assistant: { name: "Assistant", delegates: [], skills: [] } }),
        skills: async () => ({}),
    });
    await handler.handle({ body: { team_id: context.team }, event: {
        channel: context.channel, user: context.user, ts: "101.001", thread_ts: context.thread,
        text: "<@BOT> 진행중이야?",
    } });
    assert.equal(woke, true);
    assert.deepEqual(f.state.snapshot().researchJobs, before);
    assert.equal(f.calls.length, 0);
});

test("live progress", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const started = deferred();
    const f = fixture(async (_, signal) => {
        started.resolve();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    });
    const job = await f.ready();
    await f.service.control(job.id, "start", undefined, context);
    await started.promise;
    await new Promise(setImmediate);
    f.published.length = 0;
    t.mock.timers.tick(15000);
    await new Promise(setImmediate);
    assert.equal(f.published.length, 1);
    assert.equal(f.published[0].status, "running");
    await f.service.control(job.id, "pause", undefined, context);
    await f.service.idle();
    f.published.length = 0;
    t.mock.timers.tick(60000);
    await new Promise(setImmediate);
    assert.equal(f.published.length, 0);
});

test("research lifecycle", async () => {
    const started = { codex: deferred(), claude: deferred() };
    const release = deferred();
    const f = fixture(async (task) => {
        if (["explore", "counter"].includes(task.researchStage)) {
            started[task.provider].resolve();
            await release.promise;
        }
    });
    const initial = await f.ready();
    assert.deepEqual(f.calls, []);
    await f.service.control(initial.id, "start", undefined, { ...context, revision: initial.revision });
    await Promise.all([started.codex.promise, started.claude.promise]);
    assert.equal(f.job().status, "running");
    assert.equal(f.calls.some((task) => task.researchStage === "synthesize"), false);
    release.resolve();
    await f.service.idle();
    assert.deepEqual(f.calls.map((task) => task.researchStage),
        ["explore", "counter", "synthesize", "review"]);
    for (const task of f.calls.filter((item) => ["explore", "counter"].includes(item.researchStage))) {
        assert.ok(JSON.parse(task.prompt).reports.every((report) => report.provider === task.provider));
    }
    const synthesis = JSON.parse(f.calls.find((task) => task.researchStage === "synthesize").prompt);
    assert.ok(synthesis.reports.some((report) => report.stage === "explore"));
    assert.ok(synthesis.reports.some((report) => report.stage === "counter"));
    assert.equal(f.job().status, "completed");
    assert.ok(f.job().finalReportId);
    assert.match(f.sent.at(-1).text, /synthesize result/);
});

test("start authorization", async () => {
    const f = fixture();
    const initial = await f.ready();
    await assert.rejects(f.service.control(initial.id, "start", undefined,
        { ...context, user: "U2", revision: initial.revision }), /not available/);
    const attempts = await Promise.allSettled([0, 1].map(() =>
        f.service.control(initial.id, "start", undefined, { ...context, revision: initial.revision })));
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    await f.service.idle();
    assert.equal(f.calls.filter((task) => task.researchStage === "explore").length, 1);
});

test("pause and resume", async () => {
    const started = { codex: deferred(), claude: deferred() };
    const aborted = [];
    let block = true;
    const f = fixture(async (task, signal) => {
        if (block && ["explore", "counter"].includes(task.researchStage)) {
            started[task.provider].resolve();
            await new Promise((resolve, reject) => signal.addEventListener("abort", () => {
                aborted.push(task.provider);
                reject(Error("Cancelled"));
            }, { once: true }));
        }
    });
    const initial = await f.ready();
    await f.state.update((data) => { data.researchSources.saved = { researchId: initial.id, text: "Evidence" }; });
    await f.service.control(initial.id, "start", undefined, context);
    await Promise.all([started.codex.promise, started.claude.promise]);
    await f.service.control(initial.id, "finish", undefined, context);
    await f.service.control(initial.id, "pause", undefined, context);
    await f.service.idle();
    assert.deepEqual(aborted.sort(), ["claude", "codex"]);
    assert.equal(f.job().status, "paused");
    assert.equal(f.state.snapshot().researchSources.saved.text, "Evidence");
    block = false;
    await f.service.control(initial.id, "resume", undefined, context);
    await f.service.idle();
    assert.equal(f.job().status, "completed");
    assert.equal(f.job().finishRequested, true);
});

test("concurrent chat", async () => {
    const hold = deferred();
    const started = deferred();
    const f = fixture(async (task) => {
        if (["explore", "counter"].includes(task.researchStage)) {
            started.resolve();
            await hold.promise;
        }
    });
    const initial = await f.ready();
    await f.service.control(initial.id, "start", undefined, context);
    await started.promise;
    let woke = false;
    const handler = createMessageHandler({ state: f.state, research: f.service, bot: "BOT", post: f.post,
        config: f.config, runtime: { pumping: false, wake: () => { woke = true; } },
        profiles: async () => ({ assistant: { name: "Assistant", delegates: [], skills: [] } }),
        skills: async () => ({}),
    });
    await handler.handle({ body: { team_id: "T1" },
        event: { user: "U1", channel: "C1", ts: "200.001", text: "<@BOT> Explain recursion" } });
    assert.equal(woke, true);
    assert.ok(Object.values(f.state.snapshot().tasks).some((task) =>
        !task.researchId && task.prompt === "Explain recursion"));
    assert.equal(f.job().status, "running");
    hold.resolve();
    await f.service.idle();
});

test("active scope", async () => {
    const hold = deferred();
    const started = deferred();
    const f = fixture(async (task) => {
        if (["explore", "counter"].includes(task.researchStage)) {
            started.resolve();
            await hold.promise;
        }
    });
    const initial = await f.ready();
    await f.service.control(initial.id, "start", undefined, context);
    await started.promise;
    const before = f.job();
    await assert.rejects(f.service.propose({ ...proposal, id: before.id, revision: before.revision,
        brief: "Include implementation cost" }, { ...taskContext, id: "task2", messageTs: "102.001" }));
    assert.equal(await f.service.handle(context, "Include implementation cost"), false);
    assert.deepEqual(f.job(), before);
    hold.resolve();
    await f.service.idle();
    const synthesis = f.calls.find((task) => task.researchStage === "synthesize");
    assert.equal(JSON.parse(synthesis.prompt).brief, plan.brief);
});

test("provider failure", async () => {
    const bothStarted = deferred();
    let cancelled = false;
    const f = fixture(async (task, signal) => {
        if (task.researchStage === "explore") {
            await bothStarted.promise;
            throw Error("Provider unavailable");
        }
        if (task.researchStage === "counter") {
            bothStarted.resolve();
            await new Promise((resolve, reject) => signal.addEventListener("abort", () => {
                cancelled = true;
                reject(Error("Sibling failed"));
            }, { once: true }));
        }
    });
    const initial = await f.ready();
    await f.service.control(initial.id, "start", undefined, context);
    await f.service.idle();
    assert.equal(cancelled, true);
    assert.equal(f.job().status, "failed");
    assert.equal(f.job().reports.some((report) => report.stage === "synthesize"), false);
});

test("message identity", async () => {
    const f = fixture();
    const messages = [];
    const client = { chat: {
        postMessage: async (value) => { messages.push({ method: "post", ...value }); return { ts: "101.001" }; },
        update: async (value) => { messages.push({ method: "update", ...value }); return {}; },
    } };
    f.service.attach(createResearchSlack({ client, state: f.state, config: f.config, control: f.service.control }));
    await f.service.propose({ ...proposal, questions: ["Which constraints apply?"] }, taskContext);
    assert.equal(f.job().status, "awaiting_input");
    assert.equal(messages[0].method, "post");
    assert.equal(messages[0].thread_ts, context.thread);
    assert.equal(f.job().messageTs, "101.001");
    assert.equal(f.job().sourceMessageTs, "100.001");
    assert.equal(f.calls.length, 0);
    await f.service.control(f.job().id, "reply", "Use the attached requirements",
        { ...context, messageTs: "102.001", fileIds: ["F123"] });
    await f.service.idle();
    assert.equal(f.job().status, "ready");
    assert.equal(f.job().messageTs, "101.001");
    assert.equal(f.job().sourceMessageTs, "102.001");
    assert.equal(f.calls[0].messageTs, "102.001");
    assert.equal(JSON.parse(f.calls[0].prompt).conversation.messageTs, "102.001");
    assert.deepEqual(f.job().fileIds, ["F123"]);
    assert.equal(messages.filter((item) => item.method === "post").length, 1);
    assert.ok(messages.filter((item) => item.method === "update").every((item) => item.ts === "101.001"));
});

test("stale delivery", async () => {
    const delivering = deferred();
    const release = deferred();
    const f = fixture(undefined, async (job) => {
        if (job.status !== "completed") return;
        delivering.resolve();
        await release.promise;
        throw Error("Delivery failed");
    });
    const initial = await f.ready();
    await f.service.control(initial.id, "start", undefined, context);
    await delivering.promise;
    const completedRun = f.job().runId;
    await f.service.control(initial.id, "more", "Compare deployment costs", context);
    assert.notEqual(f.job().runId, completedRun);
    release.resolve();
    await f.service.idle();
    assert.equal(f.job().status, "ready");
    assert.equal(f.job().error, "");
    assert.equal(f.job().request, "Compare deployment costs");
    assert.equal(f.job().parentId, initial.id);
    assert.equal(f.state.snapshot().researchJobs[initial.id].status, "completed");
});

test("later confirmation", async () => {
    const f = fixture();
    const initial = await f.ready();
    const action = { id: initial.id, revision: initial.revision, action: "start" };
    for (const candidate of [taskContext, { ...taskContext, id: "task2" },
        { ...taskContext, id: "task2", messageTs: "99.999999" }]) {
        await assert.rejects(f.service.act(action, candidate));
        assert.equal(f.job().status, "ready");
    }
    await f.service.act(action, { ...taskContext, id: "task2", messageTs: "101.001" });
    await f.service.idle();
    assert.equal(f.job().status, "completed");
    assert.equal(f.job().confirmedPlans.length, 1);
    assert.equal(f.job().confirmedPlans[0].brief, plan.brief);
});

test("proposal retries", async () => {
    const f = fixture();
    const initial = await f.ready();
    const retry = await f.service.propose(proposal, taskContext);
    assert.equal(retry.id, initial.id);
    assert.equal(retry.revision, initial.revision);
    const unchanged = await f.service.propose({ ...proposal, id: initial.id, revision: initial.revision },
        { ...taskContext, id: "task2", messageTs: "101.001" });
    assert.equal(unchanged.revision, initial.revision);
    const updated = await f.service.propose({ ...proposal, id: initial.id, revision: initial.revision,
        brief: "Measure latency and memory" }, { ...taskContext, id: "task2", messageTs: "101.001" });
    assert.equal(updated.revision, initial.revision + 1);
    await assert.rejects(f.service.propose({ ...proposal, id: initial.id, revision: initial.revision }, taskContext));
    await assert.rejects(f.service.act({ id: initial.id, revision: initial.revision, action: "start" },
        { ...taskContext, id: "task3", messageTs: "102.001" }));
    assert.equal(f.job().brief, "Measure latency and memory");
    assert.equal(Object.keys(f.state.snapshot().researchJobs).length, 1);
});

test("revised confirmation", async () => {
    const started = deferred();
    let block = true;
    const f = fixture(async (task, signal) => {
        if (block && ["explore", "counter"].includes(task.researchStage)) {
            started.resolve();
            await new Promise((resolve, reject) => signal.addEventListener("abort",
                () => reject(Error("Cancelled")), { once: true }));
        }
    });
    const initial = await f.ready();
    await f.service.control(initial.id, "start", undefined, context);
    await started.promise;
    await f.service.control(initial.id, "pause", undefined, context);
    await f.service.idle();
    const original = f.job().confirmedPlans[0];
    const revisedContext = { ...taskContext, id: "task2", messageTs: "102.001" };
    const revised = await f.service.propose({ ...proposal, id: initial.id, revision: f.job().revision,
        brief: "Prioritize latency and memory" }, revisedContext);
    assert.equal(revised.status, "ready");
    assert.deepEqual(f.job().confirmedPlans, [original]);
    await assert.rejects(f.service.act({ id: revised.id, revision: revised.revision, action: "resume" },
        revisedContext));
    await assert.rejects(f.service.act({ id: revised.id, revision: revised.revision, action: "start" },
        revisedContext));
    block = false;
    await f.service.act({ id: revised.id, revision: revised.revision, action: "start" },
        { ...taskContext, id: "task3", messageTs: "103.001" });
    await f.service.idle();
    assert.equal(f.job().status, "completed");
    assert.deepEqual(f.job().confirmedPlans[0], original);
    assert.equal(f.job().confirmedPlans[1].brief, "Prioritize latency and memory");
});

test("followup rounds", async () => {
    const f = fixture();
    const initial = await f.ready();
    await f.service.control(initial.id, "start", undefined, context);
    await f.service.idle();
    const completed = f.job();
    await f.state.update((data) => { data.researchSources.saved = { researchId: completed.id }; });
    const next = await f.service.propose({ ...proposal, parentId: completed.id, brief: "Compare deployment costs" },
        { ...taskContext, id: "task2", messageTs: "102.001" });
    assert.notEqual(next.id, completed.id);
    assert.equal(next.round, 2);
    assert.equal(next.parentId, completed.id);
    assert.equal(next.progress.sources, 0);
    assert.equal(next.progress.reports, 0);
    assert.deepEqual(f.state.snapshot().researchJobs[completed.id], completed);
    const status = await f.service.inspect(taskContext);
    assert.equal(status.latestId, next.id);
    assert.equal(status.rounds.length, 2);
    const result = await f.service.readResult({ id: completed.id }, taskContext);
    assert.equal(result.complete, true);
    assert.match(result.report.text, /synthesize result/);
    assert.equal((await f.service.readResult({ id: next.id }, taskContext)).available, false);
});

test("read authorization", async () => {
    const f = fixture();
    const initial = await f.ready();
    for (const other of [{ ...taskContext, user: "U2" }, { ...taskContext, channel: "C2" },
        { ...taskContext, thread: "200.001", key: "T1:C1:200.001:assistant" }]) {
        await assert.rejects(f.service.readResult({ id: initial.id }, other));
    }
    await assert.rejects(f.service.inspect({ ...taskContext, user: "U2" }));
    assert.equal((await f.service.inspect({ ...taskContext, thread: "200.001",
        key: "T1:C1:200.001:assistant" })).rounds.length, 0);
});

test("confirmation boundary", async () => {
    const f = fixture(async (task) => {
        if (task.researchStage === "clarify") f.setTime(110001);
    });
    const initial = await f.ready();
    f.setTime(105001);
    await f.service.control(initial.id, "edit", "Prioritize latency", { ...context, revision: initial.revision });
    await f.service.idle();
    const revised = f.job();
    const action = { id: revised.id, revision: revised.revision, action: "start" };
    for (const messageTs of ["104.001", "106.001", "110.001"]) {
        await assert.rejects(f.service.act(action, { ...taskContext, id: "task2", messageTs }));
    }
    assert.equal(f.job().status, "ready");
    await f.service.act(action, { ...taskContext, id: "task3", messageTs: "111.001" });
    await f.service.idle();
    assert.equal(f.job().status, "completed");
});

test("export scope", async () => {
    const f = fixture();
    const initial = await f.ready();
    await f.service.control(initial.id, "start", undefined, context);
    await f.service.idle();
    await f.state.update((data) => {
        Object.assign(data.researchJobs[initial.id], { status: "paused", mode: "canvas" });
    });
    const before = f.job();
    await assert.rejects(f.service.propose({ ...proposal, id: initial.id, revision: before.revision,
        brief: "Changed plan" }, { ...taskContext, id: "task2" }));
    await assert.rejects(f.service.control(initial.id, "edit", "Changed plan", context));
    assert.deepEqual(f.job(), before);
});

test("closed mutations", async () => {
    const f = fixture();
    const initial = await f.ready();
    await f.service.stop();
    await assert.rejects(f.service.propose({ ...proposal, id: initial.id, revision: initial.revision,
        brief: "Changed scope" }, taskContext));
    await assert.rejects(f.service.control(initial.id, "start", undefined, context));
    assert.equal(f.calls.length, 0);
});

test("cancelled rounds", async () => {
    for (const status of ["ready", "awaiting_input", "paused", "interrupted", "failed"]) {
        const f = fixture();
        const initial = await f.ready();
        await f.state.update((data) => {
            Object.assign(data.researchJobs[initial.id], { status, questions: ["Which device?"],
                error: "Resume to retry" });
        });
        const cancelled = await f.service.act({ id: initial.id, revision: initial.revision, action: "cancel" },
            taskContext);
        assert.equal(cancelled.status, "cancelled");
        assert.deepEqual(cancelled.actions, []);
        assert.deepEqual(cancelled.questions, []);
        assert.equal(cancelled.error, "");
        await assert.rejects(f.service.control(initial.id, "resume", undefined, context));
        const replacement = await f.service.propose({ ...proposal, brief: "New topic" }, taskContext);
        assert.notEqual(replacement.id, initial.id);
        assert.equal(replacement.status, "ready");
    }
});

test("running cancellation", async () => {
    const started = deferred();
    const f = fixture(async (task, signal) => {
        if (!["explore", "counter"].includes(task.researchStage)) return;
        started.resolve();
        await new Promise((resolve, reject) => signal.addEventListener("abort",
            () => reject(signal.reason), { once: true }));
    });
    const initial = await f.ready();
    await f.service.control(initial.id, "start", undefined, context);
    await started.promise;
    await f.service.control(initial.id, "cancel", undefined, context);
    await f.service.idle();
    assert.equal(f.job().status, "cancelled");
    assert.ok(Object.values(f.state.snapshot().tasks).every((task) => task.status === "cancelled"));
    assert.equal(f.calls.some((task) => task.researchStage === "synthesize"), false);
});

test("export pause", async () => {
    const started = deferred();
    const f = fixture(async (task, signal) => {
        if (task.researchStage !== "canvas") return;
        started.resolve();
        await new Promise((resolve, reject) => signal.addEventListener("abort",
            () => reject(signal.reason), { once: true }));
    });
    const initial = await f.ready();
    await f.service.control(initial.id, "start", undefined, context);
    await f.service.idle();
    const finalReportId = f.job().finalReportId;
    await f.service.control(initial.id, "canvas", undefined, context);
    await started.promise;
    const exportRun = f.job().runId;
    await f.service.control(initial.id, "pause", undefined, context);
    assert.equal(f.job().status, "completed");
    assert.equal(f.job().finalReportId, finalReportId);
    assert.notEqual(f.job().runId, exportRun);
    const next = await f.service.propose({ ...proposal, parentId: initial.id },
        { ...taskContext, id: "task2" });
    await f.service.idle();
    assert.equal(next.parentId, initial.id);
    assert.equal(f.state.snapshot().researchJobs[initial.id].status, "completed");
});

test("export recovery", async () => {
    for (const status of ["paused", "interrupted", "failed", "queued", "running"]) {
        const f = fixture();
        const initial = await f.ready();
        await f.service.control(initial.id, "start", undefined, context);
        await f.service.idle();
        await f.state.update((data) => {
            Object.assign(data.researchJobs[initial.id], { status, mode: "canvas", canvasBusy: true });
        });
        await f.service.recover();
        assert.equal(f.job().status, "completed");
        assert.equal(f.job().canvasBusy, false);
        assert.deepEqual((await f.service.inspect(taskContext)).rounds[0].actions, ["more", "canvas"]);
        const next = await f.service.propose({ ...proposal, parentId: initial.id },
            { ...taskContext, id: "task2" });
        assert.equal(next.parentId, initial.id);
    }
});

test("authorization cancellation", async () => {
    for (const action of ["propose", "start"]) {
        const entered = deferred();
        const release = deferred();
        let block = false;
        const f = fixture(undefined, undefined, async () => {
            if (block) { entered.resolve(); await release.promise; }
        });
        const initial = await f.ready();
        const before = f.state.snapshot().researchJobs;
        const controller = new AbortController();
        block = true;
        const pending = action === "propose" ? f.service.propose({ ...proposal, id: initial.id,
            revision: initial.revision, brief: "Changed scope" }, taskContext, controller.signal) :
            f.service.act({ id: initial.id, revision: initial.revision, action },
                { ...taskContext, id: "task2", messageTs: "101.001" }, controller.signal);
        await entered.promise;
        controller.abort();
        release.resolve();
        await assert.rejects(pending, { name: "AbortError" });
        await f.service.idle();
        assert.deepEqual(f.state.snapshot().researchJobs, before);
        assert.equal(f.calls.length, 0);
    }
});

test("queued cancellation", async () => {
    const f = fixture();
    const initial = await f.ready();
    const before = f.state.snapshot().researchJobs;
    const controller = new AbortController();
    const update = f.state.update;
    f.state.update = (mutate) => update((data) => { controller.abort(); return mutate(data); });
    await assert.rejects(f.service.act({ id: initial.id, revision: initial.revision, action: "start" },
        { ...taskContext, id: "task2", messageTs: "101.001" }, controller.signal), { name: "AbortError" });
    assert.deepEqual(f.state.snapshot().researchJobs, before);
    assert.equal(f.calls.length, 0);
});
