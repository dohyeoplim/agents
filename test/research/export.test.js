import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentState } from "../../src/shared/state.js";
import { createCanvasWorkspace } from "../../src/slack/canvas-workspace.js";
import { createCanvases } from "../../src/slack/canvases.js";
import { createResearchExport, reportChunks } from "../../src/research/export.js";

async function fixture(t, text = "Findings\n".repeat(7000)) {
    const directory = await mkdtemp(join(tmpdir(), "research-export-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const job = { id: "job", runId: "run", finalReportId: "report", title: "Research", status: "running",
        team: "T1", channel: "C1", user: "U1", thread: "1.1", key: "thread", profile: "assistant" };
    const state = new PersistentState(join(directory, "state.json"), { researchJobs: { job }, tasks: {} });
    const document = { text: "", revision: "0", title: job.title };
    const calls = [];
    const controls = {};
    const request = async (url, options) => {
        const method = new URL(url).pathname.split("/").at(-1);
        const body = JSON.parse(options.body);
        calls.push({ method, body });
        if (method === "files.info") return Response.json({ ok: true, file: {
            id: "F123456", title: job.title, filetype: "canvas", channels: [job.channel],
        } });
        if (method === "canvases.create") {
            document.text = body.document_content.markdown;
            document.revision = "1";
            if (controls.uncertainCreation) throw Error("Connection lost after creation");
            return Response.json({ ok: true, canvas_id: "F123456" });
        }
        if (method === "canvases.edit") {
            const edits = calls.filter((call) => call.method === "canvases.edit").length;
            if (controls.rejectEdit === edits) return Response.json({ ok: false, error: "ratelimited" });
            document.text += "\n" + body.changes[0].document_content.markdown;
            document.revision = String(Number(document.revision) + 1);
            await controls.afterEdit?.();
            if (controls.uncertainEdit) throw Error("Connection lost after edit");
            return Response.json({ ok: true });
        }
        throw Error("Unexpected method " + method);
    };
    const resources = { read: async () => {
        if (controls.readbackFailure && document.revision !== "1") throw Error("Read unavailable");
        return { ...document, truncated: false };
    } };
    const options = { state, token: "test", workspaceUrl: "https://example.slack.com", request };
    const canvases = createCanvasWorkspace({ ...options, resources, create: createCanvases(options).create });
    const library = { readReport: async (_, id, offset) => ({ text: text.slice(offset, offset + 8000),
        nextOffset: offset + 8000 < text.length ? offset + 8000 : null }) };
    const run = (signal = new AbortController().signal) => createResearchExport({ state, library, canvases })(
        state.snapshot().researchJobs.job, signal);
    return { state, document, calls, controls, run, job, text, canvases };
}

test("Markdown boundaries", () => {
    const text = "Intro\n\n```js\nconst x = 1;\n```\n\n## Results\nConclusion\n";
    const chunks = reportChunks(text, 30);
    assert.equal(chunks.join(""), text);
    assert.ok(chunks.every((chunk) => chunk.length <= 30));
    assert.ok(chunks.some((chunk) => chunk.includes("```js\nconst x = 1;\n```")));
    assert.throws(() => reportChunks("```\n" + "x\n".repeat(20) + "```", 30), /block exceeds/);
});

test("exact report", async (t) => {
    const f = await fixture(t);
    const url = await f.run();
    const contents = f.calls.flatMap(({ method, body }) => method === "canvases.create" ?
        [body.document_content.markdown] : method === "canvases.edit" ?
            [body.changes[0].document_content.markdown] : []);
    assert.deepEqual(contents, reportChunks(f.text).map((chunk) => chunk.trim()));
    assert.equal(url, "https://example.slack.com/docs/T1/F123456");
    assert.equal(f.state.snapshot().researchJobs.job.canvasExport.nextChunk, contents.length);
    const before = f.calls.length;
    assert.equal(await f.run(), url);
    assert.equal(f.calls.length, before);
    assert.ok(Object.values(f.state.snapshot().tasks).every((task) => task.status === "completed"));
});

test("export resumption", async (t) => {
    const f = await fixture(t);
    f.controls.rejectEdit = 2;
    await assert.rejects(f.run(), /ratelimited/);
    const pending = f.state.snapshot().researchJobs.job.canvasExport;
    assert.equal(pending.nextChunk, 2);
    assert.ok(pending.pendingReadId);
    f.controls.rejectEdit = undefined;
    await f.run();
    assert.equal(f.calls.filter((call) => call.method === "canvases.create").length, 1);
    assert.equal(f.state.snapshot().researchJobs.job.canvasExport.nextChunk, reportChunks(f.text).length);
    assert.equal(f.document.text, reportChunks(f.text).map((chunk) => chunk.trim()).join("\n"));
});

test("uncertain append", async (t) => {
    const f = await fixture(t);
    f.controls.uncertainEdit = true;
    await assert.rejects(f.run(), /delivery is uncertain/);
    const before = f.document.text;
    f.controls.uncertainEdit = false;
    await assert.rejects(f.run(), /uncertain/);
    assert.equal(f.document.text, before);
    assert.equal(f.calls.filter((call) => call.method === "canvases.edit").length, 1);
});

test("resolved append", async (t) => {
    const f = await fixture(t);
    f.controls.uncertainEdit = true;
    await assert.rejects(f.run(), /delivery is uncertain/);
    f.controls.uncertainEdit = false;
    const change = Object.entries(f.state.snapshot().canvasChanges)
        .find(([, change]) => change.status === "uncertain");
    const exported = f.state.snapshot().researchJobs.job.canvasExport;
    await f.state.update((data) => { data.tasks[exported.taskId].status = "running"; });
    const context = f.state.snapshot().tasks[exported.taskId];
    const read = await f.canvases.read({ canvasId: exported.canvasId }, context);
    await f.canvases.update({ operation: "resolve", changeId: change[0], readId: read.readId,
        outcome: "applied", reason: "Checked the complete appended section" }, context);
    await f.run();
    assert.equal(f.calls.filter((call) => call.method === "canvases.edit").length,
        reportChunks(f.text).length - 1);
    assert.equal(f.document.text, reportChunks(f.text).map((chunk) => chunk.trim()).join("\n"));
});

test("stale completion", async (t) => {
    const f = await fixture(t);
    f.controls.afterEdit = () => f.state.update((data) => {
        const job = data.researchJobs.job;
        job.runId = "replacement";
        data.tasks[job.canvasExport.taskId].researchRunId = job.runId;
    });
    await assert.rejects(f.run(), /run changed/);
    const job = f.state.snapshot().researchJobs.job;
    assert.equal(job.canvasExport.nextChunk, 1);
    assert.equal(f.state.snapshot().tasks[job.canvasExport.taskId].status, "running");
});

test("uncertain creation", async (t) => {
    const f = await fixture(t);
    f.controls.uncertainCreation = true;
    await assert.rejects(f.run(), /outcome is unknown/);
    f.controls.uncertainCreation = false;
    await assert.rejects(f.run(), /uncertain/);
    assert.equal(f.calls.filter((call) => call.method === "canvases.create").length, 1);
});

test("revision conflict", async (t) => {
    const f = await fixture(t);
    f.controls.rejectEdit = 2;
    await assert.rejects(f.run(), /ratelimited/);
    f.document.revision = "external";
    f.document.text += "\nUser edit";
    f.controls.rejectEdit = undefined;
    await assert.rejects(f.run(), /changed since reading/);
    assert.ok(f.document.text.endsWith("User edit"));
    assert.equal(f.calls.filter((call) => call.method === "canvases.edit").length, 2);
});

test("missing verification", async (t) => {
    const f = await fixture(t);
    f.controls.readbackFailure = true;
    await assert.rejects(f.run(), /revision could not be verified/);
    f.controls.readbackFailure = false;
    await f.run();
    assert.equal(f.calls.filter((call) => call.method === "canvases.edit").length,
        reportChunks(f.text).length - 1);
    assert.equal(f.document.text, reportChunks(f.text).map((chunk) => chunk.trim()).join("\n"));
});

test("oversized block", async (t) => {
    const f = await fixture(t, "```\n" + "Code\n".repeat(5000) + "```");
    await assert.rejects(f.run(), /block exceeds/);
    assert.equal(f.calls.length, 0);
});
