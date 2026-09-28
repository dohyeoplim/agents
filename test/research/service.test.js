import test from "node:test";
import assert from "node:assert/strict";
import { createResearch } from "../../src/research/service.js";
import { createMessageHandler } from "../../src/slack/messages.js";
import { createResearchSlack } from "../../src/research/slack.js";

const context = { team: "T1", user: "U1", channel: "C1", thread: "100.001",
    key: "T1:C1:100.001:assistant", profile: "assistant", messageTs: "100.001" };
const plan = { ready: true, title: "Methods", brief: "Compare methods and limitations", questions: [] };
const deferred = () => Promise.withResolvers();

function fixture(run, send) {
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
    const config = async () => structuredClone(current);
    const execute = async (task, signal) => {
        calls.push(task);
        const answer = await run?.(task, signal);
        return { answer: answer ?? (task.researchStage === "clarify" ? JSON.stringify(plan) :
            task.researchStage === "review" ? JSON.stringify({ verdict: "ready", feedback: [], gaps: [] }) :
                `${task.provider} ${task.researchStage} result`) };
    };
    const post = async (job, text) => { sent.push({ job, text }); await send?.(job, text); };
    const service = createResearch({ state, execute, library, config, post, personal: async () => ({ owner: "U1" }) });
    service.attach({ publish: async (job) => { published.push(job); } });
    const job = () => Object.values(state.snapshot().researchJobs)[0];
    async function ready() {
        assert.equal(await service.handle(context, "!research Compare methods", "event1"), true);
        await service.idle();
        assert.equal(job().status, "ready");
        return job();
    }
    return { service, state, calls, sent, published, current, config, post, job, ready };
}

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
    assert.deepEqual(f.calls.map((task) => task.researchStage), ["clarify"]);
    await f.service.control(initial.id, "start", undefined, { ...context, revision: initial.revision });
    await Promise.all([started.codex.promise, started.claude.promise]);
    assert.equal(f.job().status, "running");
    assert.equal(f.calls.some((task) => task.researchStage === "synthesize"), false);
    release.resolve();
    await f.service.idle();
    assert.deepEqual(f.calls.map((task) => task.researchStage),
        ["clarify", "explore", "counter", "synthesize", "review"]);
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
    await f.service.control(initial.id, "pause", undefined, context);
    await f.service.idle();
    assert.deepEqual(aborted.sort(), ["claude", "codex"]);
    assert.equal(f.job().status, "paused");
    assert.equal(f.state.snapshot().researchSources.saved.text, "Evidence");
    block = false;
    await f.service.control(initial.id, "resume", undefined, context);
    await f.service.idle();
    assert.equal(f.job().status, "completed");
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

test("research steering", async () => {
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
    await f.service.handle(context, "Include implementation cost", "event2");
    hold.resolve();
    await f.service.idle();
    const synthesis = f.calls.find((task) => task.researchStage === "synthesize");
    assert.deepEqual(JSON.parse(synthesis.prompt).updates, ["Include implementation cost"]);
});

test("clarification steering", async () => {
    const started = deferred();
    const release = deferred();
    let attempts = 0;
    const f = fixture(async (task) => {
        if (task.researchStage !== "clarify") return;
        attempts++;
        if (attempts === 1) {
            started.resolve();
            await release.promise;
            return JSON.stringify(plan);
        }
        assert.deepEqual(JSON.parse(task.prompt).updates, ["Only open-source methods"]);
        return JSON.stringify({ ...plan, brief: "Compare only open-source methods" });
    });
    await f.service.handle(context, "!research Compare methods", "event1");
    await started.promise;
    await f.service.handle(context, "Only open-source methods", "event2");
    release.resolve();
    await f.service.idle();
    assert.equal(attempts, 2);
    assert.equal(f.job().brief, "Compare only open-source methods");
    assert.equal(f.job().status, "ready");
    assert.equal(f.published.some((job) => job.status === "ready" && job.brief === plan.brief), false);
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
    assert.ok(f.job().reports.some((report) => report.stage === "clarify"));
});

test("status message identity", async () => {
    let clarifications = 0;
    const f = fixture(async (task) => {
        if (task.researchStage !== "clarify") return;
        return JSON.stringify(++clarifications === 1 ?
            { ...plan, ready: false, questions: ["Which constraints apply?"] } : plan);
    });
    const messages = [];
    const client = { chat: {
        postMessage: async (value) => { messages.push({ method: "post", ...value }); return { ts: "101.001" }; },
        update: async (value) => { messages.push({ method: "update", ...value }); return {}; },
    } };
    f.service.attach(createResearchSlack({ client, state: f.state, config: f.config, control: f.service.control }));
    await f.service.handle(context, "!research Compare methods", "event1");
    await f.service.idle();
    assert.equal(f.job().status, "awaiting_input");
    assert.equal(messages[0].method, "post");
    assert.equal(messages[0].thread_ts, context.thread);
    assert.equal(f.job().messageTs, "101.001");
    assert.equal(f.job().sourceMessageTs, "100.001");

    await f.service.handle({ ...context, messageTs: "102.001", fileIds: ["F123"] },
        "Use the attached requirements", "event2");
    await f.service.idle();
    assert.equal(f.job().status, "ready");
    assert.equal(f.job().messageTs, "101.001");
    assert.equal(f.job().sourceMessageTs, "102.001");
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
    assert.deepEqual(f.job().answers, ["Compare deployment costs"]);
});
