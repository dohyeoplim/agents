import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAutoresearch } from "../../src/autoresearch/service.js";
import { createCampaignEngine } from "../../src/autoresearch/campaign-engine.js";
import { campaignInput } from "../../src/autoresearch/campaign-schema.js";
import { renderAutoresearch } from "../../src/autoresearch/slack.js";
import { PersistentState } from "../../src/shared/state.js";
import { createArtifactStore } from "../../src/storage/artifacts.js";

const context = { team: "T1", user: "U1", channel: "C1", thread: "100.001",
    key: "T1:C1:100.001:assistant", profile: "assistant" };
const task = { ...context, id: "task1", messageTs: "100.001" };
const input = { title: "Memory study", objective: "Find and evaluate methods for reducing model memory" };

async function until(check) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (check()) return;
        await delay(5);
    }
    assert.fail("Condition timed out");
}

async function fixture(t, extra = {}) {
    const directory = await mkdtemp(join(tmpdir(), "campaign-service-"));
    const state = await new PersistentState(join(directory, "state.json"), { autoresearchJobs: {} }).load();
    const artifacts = createArtifactStore({ directory: join(directory, "artifacts") });
    const runs = [];
    const options = { state, artifacts, now: () => 100001,
        config: async () => ({ team: "T1", users: ["U1"], channels: { C1: { agent: "assistant" } } }),
        personal: async () => ({ owner: "U1", briefing: { timezone: "America/New_York" } }),
        remote: { describe: () => ({ configured: true, connected: null }) },
        execute: async () => {},
        campaignEngine: () => ({ run: async (job, signal) => {
            runs.push(job);
            if (signal.aborted) throw signal.reason;
            await new Promise((resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
        } }), ...extra };
    const service = createAutoresearch(options);
    const published = [];
    service.attach({ publish: async (job) => published.push(job) });
    t.after(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
    const get = (id) => state.snapshot().autoresearchJobs[id];
    const act = (job, action, caller = context) =>
        service.act({ id: job.id, revision: get(job.id).revision, action }, caller);
    return { state, service, artifacts, options, runs, published, get, act };
}

test("campaign defaults", async (t) => {
    const f = await fixture(t);
    const job = await f.service.campaign(input, task);
    assert.equal(job.mode, "campaign");
    assert.equal(job.status, "ready");
    assert.deepEqual(job.missing, []);
    assert.equal(job.campaign.timezone, "America/New_York");
    assert.equal(job.campaign.maxSteps, 24);
    assert.equal(job.campaign.gpus, 4);
    assert.equal(job.connection.connected, null);
    assert.deepEqual(job.actions, ["start", "cancel"]);
    assert.equal(f.runs.length, 0);
    const status = await f.service.inspect(context);
    assert.equal(status.timezone, "America/New_York");
    assert.equal(status.currentTime, new Date(100001).toISOString());
    assert.equal((await f.service.campaign(input, task)).id, job.id);
    await assert.rejects(f.service.campaign(input, { ...task, id: "other" }));
    await assert.rejects(f.service.propose({ plan: input }, { ...task, id: "other" }));
});

test("campaign clarification", async (t) => {
    const f = await fixture(t);
    const pending = await f.service.campaign({ ...input, questions: ["Which device is the target?"] }, task);
    assert.equal(pending.status, "awaiting_input");
    await assert.rejects(f.act(pending, "start"));
    const ready = await f.service.campaign({ ...input, id: pending.id, revision: pending.revision,
        objective: "Evaluate on a mobile device" }, { ...task, id: "answer", messageTs: "101.001" });
    assert.equal(ready.id, pending.id);
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.questions, []);
    await assert.rejects(f.service.campaign({ ...input, id: pending.id, revision: pending.revision }, task));
});

test("legacy migration", async (t) => {
    const f = await fixture(t);
    const legacy = await f.service.propose({ plan: input }, task);
    assert.equal(legacy.status, "draft");
    const campaign = await f.service.campaign({ ...input, id: legacy.id, revision: legacy.revision }, task);
    assert.equal(campaign.id, legacy.id);
    assert.equal(campaign.status, "ready");
    assert.deepEqual(campaign.plan, input);
    await assert.rejects(f.service.propose({ plan: input, id: campaign.id, revision: campaign.revision }, task));
});

test("campaign confirmation", async (t) => {
    const f = await fixture(t);
    const job = await f.service.campaign(input, task);
    await assert.rejects(f.act(job, "start", task));
    await assert.rejects(f.act(job, "start", { ...task, id: "other" }));
    await f.act(job, "start", { ...task, id: "other", messageTs: "101.001" });
    await until(() => f.runs.length === 1);
    assert.equal(f.get(job.id).status, "running");
    await assert.rejects(f.service.campaign({ ...input, id: job.id, revision: f.get(job.id).revision }, task));
    await f.act(job, "pause");
    assert.equal(f.get(job.id).status, "paused");
    const deadline = f.get(job.id).executionDeadline;
    await f.act(job, "resume");
    await until(() => f.runs.length === 2);
    assert.equal(f.get(job.id).executionDeadline, deadline);
    await f.act(job, "cancel");
    assert.equal(f.get(job.id).status, "cancelled");
});

test("campaign capacity", async (t) => {
    const f = await fixture(t);
    const jobs = [];
    for (let index = 0; index < 3; index++) {
        const thread = `${200 + index}.001`;
        const caller = { ...context, thread, key: `T1:C1:${thread}:assistant` };
        const job = await f.service.campaign(input, caller);
        jobs.push({ job, caller });
        await f.act(job, "start", caller);
    }
    await until(() => f.runs.length === 1);
    assert.equal(f.get(jobs[1].job.id).status, "queued");
    await f.act(jobs[0].job, "cancel", jobs[0].caller);
    await until(() => f.runs.length === 2);
    assert.equal(f.get(jobs[1].job.id).status, "running");
    assert.equal(f.get(jobs[2].job.id).status, "queued");
});

test("campaign recovery", async (t) => {
    const f = await fixture(t);
    const job = await f.service.campaign(input, task);
    await f.state.update((data) => { data.autoresearchJobs[job.id].status = "running"; });
    await f.service.recover();
    assert.equal(f.get(job.id).status, "interrupted");
    assert.equal(f.runs.length, 0);
    await f.act(f.get(job.id), "resume");
    await until(() => f.runs.length === 1);
    await f.service.stop();
    assert.equal(f.get(job.id).status, "interrupted");
});

test("cleanup recovery", async (t) => {
    let confirmed = false;
    const f = await fixture(t, { remote: { describe: () => ({ configured: true, connected: true }),
        run: async () => ({ status: confirmed ? "cancelled" : "interrupted" }) } });
    const old = await f.service.campaign(input, task);
    await f.state.update((data) => {
        Object.assign(data.autoresearchJobs[old.id], { status: "cancelled", runId: "old-run",
            campaignState: { cleanupPending: true, pending: { args: { id: "old-command" } } } });
    });
    const thread = "300.001";
    const caller = { ...context, thread, key: `T1:C1:${thread}:assistant` };
    const queued = await f.service.campaign(input, caller);
    await f.act(queued, "start", caller);
    assert.equal(f.get(queued.id).status, "queued");
    assert.equal(f.runs.length, 0);
    await f.act(old, "cancel");
    assert.equal(f.get(old.id).campaignState.cleanupPending, true);
    assert.equal(f.get(queued.id).status, "queued");
    confirmed = true;
    await f.act(old, "cancel");
    await until(() => f.runs.length === 1);
    assert.equal(f.get(old.id).campaignState.cleanupPending, false);
    assert.equal(f.get(old.id).campaignState.pending.cancelConfirmed, true);
    assert.equal(f.get(queued.id).status, "running");
});

test("expired campaign", async (t) => {
    let clock = 100001;
    const f = await fixture(t, { now: () => clock });
    const job = await f.service.campaign({ ...input, wallSeconds: 60 }, task);
    await f.act(job, "start");
    await until(() => f.runs.length === 1);
    await f.act(job, "pause");
    clock += 61000;
    await assert.rejects(f.act(job, "resume"));
    assert.equal(f.runs.length, 1);
    await assert.rejects(f.service.campaign({ ...input, deadline: "1970-01-01T00:00:01Z" }, task));
});

test("edited continuation", async (t) => {
    const f = await fixture(t);
    const job = await f.service.campaign(input, task);
    await f.act(job, "start");
    await until(() => f.runs.length === 1);
    await f.act(job, "pause");
    const deadline = f.get(job.id).executionDeadline;
    await f.state.update((data) => {
        data.autoresearchJobs[job.id].campaignState = { steps: 3, commands: 1, gpuSeconds: 240,
            history: [], pending: { args: { id: "pending-command" } } };
    });
    const reply = { ...task, id: "answer", messageTs: "101.001" };
    const edited = await f.service.campaign({ ...input, id: job.id, revision: f.get(job.id).revision,
        objective: "Prefer lower latency while retaining accuracy" }, reply);
    assert.equal(edited.status, "paused");
    assert.equal(f.get(job.id).executionDeadline, deadline);
    assert.equal(f.get(job.id).campaignState.steps, 3);
    assert.equal(f.get(job.id).campaignState.pending.args.id, "pending-command");
    await assert.rejects(f.act(edited, "resume", reply));
    await f.act(edited, "resume", { ...reply, id: "confirm", messageTs: "102.001" });
    await until(() => f.runs.length === 2);
    assert.equal(f.get(job.id).executionDeadline, deadline);
});

test("campaign result", async (t) => {
    const f = await fixture(t);
    const job = await f.service.campaign(input, task);
    assert.equal((await f.service.readResult({ id: job.id }, context)).available, false);
    const report = await f.artifacts.put("x".repeat(9000), { mime: "text/plain", source: {
        provider: "autoresearch", fileId: job.id, channel: "C1", kind: "campaign-report", version: "run1",
    } });
    await f.state.update((data) => {
        Object.assign(data.autoresearchJobs[job.id], { status: "completed", finalReportId: report.id });
    });
    const first = await f.service.readResult({ id: job.id }, context);
    const second = await f.service.readResult({ id: job.id, offset: first.nextOffset }, context);
    assert.equal(first.text.length, 8000);
    assert.equal(second.text.length, 1000);
    assert.equal(second.nextOffset, null);
    await assert.rejects(f.service.readResult({ id: job.id }, { ...context, user: "U2" }));
    const status = await f.service.inspect(context);
    assert.deepEqual(status.jobs[0].actions, ["result"]);
});

test("connection display", async (t) => {
    const f = await fixture(t);
    const prepared = await f.service.campaign(input, task);
    const job = f.get(prepared.id);
    const card = (connection) => JSON.stringify(renderAutoresearch({ ...job, connection }));
    assert.match(card({ configured: true, connected: null }), /아직 확인하지/);
    assert.match(card({ configured: true, connected: true }), /연결을 확인/);
    assert.match(card({ configured: true, connected: false }), /연결 확인에 실패/);
    assert.match(card({ configured: false, connected: null }), /설정되지/);
    for (const change of [{ maxSteps: 2 }, { maxSteps: 81 }, { maxCommands: 101 }, { gpus: 5 },
        { wallSeconds: 86401 }, { timezone: "wrong" }, { repository: "user should not supply this" }]) {
        assert.equal(campaignInput.safeParse({ ...input, ...change }).success, false);
    }
});

test("campaign workflow", async (t) => {
    const decisions = [{ kind: "command", command: "python evaluate.py", cwd: "/workspace",
        timeoutSeconds: 60, purpose: "Measure baseline memory" },
    { kind: "report", text: "Baseline measured at 100 MB." },
    { kind: "report", text: "A single run needs independent verification." },
    { kind: "report", text: "Measured baseline is 100 MB. Repeat runs are still needed." }];
    const calls = [];
    const providers = [];
    const posts = [];
    const failures = [];
    const f = await fixture(t, { campaignEngine: (options) => {
        const engine = createCampaignEngine(options);
        return { run: async (...args) => {
            try { return await engine.run(...args); }
            catch (error) { failures.push(error); throw error; }
        } };
    },
        execute: async (task) => {
            providers.push(task.provider);
            return { answer: JSON.stringify(decisions.shift()) };
        },
        remote: { describe: () => ({ configured: true, connected: true }),
            run: async (operation, args) => {
                calls.push([operation, args]);
                if (operation === "status") return { connected: true };
                return operation === "exec" ? { id: args.id, status: "running" } :
                    { id: args.id, status: "completed", output: "memory_mb=100", exitCode: 0,
                        nextOffset: 13, hasMore: false };
            } },
        post: async (job, text) => posts.push({ thread: job.thread, text }),
    });
    const job = await f.service.campaign(input, task);
    await f.act(job, "start");
    await until(() => failures.length || f.get(job.id).status === "completed" && posts.length === 1);
    assert.deepEqual(failures, []);
    assert.deepEqual(providers, ["codex", "codex", "claude", "codex"]);
    assert.deepEqual(calls.map(([operation]) => operation), ["status", "exec", "job"]);
    assert.equal(calls[1][1].id, calls[2][1].id);
    assert.equal(f.get(job.id).campaignState.commands, 1);
    assert.equal(f.get(job.id).campaignState.gpuSeconds, 240);
    const result = await f.service.readResult({ id: job.id }, context);
    assert.equal(result.text, posts[0].text);
    assert.equal(posts[0].thread, context.thread);
    assert.match(result.text, /Repeat runs are still needed/);
});
