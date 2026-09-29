import test from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "../../src/autoresearch/plan.js";
import { createExperimentLoop } from "../../src/autoresearch/experiments.js";
import { offlineRunner } from "../../src/autoresearch/runner.js";

function fixture(overrides = {}) {
    const { manifest } = buildManifest({
        title: "Experiment", objective: "Improve accuracy", seeds: [0, 1],
        repository: { url: "https://example.com/repo", commit: "a".repeat(40) },
        dataset: { id: "data", revision: "v1", trainSplit: "train", validationSplit: "validation", testSplit: "test" },
        environment: { image: `example/image@sha256:${"c".repeat(64)}` },
        training: { command: ["python", "train.py"] }, editablePaths: ["train.py"],
        evaluation: { command: ["python", "eval.py"], protectedPaths: ["eval.py"] },
        metric: { name: "accuracy", direction: "maximize",
            constraints: [{ name: "memory", operator: "lte", value: 48 }] },
        budget: { trialSeconds: 1, wallSeconds: 10, gpuSeconds: 10, maxExperiments: 6 }, ...overrides,
    }, { id: "job", revision: 1, team: "T", user: "U", channel: "C", thread: "1" });
    const requests = [];
    const events = [];
    let proposals = 0;
    const runner = { status: () => ({ available: true }), submit: async (request) => {
        requests.push(request);
        return {
            metrics: { accuracy: request.baseline ? 0.8 : 0.9, memory: 40 },
            gpuSeconds: 0.1, wallSeconds: 0.1, commit: request.candidate.commit, seed: request.seed,
            evaluatorCommit: manifest.plan.repository.commit, datasetRevision: "v1",
        };
    } };
    const options = { runner, record: async (event) => events.push(event),
        proposeCandidate: async () => ++proposals === 1 ? { id: "candidate", commit: "b".repeat(40) } : null };
    return { manifest, requests, events, options, run: () => createExperimentLoop(options).run(manifest) };
}

test("baseline ordering", async () => {
    const f = fixture();
    const result = await f.run();
    assert.deepEqual(f.requests.map(({ baseline, seed }) => [baseline, seed]),
        [[true, 0], [true, 1], [false, 0], [false, 1]]);
    assert.equal(result.best.candidate.id, "candidate");
    assert.equal(result.best.score, 0.9);
    assert.equal(result.attempts, 4);
    assert.equal(f.events.at(-1).type, "completed");
    assert.equal(f.requests[0].limits.gpus, 1);
});

test("offline rejection", async () => {
    const f = fixture();
    f.options.runner = offlineRunner;
    f.options.proposeCandidate = () => assert.fail("Proposal ran offline");
    await assert.rejects(f.run, { code: "RUNNER_UNAVAILABLE" });
    assert.equal(f.events.length, 0);
});

test("constraint failures", async () => {
    const f = fixture();
    const original = f.options.runner.submit;
    f.options.runner.submit = async (request) => ({ ...await original(request),
        metrics: { accuracy: request.baseline ? 0.8 : 0.99, memory: request.baseline ? 40 : 49 } });
    const result = await f.run();
    assert.equal(result.best.candidate.id, "baseline");
    assert.equal(result.history[1].eligible, false);
});

test("result validation", async () => {
    for (const patch of [{ metrics: { accuracy: NaN, memory: 1 } }, { metrics: { accuracy: Infinity, memory: 1 } },
        { evaluatorCommit: "b".repeat(40) }, { datasetRevision: "changed" }, { seed: 99 }, { gpuSeconds: 20 }]) {
        const f = fixture();
        const original = f.options.runner.submit;
        f.options.runner.submit = async (request) => ({ ...await original(request), ...patch });
        const result = await f.run();
        assert.equal(result.reason, "baseline_failed");
        assert.equal(result.best, null);
        assert.equal(result.attempts, 1);
    }
});

test("attempt budget", async () => {
    const f = fixture({ budget: { maxExperiments: 3, trialSeconds: 1, wallSeconds: 10, gpuSeconds: 10 } });
    const result = await f.run();
    assert.equal(result.reason, "experiments");
    assert.equal(result.attempts, 3);
    assert.equal(result.best.candidate.id, "baseline");
    assert.equal(result.history[1].eligible, false);
});

test("gpu budget", async () => {
    const f = fixture({ budget: { maxExperiments: 6, trialSeconds: 1, wallSeconds: 10, gpuSeconds: 1 } });
    const original = f.options.runner.submit;
    f.options.runner.submit = async (request) => ({ ...await original(request), gpuSeconds: 1 });
    const result = await f.run();
    assert.equal(result.reason, "gpu");
    assert.equal(result.attempts, 1);
    assert.equal(result.best, null);
});

test("wall budget", async () => {
    const f = fixture();
    let now = 0;
    f.options.now = () => now;
    const original = f.options.runner.submit;
    f.options.runner.submit = async (request) => { now += 11000; return original(request); };
    const result = await f.run();
    assert.equal(result.reason, "wall");
    assert.equal(result.attempts, 1);
});

test("expired reservation", async () => {
    const f = fixture();
    let now = 0;
    f.options.now = () => now;
    f.options.record = async (event) => {
        if (event.type === "trial_started") now += 11000;
    };
    const result = await f.run();
    assert.equal(result.reason, "wall");
    assert.equal(f.requests.length, 0);
});

test("bounded failures", async () => {
    const f = fixture();
    const original = f.options.runner.submit;
    f.options.runner.submit = (request) => {
        if (!request.baseline) throw Error("Failed");
        return original(request);
    };
    f.options.proposeCandidate = async () => ({ id: "same", commit: "b".repeat(40) });
    const result = await f.run();
    assert.equal(result.reason, "experiments");
    assert.equal(result.attempts, 6);
    assert.equal(result.best.candidate.id, "baseline");
});

test("status cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.options.runner.status = () => { controller.abort(Error("Stopped")); return new Promise(() => {}); };
    await assert.rejects(createExperimentLoop(f.options).run(f.manifest, { signal: controller.signal }), /Stopped/u);
    assert.equal(f.requests.length, 0);
});

test("trial timeout", async () => {
    const f = fixture();
    let captured;
    f.options.runner.submit = (request, signal) => { captured = signal; return new Promise(() => {}); };
    const result = await f.run();
    assert.equal(result.reason, "baseline_failed");
    assert.equal(result.attempts, 1);
    assert.equal(captured.aborted, true);
    assert.equal(f.events.find((event) => event.type === "trial_failed").errorCode, "TRIAL_TIMEOUT");
});

test("active cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.options.runner.submit = () => { controller.abort(Error("Stopped")); return new Promise(() => {}); };
    await assert.rejects(createExperimentLoop(f.options).run(f.manifest, { signal: controller.signal }), /Stopped/u);
    assert.equal(f.events.some((event) => event.type === "candidate_completed"), false);
});

test("minimize metric", async () => {
    const f = fixture({ metric: { name: "accuracy", direction: "minimize" } });
    const result = await f.run();
    assert.equal(result.best.candidate.id, "baseline");
});
