import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { planInput, missingFields, buildManifest } from "../../src/autoresearch/plan.js";
import { offlineRunner } from "../../src/autoresearch/runner.js";

const context = { id: "experiment", revision: 1, team: "T1", user: "U1", channel: "C1", thread: "1.1" };
const complete = () => ({
    title: "Quantization study", objective: "Reduce memory without reducing accuracy",
    repository: { url: "https://github.com/example/research", commit: "a".repeat(40) },
    dataset: { id: "benchmark", revision: "v1", trainSplit: "train", validationSplit: "validation", testSplit: "test" },
    metric: { name: "accuracy", direction: "maximize", constraints: [{ name: "memory", operator: "lte", value: 48 }] },
    environment: { image: `registry.example/research@sha256:${"b".repeat(64)}` },
    training: { command: ["python", "train.py"] },
    evaluation: { command: ["python", "evaluation/run.py"], protectedPaths: ["evaluation", "tests"] },
    editablePaths: ["train.py", "model"],
});

test("draft defaults", () => {
    const plan = planInput.parse({ title: "Study", objective: "Optimize model" });
    assert.deepEqual(plan.seeds, [0, 1, 2]);
    assert.deepEqual(plan.budget, {
        maxExperiments: 24, wallSeconds: 28800, gpuSeconds: 115200,
        maxConcurrent: 4, gpusPerExperiment: 1, trialSeconds: 1800,
    });
    assert.deepEqual(missingFields(plan), [
        "repository", "dataset", "metric", "environment", "training", "evaluation", "editablePaths",
    ]);
    assert.throws(() => buildManifest(plan, context), { code: "INCOMPLETE_PLAN" });
});

test("bounded plan", () => {
    const plan = complete();
    plan.training.command = Array.from({ length: 100 }, () => "x".repeat(1000));
    assert.equal(planInput.safeParse(plan).success, false);
});

test("path boundaries", () => {
    for (const path of ["/etc", "..", "./train.py", "a/../b", "a//b", "a\\b", "*.py", "a?", "[a]",
        "a\nb", "C:a", "a\n"]) {
        assert.equal(planInput.safeParse({ ...complete(), editablePaths: [path] }).success, false, path);
    }
    for (const path of ["evaluation", "evaluation/run.py", "src"]) {
        const plan = complete();
        plan.evaluation.protectedPaths = path === "src" ? ["src/evaluation"] : ["evaluation"];
        plan.editablePaths = [path];
        assert.equal(planInput.safeParse(plan).success, false, path);
    }
    assert.equal(planInput.safeParse({ ...complete(), editablePaths: ["evaluation-new"] }).success, true);
});

test("immutable inputs", () => {
    const plan = complete();
    for (const url of ["http://github.com/test", "https://u:p@github.com/test", "https://github.com/t?a=b",
        "https://github.com/t#x", "https://github.com/t?", "file:///tmp/repo"]) {
        assert.equal(planInput.safeParse({ ...plan, repository: { ...plan.repository, url } }).success, false);
    }
    assert.equal(planInput.safeParse({ ...plan, repository: { ...plan.repository, commit: "main" } }).success, false);
    assert.equal(planInput.safeParse({ ...plan, environment: { image: "registry/image:latest" } }).success, false);
    assert.equal(planInput.safeParse({ ...plan, training: { command: "python train.py" } }).success, false);
    assert.equal(planInput.safeParse({ ...plan, training: { command: ["python", "bad\u0000arg"] } }).success, false);
    assert.equal(planInput.safeParse({ ...plan, seeds: [1, 1] }).success, false);
    assert.equal(planInput.safeParse({ ...plan, dataset: { ...plan.dataset, testSplit: "train" } }).success, false);
});

test("budget boundaries", () => {
    for (const budget of [{ maxConcurrent: 5 }, { maxConcurrent: 4, gpusPerExperiment: 2 },
        { maxExperiments: 0 }, { gpuSeconds: Infinity }, { wallSeconds: 1 }, { gpuSeconds: 1 }]) {
        assert.equal(planInput.safeParse({ ...complete(), budget }).success, false);
    }
    const plan = planInput.parse({ ...complete(), budget: { maxConcurrent: 2, gpusPerExperiment: 2 } });
    assert.equal(plan.budget.maxConcurrent, 2);
    assert.equal(plan.budget.wallSeconds, 28800);
});

test("manifest stability", () => {
    const input = complete();
    const first = buildManifest(input, context);
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    const second = buildManifest(reordered, Object.fromEntries(Object.entries(context).reverse()));
    assert.deepEqual(first, second);
    assert.equal(first.hash, createHash("sha256").update(JSON.stringify(first.manifest)).digest("hex"));
    assert.equal(first.manifest.version, 1);
    assert.equal(first.manifest.policy.baselineFirst, true);
    assert.equal(first.manifest.policy.evaluation.immutable, true);
    assert.deepEqual(first.manifest.policy.execution, { credentials: false, network: false, shell: false });
    assert.throws(() => { first.manifest.plan.training.command[0] = "changed"; }, TypeError);
    input.training.command[0] = "changed";
    assert.equal(first.manifest.plan.training.command[0], "python");
    assert.notEqual(buildManifest(complete(), { ...context, revision: 2 }).hash, first.hash);
});

test("offline runner", async () => {
    assert.deepEqual(await offlineRunner.status(), { available: false, reason: "not_configured" });
    await assert.rejects(offlineRunner.submit(buildManifest(complete(), context)), { code: "RUNNER_UNAVAILABLE" });
});
