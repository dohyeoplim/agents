import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createResearch } from "../../src/research/service.js";

const context = { team: "T1", user: "U1", channel: "C1", thread: "100.001",
    key: "T1:C1:100.001:assistant", profile: "assistant" };

function fixture() {
    const jobs = Array.from({ length: 12 }, (_, index) => ({ ...context, id: randomUUID(),
        createdAt: index, title: `Round ${index}`, brief: "Scope", status: "completed", revision: 3,
        runId: `run-${index}`, reports: [], finalReportId: `report-${index}` }));
    const foreign = { ...jobs[0], id: randomUUID(), createdAt: 100, thread: "200.001" };
    const data = { researchJobs: Object.fromEntries([...jobs, foreign].map((job) => [job.id, job])) };
    const state = { snapshot: () => structuredClone(data), update: async (fn) => fn(data) };
    const published = [];
    const service = createResearch({ state,
        config: async () => ({ team: "T1", users: ["U1", "U2"], channels: { C1: { agent: "assistant" } } }),
        personal: async () => ({ owner: "U1" }),
        execute: async () => { assert.fail("Inspection must not execute research"); },
    });
    service.attach({ publish: async (job) => { published.push(job); } });
    return { service, data, jobs, foreign, published };
}

test("round pagination", async () => {
    const { service, jobs } = fixture();
    const first = await service.inspect(context);
    assert.equal(first.total, 12);
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 10);
    assert.equal(first.rounds.length, 10);
    assert.equal(first.latestId, jobs[11].id);
    const next = await service.inspect(context, { offset: first.nextOffset, limit: 5 });
    assert.equal(next.latestId, first.latestId);
    assert.deepEqual(next.rounds.map((job) => job.id), [jobs[1].id, jobs[0].id]);
    assert.equal(next.nextOffset, null);
    const empty = await service.inspect(context, { offset: 20 });
    assert.deepEqual(empty.rounds, []);
    assert.equal(empty.total, 12);
    assert.equal(empty.latestId, first.latestId);
});

test("inspection ownership", async () => {
    const { service } = fixture();
    await assert.rejects(service.inspect({ ...context, user: "U2" }), /not available/);
    await assert.rejects(service.inspect(context, { limit: 100 }));
    await assert.rejects(service.inspect(context, { offset: -1 }));
});

test("refresh controls", async () => {
    const { service, data, jobs, published } = fixture();
    const before = structuredClone(data);
    const job = jobs[0];
    const result = await service.act({ id: job.id, revision: job.revision, action: "refresh" }, context);
    assert.equal(result.status, "completed");
    assert.equal(result.revision, job.revision);
    assert.deepEqual(result.actions, ["more", "canvas"]);
    assert.equal(published.length, 1);
    assert.equal(published[0].id, job.id);
    assert.deepEqual(data, before);
});

test("refresh authorization", async () => {
    const { service, jobs, foreign, published } = fixture();
    const args = { id: jobs[0].id, revision: jobs[0].revision, action: "refresh" };
    await assert.rejects(service.act({ ...args, revision: 0 }, context), /changed/);
    await assert.rejects(service.act({ ...args, id: foreign.id }, context), /not available/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(service.act(args, context, controller.signal), { name: "AbortError" });
    assert.equal(published.length, 0);
});

test("refresh failure", async () => {
    const { service, jobs } = fixture();
    const failure = Error("Slack unavailable");
    service.attach({ publish: async () => { throw failure; } });
    await assert.rejects(service.act({ id: jobs[0].id, revision: 3, action: "refresh" }, context),
        (error) => error === failure);
});
