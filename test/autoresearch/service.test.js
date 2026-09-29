import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAutoresearch } from "../../src/autoresearch/service.js";
import { PersistentState } from "../../src/shared/state.js";
import { createArtifactStore } from "../../src/storage/artifacts.js";

const context = { team: "T1", user: "U1", channel: "C1", thread: "100.001",
    key: "T1:C1:100.001:assistant", profile: "assistant" };
const task = { ...context, id: "task1", messageTs: "100.001" };
const plan = () => ({ title: "Memory study", objective: "Reduce memory with fixed accuracy",
    repository: { url: "https://github.com/example/study", commit: "a".repeat(40) },
    dataset: { id: "dataset", revision: "v1", trainSplit: "train", validationSplit: "val", testSplit: "test" },
    metric: { name: "memory", direction: "minimize", constraints: [{ name: "accuracy", operator: "gte", value: 90 }] },
    environment: { image: `registry.example/study@sha256:${"b".repeat(64)}` },
    training: { command: ["python", "train.py"] },
    evaluation: { command: ["python", "eval.py"], protectedPaths: ["eval.py", "tests"] },
    editablePaths: ["train.py", "model"],
});

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), "autoresearch-service-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const state = await new PersistentState(join(directory, "state.json"), {
        autoresearchJobs: {}, researchJobs: { existing: { title: "Deep research" } },
    }).load();
    const artifacts = createArtifactStore({ directory: join(directory, "artifacts") });
    const published = [];
    const options = { state, artifacts, now: () => 100001,
        config: async () => ({ team: "T1", users: ["U1", "U2"], channels: { C1: { agent: "assistant" } } }),
        personal: async () => ({ owner: "U1" }) };
    const service = createAutoresearch(options);
    service.attach({ publish: async (job) => published.push(job) });
    return { state, service, published, artifacts, options };
}

test("draft preparation", async (t) => {
    const f = await fixture(t);
    const draft = await f.service.propose({ plan: { title: "Study", objective: "Reduce memory" } }, task);
    assert.equal(draft.status, "draft");
    assert.ok(draft.missing.includes("repository"));
    assert.equal(draft.runner.available, false);
    await assert.rejects(f.service.act({ id: draft.id, revision: draft.revision, action: "approve" }, context));
    const ready = await f.service.propose({ id: draft.id, revision: draft.revision, plan: plan() }, task);
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.missing, []);
    const approved = await f.service.act({ id: ready.id, revision: ready.revision, action: "approve" }, context);
    assert.equal(approved.status, "prepared");
    assert.equal(approved.executed, false);
    assert.match(approved.manifestHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(f.state.snapshot().researchJobs, { existing: { title: "Deep research" } });
    const manifest = await f.service.readManifest({ id: ready.id }, context);
    assert.equal(JSON.parse(manifest.text).plan.repository.commit, plan().repository.commit);
    assert.equal(JSON.parse(manifest.text).context.revision, approved.revision);
    assert.equal(manifest.hash, approved.manifestHash);
    await assert.rejects(f.service.propose({ id: approved.id, revision: approved.revision, plan: plan() }, task));
});

test("later confirmation", async (t) => {
    const { service } = await fixture(t);
    const job = await service.propose({ plan: plan() }, task);
    const args = { id: job.id, revision: job.revision, action: "approve" };
    for (const input of [task, { ...task, id: "other" }, { ...task, id: "other", messageTs: undefined }]) {
        await assert.rejects(service.act(args, input));
    }
    assert.equal((await service.act(args, { ...task, id: "other", messageTs: "101.001" })).status, "prepared");
});

test("proposal identity", async (t) => {
    const { service, state } = await fixture(t);
    const first = await service.propose({ plan: plan() }, task);
    const repeated = await service.propose({ plan: plan() }, task);
    assert.equal(first.id, repeated.id);
    assert.equal(Object.keys(state.snapshot().autoresearchJobs).length, 1);
    await assert.rejects(service.propose({ plan: plan() }, { ...task, id: "other" }));
    await assert.rejects(service.propose({ id: first.id, revision: 50, plan: plan() }, task));
    const cancelled = await service.act({ id: first.id, revision: first.revision, action: "cancel" }, context);
    assert.equal(cancelled.status, "cancelled");
    const next = await service.propose({ plan: plan() }, { ...task, id: "other" });
    assert.notEqual(next.id, first.id);
});

test("owner isolation", async (t) => {
    const { service } = await fixture(t);
    const job = await service.propose({ plan: plan() }, task);
    for (const change of [{ user: "U2" }, { thread: "200.001" }, { team: "T2" }, { channel: "C2" },
        { researchId: "research" }, { scheduleId: "schedule" }, { briefingDate: "2026-09-29" }]) {
        const input = { ...context, ...change };
        await assert.rejects(service.act({ id: job.id, revision: job.revision, action: "approve" }, input));
        await assert.rejects(service.readManifest({ id: job.id }, input));
    }
});

test("approval race", async (t) => {
    const f = await fixture(t);
    const put = f.artifacts.put;
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    f.artifacts.put = async (...args) => { started.resolve(); await release.promise; return put(...args); };
    const job = await f.service.propose({ plan: plan() }, task);
    const approving = f.service.act({ id: job.id, revision: job.revision, action: "approve" }, context);
    await started.promise;
    await f.service.act({ id: job.id, revision: job.revision, action: "cancel" }, context);
    release.resolve();
    await assert.rejects(approving);
    assert.equal(f.state.snapshot().autoresearchJobs[job.id].status, "cancelled");
    assert.equal(f.state.snapshot().autoresearchJobs[job.id].manifestId, undefined);
});

test("aborted approval", async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    const put = f.artifacts.put;
    f.artifacts.put = async (...args) => { const artifact = await put(...args); controller.abort(); return artifact; };
    const job = await f.service.propose({ plan: plan() }, task);
    await assert.rejects(f.service.act({ id: job.id, revision: job.revision, action: "approve" },
        context, controller.signal), { name: "AbortError" });
    assert.equal(f.state.snapshot().autoresearchJobs[job.id].status, "ready");
});

test("manifest pagination", async (t) => {
    const f = await fixture(t);
    const input = plan();
    input.objective = "a".repeat(6000);
    input.training.command.push("b".repeat(2000));
    const job = await f.service.propose({ plan: input }, task);
    await f.service.act({ id: job.id, revision: job.revision, action: "approve" }, context);
    const first = await f.service.readManifest({ id: job.id }, context);
    assert.equal(first.nextOffset, 8000);
    const second = await f.service.readManifest({ id: job.id, offset: first.nextOffset }, context);
    assert.equal(second.nextOffset, null);
    assert.equal(JSON.parse(first.text + second.text).plan.objective, input.objective);
    const get = f.artifacts.get;
    f.artifacts.get = async (id) => ({ ...await get(id), data: Buffer.from("changed") });
    await assert.rejects(f.service.readManifest({ id: job.id }, context));
});

test("prepared recovery", async (t) => {
    const f = await fixture(t);
    const job = await f.service.propose({ plan: plan() }, task);
    await f.service.act({ id: job.id, revision: job.revision, action: "approve" }, context);
    const before = f.state.snapshot();
    const restored = createAutoresearch(f.options);
    const updates = [];
    restored.attach({ publish: async (value) => updates.push(value) });
    await restored.recover();
    assert.equal(updates[0].status, "prepared");
    assert.deepEqual(f.state.snapshot(), before);
    assert.equal((await restored.inspect(context)).jobs[0].runner.available, false);
    restored.stop();
    await assert.rejects(restored.act({ id: job.id, revision: 1, action: "cancel" }, context));
});

test("delivery visibility", async (t) => {
    const f = await fixture(t);
    f.service.attach({ publish: async () => { throw Error("Slack unavailable"); } });
    const job = await f.service.propose({ plan: plan() }, task);
    assert.equal(job.status, "ready");
    assert.equal(job.deliveryConfirmed, false);
    assert.ok(job.warning);
    f.service.attach({ publish: async () => {} });
    const refreshed = await f.service.act({ id: job.id, revision: job.revision, action: "refresh" }, context);
    assert.equal(refreshed.deliveryConfirmed, true);
    assert.equal(refreshed.warning, undefined);
});

test("bounded inspection", async (t) => {
    const f = await fixture(t);
    const input = plan();
    input.objective = "a".repeat(4000);
    input.training.command = Array.from({ length: 16 }, () => "b".repeat(1000));
    const job = await f.service.propose({ plan: input }, task);
    await f.state.update((data) => {
        const saved = data.autoresearchJobs[job.id];
        for (let index = 0; index < 7; index++) {
            const id = randomUUID();
            data.autoresearchJobs[id] = { ...saved, id, createdAt: index };
        }
    });
    const first = await f.service.inspect(context);
    assert.equal(first.total, 8);
    assert.ok(first.nextOffset > 0 && first.nextOffset < 8);
    assert.ok(JSON.stringify(first).length < 100000);
    const second = await f.service.inspect(context, { offset: first.nextOffset });
    assert.ok(!second.jobs.some((job) => first.jobs.some((previous) => previous.id === job.id)));
});
