import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentState } from "../../src/shared/state.js";
import { createArtifactStore } from "../../src/storage/artifacts.js";
import { createResearchLibrary } from "../../src/research/library.js";
import { createResearchEngine, researchOutput } from "../../src/research/engine.js";

async function fixture(t, execute, canvases, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), "research-engine-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const job = { id: "job", team: "T", user: "U", channel: "C", thread: "1.000001", key: "thread",
        profile: "assistant", status: "running", runId: "run", revision: 0, title: "Research", request: "Compare" };
    const state = new PersistentState(join(directory, "state.json"), { researchJobs: { job }, tasks: {} });
    const library = createResearchLibrary({ state,
        artifacts: createArtifactStore({ directory: join(directory, "artifacts") }) });
    const calls = [];
    const posts = [];
    const engine = createResearchEngine({ state, library, canvases, publish: async () => {}, ...options,
        post: async (job, text) => { posts.push({ job, text }); },
        execute: async (task, signal) => {
            calls.push(task);
            return { answer: await execute(task, { state, library, calls, signal }), session: "session" };
        } });
    return { state, library, engine, job, calls, posts };
}

const ready = JSON.stringify({ verdict: "ready", feedback: [], gaps: [] });
const signal = () => new AbortController().signal;

async function resume(state, overrides = {}) {
    await state.update((data) => {
        Object.assign(data.researchJobs.job, { status: "running", runId: "resumed", ...overrides });
    });
    return state.snapshot().researchJobs.job;
}

test("output validation", () => {
    assert.equal(researchOutput('```json\n{"verdict":"ready","feedback":[],"gaps":[]}\n```', "review")
        .verdict, "ready");
    const plan = { ready: true, title: "Plan", brief: "Scope", questions: [] };
    assert.equal(researchOutput(JSON.stringify(plan), "clarify").ready, true);
    for (const value of [{ ...plan, questions: ["Why?"] }, { ...plan, ready: false },
        { ...plan, unexpected: true }]) {
        assert.throws(() => researchOutput(JSON.stringify(value), "clarify"), /Invalid clarify/);
    }
    assert.throws(() => researchOutput("not JSON", "review"), /Invalid review/);
    assert.throws(() => researchOutput('{"verdict":"complete"}', "review"), /Invalid review/);
});

test("independent reports", async (t) => {
    let release;
    const started = new Set();
    const barrier = new Promise((resolve) => { release = resolve; });
    const fixtureValue = await fixture(t, async (task) => {
        if (["explore", "counter"].includes(task.researchStage)) {
            started.add(task.provider);
            if (started.size === 2) release();
            await barrier;
            const prompt = JSON.parse(task.prompt);
            assert.ok(prompt.reports.every((report) => report.provider === task.provider));
        }
        if (task.researchStage === "synthesize") {
            const stages = JSON.parse(task.prompt).reports.map((report) => report.stage);
            assert.ok(stages.includes("explore"));
            assert.ok(stages.includes("counter"));
        }
        return task.researchStage === "review" ? ready : `${task.provider} ${task.researchStage}`;
    });
    const { engine, job, library, state, calls, posts } = fixtureValue;
    await library.saveReport(job, "counter", "Prior Claude report", { provider: "claude" });
    await library.saveReport(job, "explore", "Prior Codex report", { provider: "codex" });
    await engine.run(job, signal());
    assert.deepEqual(calls.map((task) => task.researchStage), ["explore", "counter", "synthesize", "review"]);
    assert.equal(state.snapshot().researchJobs.job.status, "completed");
    assert.equal(posts.length, 1);
});

test("partial failure", async (t) => {
    const { engine, job, state, calls, posts } = await fixture(t, async (task) => {
        if (task.researchStage === "counter") throw Error("Provider offline");
        return "Saved Codex research";
    });
    await assert.rejects(engine.run(job, signal()), { code: "PROVIDER_FAILED", provider: "claude" });
    assert.deepEqual(calls.map((task) => task.researchStage), ["explore", "counter"]);
    const current = state.snapshot().researchJobs.job;
    assert.notEqual(current.status, "completed");
    assert.equal(current.reports.length, 1);
    assert.equal(current.reports[0].provider, "codex");
    assert.equal(posts.length, 0);
});

test("invalid clarification", async (t) => {
    const { engine, job, state } = await fixture(t, async () => "I think it is ready");
    await state.update((data) => { data.researchJobs.job.status = "clarifying"; });
    await assert.rejects(engine.clarify(job, signal()), /Invalid clarify/);
    assert.notEqual(state.snapshot().researchJobs.job.status, "ready");
});

test("evidence exhaustion", async (t) => {
    const { engine, job, calls, state } = await fixture(t, async (task, { calls }) => {
        if (calls.filter((call) => call.researchStage === "explore").length > 1) {
            throw Error("Repeated investigation without new evidence");
        }
        return task.researchStage === "review" ? JSON.stringify({ verdict: "needs_research",
            feedback: ["Explain limitations"], gaps: ["Missing experiment"] }) : "Available evidence";
    });
    await engine.run(job, signal());
    assert.equal(calls.filter((task) => task.researchStage === "explore").length, 1);
    assert.equal(calls.at(-1).researchStage, "revise");
    assert.equal(state.snapshot().researchJobs.job.status, "completed");
});

test("duplicate evidence", async (t) => {
    let pass = 0;
    const { engine, job, state } = await fixture(t, async (task, { library }) => {
        if (task.researchStage === "explore") {
            pass++;
            if (pass > 2) throw Error("Identical source treated as progress");
            await library.save({ title: "Paper", url: "https://example.com/paper", text: "Original evidence",
                coverage: "excerpt", claim: "Claim wording " + pass }, task);
        }
        if (task.researchStage === "review") {
            return JSON.stringify({ verdict: "needs_research", feedback: [], gaps: ["Gap wording " + pass] });
        }
        return "Findings";
    });
    await engine.run(job, signal());
    assert.equal(pass, 2);
    assert.equal(state.snapshot().researchJobs.job.status, "completed");
});

test("alternating gaps", async (t) => {
    let pass = 0;
    const { engine, job, state } = await fixture(t, async (task, { library }) => {
        if (task.researchStage === "explore") {
            if (++pass > 4) throw Error("Research cycle repeated");
            await library.save({ title: "Paper " + pass, url: "https://example.com/" + pass,
                text: "Evidence " + pass, coverage: "excerpt" }, task);
        }
        return task.researchStage === "review" ? JSON.stringify({ verdict: "needs_research", feedback: [],
            gaps: [pass % 2 ? "  Measure   LATENCY " : "Measure accuracy"] }) : "Findings";
    });
    await engine.run(job, signal());
    assert.equal(pass, 4);
    assert.equal(state.snapshot().researchJobs.job.checkpoint.gapRegistry.length, 2);
    assert.equal(state.snapshot().researchJobs.job.status, "limited");
});

test("durable convergence", async (t) => {
    let pass = 0;
    let fail = true;
    const f = await fixture(t, async (task, { library }) => {
        if (task.researchStage === "explore") {
            if (++pass > 4) throw Error("Research cycle repeated after resume");
            await library.save({ title: "Paper " + pass, url: "https://example.com/" + pass,
                text: "Evidence " + pass, coverage: "excerpt" }, task);
        }
        if (task.researchStage === "review") {
            if (pass === 3 && fail) throw Error("Provider unavailable");
            return JSON.stringify({ verdict: "needs_research", feedback: [],
                gaps: [pass % 2 ? "Measure latency" : "Measure accuracy"] });
        }
        return "Findings";
    });
    await assert.rejects(f.engine.run(f.job, signal()), { code: "PROVIDER_FAILED", provider: "claude" });
    fail = false;
    await f.engine.run(await resume(f.state), signal());
    assert.equal(pass, 4);
    assert.equal(f.state.snapshot().researchJobs.job.status, "limited");
    assert.equal(f.state.snapshot().researchJobs.job.executionBudget.cycles, 3);
});

test("new gap progress", async (t) => {
    let pass = 0;
    const { engine, job, state, calls } = await fixture(t, async (task, { library }) => {
        if (task.researchStage === "explore") {
            pass++;
            await library.save({ title: "Paper " + pass, url: "https://example.com/" + pass,
                text: "Evidence " + pass, coverage: "excerpt" }, task);
        }
        return task.researchStage === "review" ? pass > 4 ? ready : JSON.stringify({
            verdict: "needs_research", feedback: [], gaps: ["Gap 1", "Gap " + pass],
        }) : "Findings";
    });
    await engine.run(job, signal());
    assert.equal(pass, 4);
    const exploration = calls.filter((task) => task.researchStage === "explore").at(-1);
    assert.deepEqual(JSON.parse(exploration.prompt).gaps, ["Gap 1", "Gap 3"]);
    assert.equal(state.snapshot().researchJobs.job.status, "limited");
});

test("paraphrase limit", async (t) => {
    let pass = 0;
    const f = await fixture(t, async (task, { library }) => {
        if (task.researchStage === "explore") {
            pass++;
            await library.save({ title: `Paper ${pass}`, url: `https://example.com/${pass}`,
                text: `Evidence ${pass}`, coverage: "excerpt" }, task);
        }
        return task.researchStage === "review" ? JSON.stringify({ verdict: "needs_research", feedback: [],
            gaps: [`Latency evidence rephrased ${pass}`], gapIds: [null] }) : "Findings";
    });
    await f.engine.run(f.job, signal());
    const limited = f.state.snapshot().researchJobs.job;
    assert.equal(pass, 4);
    assert.equal(limited.limitReason, "cycles");
    assert.equal(limited.status, "limited");
    assert.ok(limited.checkpoint.reports.synthesize);
    assert.ok(limited.checkpoint.reports.review);
    const count = f.calls.length;
    await f.engine.run(await resume(f.state), signal());
    assert.equal(f.calls.length, count);
    assert.equal(f.state.snapshot().researchJobs.job.status, "limited");
    await f.state.update((data) => { delete data.researchJobs.job.executionBudget; });
    await f.engine.run(await resume(f.state, { finishRequested: true }), signal());
    assert.deepEqual(f.calls.slice(count).map((task) => task.researchStage), ["revise"]);
    assert.equal(f.state.snapshot().researchJobs.job.status, "completed");
});

test("active deadline", { timeout: 2000 }, async (t) => {
    const guard = setTimeout(() => {}, 1500);
    t.after(() => clearTimeout(guard));
    const f = await fixture(t, async (task, { signal }) => {
        await new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            if (signal.aborted) reject(signal.reason);
        });
    }, undefined, { limits: { maxCycles: 3, maxDurationMs: 30 } });
    await f.engine.run(f.job, signal());
    const current = f.state.snapshot().researchJobs.job;
    assert.equal(current.status, "limited");
    assert.equal(current.limitReason, "time");
    assert.ok(Object.values(f.state.snapshot().tasks).every((task) => task.status === "cancelled"));
    assert.equal(current.executionBudget.activeSince, null);
});

test("legacy gap tracking", async (t) => {
    const f = await fixture(t, async (task) => {
        if (task.researchStage === "review") {
            assert.deepEqual(JSON.parse(task.prompt).knownGaps, [{ id: "g1", text: "Measure latency" }]);
            return ready;
        }
        return "Findings";
    });
    await f.state.update((data) => {
        data.researchJobs.job.checkpoint = { version: 0, reports: {}, gaps: [], feedback: [],
            seenGaps: ["Measure latency"], sourcesBefore: 0 };
    });
    await f.engine.run(f.job, signal());
    assert.equal(f.state.snapshot().researchJobs.job.status, "completed");
});

test("Canvas export", async (t) => {
    const full = "Long findings\n".repeat(2500);
    const saved = [];
    const canvases = {
        create: async ({ markdown }) => {
            saved.push(markdown);
            return { canvasId: "F123456", url: "https://example.slack.com/docs/T1/F123456" };
        },
        read: async () => ({ readId: "receipt", revision: "initial" }),
        update: async ({ markdown }) => {
            saved.push(markdown);
            return { status: "applied", after: { revision: "updated" } };
        },
    };
    const { engine, job, library, state, posts, calls } = await fixture(t,
        async (task) => task.researchStage === "review" ? ready : full, canvases);
    await engine.run(job, signal());
    const completed = state.snapshot().researchJobs.job;
    assert.ok(posts[0].text.length < full.length);
    let text = "";
    let offset = 0;
    do {
        const page = await library.readReport(completed, completed.finalReportId, offset);
        text += page.text;
        offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(text, full);
    await state.update((data) => { data.researchJobs.job.status = "running"; });
    const before = calls.length;
    await engine.canvas(state.snapshot().researchJobs.job, signal());
    assert.equal(calls.length, before);
    assert.equal(saved.join(""), full);
    assert.match(posts.at(-1).text, /https:\/\/example.slack.com\/docs\/T1\/F123456/);
});

test("stale results", async (t) => {
    const { engine, job, state } = await fixture(t, async (task, { state }) => {
        if (task.researchStage === "explore") {
            await state.update((data) => { data.researchJobs.job.runId = "replacement"; });
        }
        return "Obsolete result";
    });
    await assert.rejects(engine.run(job, signal()));
    assert.equal(state.snapshot().researchJobs.job.runId, "replacement");
    assert.equal(state.snapshot().researchJobs.job.reports?.length || 0, 0);
});

test("parent assignment", async (t) => {
    const { engine, job, state, library, calls } = await fixture(t, async (task, { state }) => {
        assert.ok(state.snapshot().researchJobs.job.phaseStartedAt > 0);
        const prompt = JSON.parse(task.prompt);
        assert.equal(prompt.parentId, "parent");
        assert.equal(prompt.previousRound.brief, "Original scope");
        assert.ok(prompt.previousRound.finalReportId);
        return task.researchStage === "review" ? ready : "New report";
    });
    await state.update((data) => {
        data.researchJobs.parent = { ...job, id: "parent", brief: "Original scope" };
        data.researchJobs.job.parentId = "parent";
    });
    const parent = state.snapshot().researchJobs.parent;
    const final = await library.saveReport(parent, "synthesize", "Original final");
    await state.update((data) => {
        Object.assign(data.researchJobs.parent, { status: "completed", finalReportId: final.id });
    });
    for (let index = 0; index < 14; index++) {
        await library.saveReport(job, "explore", "Prior attempt " + index);
    }
    await engine.run(state.snapshot().researchJobs.job, signal());
    assert.equal(JSON.parse(calls[0].prompt).reports.length, 12);
    for (const task of calls) assert.equal(JSON.parse(task.prompt).previousRound.finalReportId, final.id);
    assert.equal(state.snapshot().researchJobs.parent.finalReportId, final.id);
});

test("review resumption", async (t) => {
    let fail = true;
    const f = await fixture(t, async (task) => {
        if (task.researchStage === "review") {
            if (fail) throw Error("Review unavailable");
            return ready;
        }
        return task.researchStage + " findings";
    });
    await assert.rejects(f.engine.run(f.job, signal()), { code: "PROVIDER_FAILED", provider: "claude" });
    const checkpoint = f.state.snapshot().researchJobs.job.checkpoint;
    assert.deepEqual(Object.keys(checkpoint.reports).sort(), ["counter", "explore", "synthesize"]);
    const before = f.calls.length;
    fail = false;
    await f.engine.run(await resume(f.state), signal());
    assert.deepEqual(f.calls.slice(before).map((task) => task.researchStage), ["review"]);
    assert.equal(f.state.snapshot().researchJobs.job.finalReportId, checkpoint.reports.synthesize);
    assert.equal(f.state.snapshot().researchJobs.job.status, "completed");
});

test("revision resumption", async (t) => {
    let fail = true;
    const critique = JSON.stringify({ verdict: "revise", feedback: ["Clarify limits"], gaps: [] });
    const f = await fixture(t, async (task) => {
        if (task.researchStage === "review") return critique;
        if (task.researchStage === "revise" && fail) throw Error("Revision unavailable");
        return task.researchStage + " findings";
    });
    await assert.rejects(f.engine.run(f.job, signal()), { code: "PROVIDER_FAILED", provider: "codex" });
    const checkpoint = f.state.snapshot().researchJobs.job.checkpoint;
    const before = f.calls.length;
    fail = false;
    await f.engine.run(await resume(f.state), signal());
    assert.deepEqual(f.calls.slice(before).map((task) => task.researchStage), ["revise"]);
    const prompt = JSON.parse(f.calls.at(-1).prompt);
    assert.equal(prompt.draftReportId, checkpoint.reports.synthesize);
    assert.equal(prompt.reviewReportId, checkpoint.reports.review);
    assert.deepEqual(prompt.assessment.feedback, ["Clarify limits"]);
    assert.equal(f.posts.at(-1).text, "revise findings");
});

test("scope invalidation", async (t) => {
    let fail = true;
    const f = await fixture(t, async (task) => {
        if (task.researchStage === "review") {
            if (fail) throw Error("Review unavailable");
            return ready;
        }
        return "Findings";
    });
    await assert.rejects(f.engine.run(f.job, signal()));
    const original = f.state.snapshot().researchJobs.job.checkpoint.reports.synthesize;
    const before = f.calls.length;
    fail = false;
    await f.engine.run(await resume(f.state, { scopeVersion: 1, brief: "New scope" }), signal());
    const subsequent = f.calls.slice(before);
    assert.deepEqual(subsequent.map((task) => task.researchStage), ["explore", "counter", "synthesize", "review"]);
    assert.ok(subsequent.every((task) => JSON.parse(task.prompt).brief === "New scope"));
    assert.notEqual(f.state.snapshot().researchJobs.job.finalReportId, original);
    assert.equal(f.state.snapshot().researchJobs.job.checkpoint.version, 1);
});

test("malformed review", async (t) => {
    let malformed = true;
    const f = await fixture(t, async (task) => task.researchStage === "review" ?
        malformed ? "Unstructured feedback" : ready : "Findings");
    await assert.rejects(f.engine.run(f.job, signal()), /Invalid review/);
    assert.equal(f.state.snapshot().researchJobs.job.checkpoint.reports.review, undefined);
    const before = f.calls.length;
    malformed = false;
    await f.engine.run(await resume(f.state), signal());
    assert.deepEqual(f.calls.slice(before).map((task) => task.researchStage), ["review"]);
    assert.equal(f.state.snapshot().researchJobs.job.status, "completed");
});

test("cached pagination", async (t) => {
    const full = "Detailed findings\n".repeat(1000);
    let fail = true;
    const f = await fixture(t, async (task) => {
        if (task.researchStage === "review") {
            if (fail) throw Error("Review unavailable");
            return ready;
        }
        return task.researchStage === "synthesize" ? full : "Evidence";
    });
    await assert.rejects(f.engine.run(f.job, signal()));
    const draftId = f.state.snapshot().researchJobs.job.checkpoint.reports.synthesize;
    const firstPage = await f.library.readReport(f.state.snapshot().researchJobs.job, draftId);
    assert.ok(firstPage.nextOffset > 0);
    assert.ok(firstPage.text.length < full.length);
    fail = false;
    await f.engine.run(await resume(f.state), signal());
    assert.equal(f.posts.at(-1).text, full);
    assert.equal(f.calls.filter((task) => task.researchStage === "synthesize").length, 1);
});

test("partial resumption", async (t) => {
    const saved = Promise.withResolvers();
    let fail = true;
    const f = await fixture(t, async (task) => {
        if (task.researchStage === "counter" && fail) {
            await saved.promise;
            throw Error("Counter unavailable");
        }
        return task.researchStage === "review" ? ready : "Durable evidence";
    });
    const update = f.state.update.bind(f.state);
    f.state.update = async (change) => {
        const result = await update(change);
        if (f.state.snapshot().researchJobs.job.checkpoint?.reports.explore) saved.resolve();
        return result;
    };
    await assert.rejects(f.engine.run(f.job, signal()), { code: "PROVIDER_FAILED", provider: "claude" });
    const before = f.calls.length;
    const explored = f.state.snapshot().researchJobs.job.checkpoint.reports.explore;
    fail = false;
    await f.engine.run(await resume(f.state), signal());
    assert.deepEqual(f.calls.slice(before).map((task) => task.researchStage), ["counter", "synthesize", "review"]);
    assert.equal(f.state.snapshot().researchJobs.job.checkpoint.reports.explore, explored);
    assert.equal(f.state.snapshot().researchJobs.job.status, "completed");
});

test("investigation resumption", async (t) => {
    const saved = Promise.withResolvers();
    const gaps = ["Missing latency measurement"];
    const feedback = ["Compare device constraints"];
    let explorations = 0;
    let counters = 0;
    let syntheses = 0;
    let reviews = 0;
    const f = await fixture(t, async (task, { library }) => {
        if (task.researchStage === "explore") {
            explorations++;
            await library.save({ title: "Measurement " + explorations,
                url: "https://example.com/measurement/" + explorations, text: "Evidence " + explorations,
                coverage: "excerpt", claim: "Measured latency" }, task);
        }
        if (task.researchStage === "counter" && ++counters === 2) {
            await saved.promise;
            throw Error("Counter unavailable");
        }
        if (task.researchStage === "synthesize") return "Synthesis " + ++syntheses;
        if (task.researchStage === "review") {
            return ++reviews === 1 ? JSON.stringify({ verdict: "needs_research", gaps, feedback }) : ready;
        }
        return "Findings " + explorations;
    });
    const update = f.state.update.bind(f.state);
    f.state.update = async (change) => {
        const result = await update(change);
        const checkpoint = f.state.snapshot().researchJobs.job.checkpoint;
        if (checkpoint?.gapRegistry?.length && checkpoint.reports.explore) saved.resolve();
        return result;
    };
    await assert.rejects(f.engine.run(f.job, signal()), { code: "PROVIDER_FAILED", provider: "claude" });
    const failed = f.state.snapshot().researchJobs.job;
    const checkpoint = failed.checkpoint;
    assert.equal(explorations, 2);
    assert.deepEqual(Object.keys(checkpoint.reports), ["explore"]);
    assert.deepEqual(checkpoint.gaps, gaps);
    assert.deepEqual(checkpoint.feedback, feedback);
    assert.equal(checkpoint.sourcesBefore, 1);
    assert.deepEqual(checkpoint.gapRegistry, [{ id: "g1", text: gaps[0] }]);
    const firstDraft = failed.reports.find((report) => report.stage === "synthesize");
    const firstReview = failed.reports.find((report) => report.stage === "review");
    const before = f.calls.length;
    await f.engine.run(await resume(f.state), signal());
    const subsequent = f.calls.slice(before);
    assert.deepEqual(subsequent.map((task) => task.researchStage), ["counter", "synthesize", "review"]);
    const prompt = JSON.parse(subsequent[0].prompt);
    assert.deepEqual(prompt.gaps, gaps);
    assert.deepEqual(prompt.feedback, feedback);
    const completed = f.state.snapshot().researchJobs.job;
    assert.equal(completed.checkpoint.reports.explore, checkpoint.reports.explore);
    assert.equal(completed.checkpoint.sourcesBefore, checkpoint.sourcesBefore);
    assert.deepEqual(completed.checkpoint.gapRegistry, checkpoint.gapRegistry);
    assert.notEqual(completed.finalReportId, firstDraft.id);
    assert.notEqual(completed.reviewReportId, firstReview.id);
    assert.equal(f.posts.at(-1).text, "Synthesis 2");
    assert.equal((await f.library.readReport(completed, completed.finalReportId)).text, "Synthesis 2");
});
