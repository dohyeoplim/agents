import test from "node:test";
import assert from "node:assert/strict";
import { researchLimits, startResearchBudget } from "../../src/research/budget.js";

function fixture() {
    const job = { id: "job", runId: "first", status: "running" };
    const data = { researchJobs: { job } };
    const state = { update: async (change) => {
        const draft = structuredClone(data);
        const result = change(draft);
        Object.assign(data, draft);
        return structuredClone(result);
    } };
    let time = 1000;
    const begin = (overrides = {}) => startResearchBudget({ state, job: data.researchJobs.job,
        signal: new AbortController().signal, now: () => time,
        limits: { maxCycles: 3, maxDurationMs: 1000 }, ...overrides });
    return { data, state, begin, advance: (milliseconds) => { time += milliseconds; } };
}

test("limit validation", () => {
    assert.deepEqual(researchLimits({}), { maxCycles: 3, maxDurationMs: 3600000 });
    for (const value of ["bad", "-1", "1.5", "Infinity"]) {
        assert.throws(() => researchLimits({ RESEARCH_MAX_CYCLES: value }));
    }
    for (const value of ["0", "-1", "Infinity", "2147484"]) {
        assert.throws(() => researchLimits({ RESEARCH_MAX_DURATION_SECONDS: value }));
    }
});

test("durable duration", async () => {
    const f = fixture();
    const first = await f.begin();
    f.advance(400);
    await first.close();
    f.advance(5000);
    const second = await f.begin();
    assert.equal(f.data.researchJobs.job.executionBudget.elapsedMs, 400);
    f.advance(600);
    assert.throws(second.check, { code: "RESEARCH_BUDGET", reason: "time" });
    await second.close();
    const third = await f.begin();
    assert.throws(third.check, { code: "RESEARCH_BUDGET" });
    await third.close();
});

test("crash accounting", async () => {
    const f = fixture();
    const old = await f.begin();
    f.advance(700);
    f.data.researchJobs.job.runId = "new";
    const restored = await f.begin();
    await old.close();
    assert.equal(f.data.researchJobs.job.executionBudget.elapsedMs, 700);
    f.advance(300);
    assert.throws(restored.check, { reason: "time" });
    await restored.close();
});

test("durable cycles", async () => {
    const f = fixture();
    const first = await f.begin();
    await f.state.update((data) => first.advance(data.researchJobs.job));
    await first.close();
    const second = await f.begin();
    await f.state.update((data) => second.advance(data.researchJobs.job));
    await f.state.update((data) => second.advance(data.researchJobs.job));
    await assert.rejects(f.state.update((data) => second.advance(data.researchJobs.job)), { reason: "cycles" });
    assert.equal(f.data.researchJobs.job.executionBudget.cycles, 3);
    await second.close();
});

test("cancellation precedence", async () => {
    const f = fixture();
    const controller = new AbortController();
    const budget = await f.begin({ signal: controller.signal });
    controller.abort();
    f.advance(2000);
    assert.throws(budget.check, { name: "AbortError" });
    assert.equal(budget.exhausted({ code: "RESEARCH_BUDGET" }), false);
    await budget.close();
});
