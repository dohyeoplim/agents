import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentState } from "../../src/shared/state.js";
import { createArtifactStore } from "../../src/storage/artifacts.js";
import { createResearchLibrary } from "../../src/research/library.js";
import { createResearchEngine, researchOutput } from "../../src/research/engine.js";

async function fixture(t, execute) {
    const directory = await mkdtemp(join(tmpdir(), "research-engine-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const job = { id: "job", team: "T", user: "U", channel: "C", thread: "1.000001", key: "thread",
        profile: "assistant", status: "running", runId: "run", revision: 0, title: "Research", request: "Compare" };
    const state = new PersistentState(join(directory, "state.json"), { researchJobs: { job }, tasks: {} });
    const library = createResearchLibrary({ state,
        artifacts: createArtifactStore({ directory: join(directory, "artifacts") }) });
    const calls = [];
    const posts = [];
    const engine = createResearchEngine({ state, library, publish: async () => {},
        post: async (job, text) => { posts.push({ job, text }); },
        execute: async (task, signal) => {
            calls.push(task);
            return { answer: await execute(task, { state, library, calls, signal }), session: "session" };
        } });
    return { state, library, engine, job, calls, posts };
}

const ready = JSON.stringify({ verdict: "ready", feedback: [], gaps: [] });
const signal = () => new AbortController().signal;

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
    await assert.rejects(engine.run(job, signal()), /Claude counter failed/);
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

test("Canvas export", async (t) => {
    const full = "Long findings\n".repeat(2500);
    const { engine, job, library, state, posts, calls } = await fixture(t, async (task) =>
        task.researchStage === "review" ? ready : task.researchStage === "canvas" ? "Saved canvas" : full);
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
    await engine.canvas(state.snapshot().researchJobs.job, signal());
    assert.equal(JSON.parse(calls.at(-1).prompt).finalReportId, completed.finalReportId);
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
