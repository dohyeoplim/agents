import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentState } from "../../src/shared/state.js";
import { createArtifactStore } from "../../src/storage/artifacts.js";
import { createResearchLibrary } from "../../src/research/library.js";
import { createTools } from "../../src/tools/registry.js";

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), "research-library-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const job = { id: "job", team: "T", user: "U", channel: "C", status: "running", runId: "run" };
    const context = { ...job, id: "task", researchId: job.id, researchRunId: job.runId };
    const state = new PersistentState(join(directory, "state.json"), { researchJobs: { job } });
    const artifacts = createArtifactStore({ directory: join(directory, "artifacts") });
    const library = createResearchLibrary({ state, artifacts });
    return { job, context, state, artifacts, library, tools: createTools({ research: library }) };
}

const source = { title: "Study", url: "https://example.com/paper#section", text: "Evidence",
    coverage: "excerpt", locator: "page 3", claim: "Supports A" };

test("source provenance", async (t) => {
    const { library, context, state } = await fixture(t);
    const [first, duplicate] = await Promise.all([library.save(source, context), library.save(source, context)]);
    assert.equal(first.id, duplicate.id);
    assert.equal(first.url, "https://example.com/paper");
    const second = await library.save({ ...source, text: "Contradiction", claim: "Rejects A" }, context);
    assert.notEqual(first.id, second.id);
    assert.equal(Object.keys(state.snapshot().researchSources).length, 2);
    assert.equal(state.snapshot().researchSources[first.id].text, undefined);
    assert.equal((await library.read({ id: first.id }, context)).text, "Evidence");
    assert.equal(library.search({ query: "rejects" }, context).sources[0].id, second.id);
    const reworded = await library.save({ ...source, claim: "Rephrased support" }, context);
    assert.notEqual(reworded.id, first.id);
    assert.equal(reworded.contentHash, first.contentHash);
    assert.notEqual(second.contentHash, first.contentHash);
});

test("source access", async (t) => {
    const { library, context, state } = await fixture(t);
    const saved = await library.save({ ...source, text: "a".repeat(16001) }, context);
    const first = await library.read({ id: saved.id }, context);
    assert.equal(first.text.length, 8000);
    assert.equal(first.nextOffset, 8000);
    assert.equal((await library.read({ id: saved.id, offset: 16000 }, context)).nextOffset, null);
    await assert.rejects(library.read({ id: saved.id, offset: 16002 }, context), /Offset/);
    for (const field of ["team", "user", "channel", "researchId"]) {
        await assert.rejects(library.read({ id: saved.id }, { ...context, [field]: "other" }), /unavailable/);
    }
    await state.update((data) => { data.researchJobs.other = { ...data.researchJobs.job, id: "other" }; });
    await assert.rejects(library.read({ id: saved.id }, { ...context, researchId: "other" }), /unavailable/);
    assert.equal(library.search({}, { ...context, researchId: "other" }).total, 0);
});

test("stale writes", async (t) => {
    const { library, context, state, job } = await fixture(t);
    await assert.rejects(library.save(source, { ...context, researchRunId: "old" }), /no longer active/);
    await state.update((data) => { data.researchJobs.job.status = "paused"; });
    await assert.rejects(library.save(source, context), /no longer active/);
    await assert.rejects(library.saveReport(job, "review", "Feedback"), /no longer active/);
});

test("report access", async (t) => {
    const { library, context, state, job, tools } = await fixture(t);
    const report = await library.saveReport(job, "review", "Feedback");
    assert.equal((await library.saveReport(job, "review", "Feedback")).id, report.id);
    await state.update((data) => { data.researchJobs.job.status = "completed"; });
    assert.deepEqual(library.search({}, context).reports, [report]);
    assert.equal((await tools.call("research_report_read", { id: report.id }, context)).text, "Feedback");
    await assert.rejects(library.readReport({ ...job, user: "other" }, report.id), /unavailable/);
});

test("source validation", async (t) => {
    const { tools, context } = await fixture(t);
    for (const invalid of [{ url: "file:///etc/passwd" }, { url: "https://user:pass@example.com" },
        { coverage: "verified" }, { text: "x".repeat(80001) }]) {
        await assert.rejects(tools.call("research_source_save", { ...source, ...invalid }, context),
            /Invalid tool arguments/);
    }
    await assert.rejects(tools.call("research_source_save", source, { ...context, researchId: undefined }),
        /unavailable/);
});

test("source pagination", async (t) => {
    const { library, context } = await fixture(t);
    for (let index = 0; index < 23; index++) {
        await library.save({ ...source, title: "Study " + index }, context);
    }
    const first = library.search({ limit: 20 }, context);
    assert.equal(first.total, 23);
    assert.equal(first.sources.length, 20);
    assert.equal(first.nextOffset, 20);
    const second = library.search({ limit: 20, offset: first.nextOffset }, context);
    assert.equal(second.sources.length, 3);
    assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.sources, ...second.sources].map((source) => source.id)).size, 23);
});

test("provider isolation", async (t) => {
    const { library, context, job, tools } = await fixture(t);
    const codex = { ...context, provider: "codex", researchStage: "explore" };
    const claude = { ...context, provider: "claude", researchStage: "counter" };
    const a = await library.save(source, codex);
    const b = await library.save(source, claude);
    assert.notEqual(a.id, b.id);
    const reportA = await library.saveReport(job, "explore", "Codex findings", { provider: "codex" });
    const reportB = await library.saveReport(job, "counter", "Claude findings", { provider: "claude" });
    assert.deepEqual(library.search({}, codex).sources.map((item) => item.id), [a.id]);
    assert.deepEqual(library.search({}, claude).sources.map((item) => item.id), [b.id]);
    assert.deepEqual(library.search({}, codex).reports.map((item) => item.id), [reportA.id]);
    assert.deepEqual(library.search({}, claude).reports.map((item) => item.id), [reportB.id]);
    await assert.rejects(library.read({ id: b.id }, codex), /unavailable/);
    await assert.rejects(library.read({ id: a.id }, claude), /unavailable/);
    await assert.rejects(tools.call("research_report_read", { id: reportB.id }, codex), /unavailable/);
    const synthesis = { ...codex, researchStage: "synthesize" };
    assert.equal(library.search({}, synthesis).sources.length, 2);
    assert.equal(library.search({}, synthesis).reports.length, 2);
    assert.equal((await library.read({ id: b.id }, synthesis)).text, "Evidence");
    assert.equal((await tools.call("research_report_read", { id: reportB.id }, synthesis)).text, "Claude findings");
});
