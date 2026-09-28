import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PersistentState } from "../../src/shared/state.js";
import { createCanvasWorkspace } from "../../src/slack/canvas-workspace.js";
import { createCanvases } from "../../src/slack/canvases.js";

const canvasId = "F123456";
const otherId = "F654321";
const context = { id: "task1", team: "T1", channel: "C1", user: "U1", thread: "1.0" };

async function fixture(t) {
    const directory = await mkdtemp(path.join(tmpdir(), "canvas-workspace-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const state = await new PersistentState(path.join(directory, "state.json"), { tasks: {} }).load();
    await state.update((draft) => { draft.tasks[context.id] = { ...context, status: "running" }; });
    const files = new Map([[canvasId, { id: canvasId, title: "Study notes", filetype: "canvas", channels: ["C1"] }]]);
    const document = { title: "Study notes", text: "Original lesson", revision: "revision1", truncated: false };
    const calls = [];
    const reads = [];
    const controls = { editError: false, readbackError: false, sections: [{ id: "section1" }] };
    let creations = 0;
    const resources = { read: async (...args) => {
        reads.push(args);
        if (controls.readbackError && calls.some(({ method }) => method === "canvases.edit")) {
            throw Error("Readback unavailable");
        }
        return { ...document };
    } };
    const request = async (url, options) => {
        const method = new URL(url).pathname.split("/").at(-1);
        const body = JSON.parse(options.body);
        calls.push({ method, body });
        if (method === "files.info") return Response.json({ ok: true, file: files.get(body.file) });
        if (method === "files.list") return Response.json({ ok: true, files: [...files.values()] });
        if (method === "canvases.sections.lookup") return Response.json({ ok: true, sections: controls.sections });
        if (method === "canvases.edit") {
            if (controls.editError) throw Error("Connection lost");
            document.revision += "-edited";
            document.text += "\nUpdated lesson";
            return Response.json({ ok: true });
        }
        throw Error("Unexpected method " + method);
    };
    const create = async () => {
        creations++;
        if (controls.createWait) await controls.createWait;
        files.set(otherId, { id: otherId, title: "New notes", filetype: "canvas", channels: ["C1"] });
        return { canvasId: otherId, url: "https://example.slack.com/docs/T1/" + otherId };
    };
    const workspace = (store = state, creator = create) => createCanvasWorkspace({ token: "test", state: store, resources,
        create: creator, request, workspaceUrl: "https://example.slack.com" });
    const api = workspace();
    const read = (extra = {}) => api.read({ canvasId, query: "lesson", ...extra }, context);
    const edits = () => calls.filter(({ method }) => method === "canvases.edit");
    return { state, files, document, calls, reads, controls, api, read, edits, workspace,
        creations: () => creations };
}

test("binding persistence", async (t) => {
    const f = await fixture(t);
    await f.api.bind({ canvasId, purpose: "study" }, context);
    const next = { ...context, id: "task2", thread: "2.0" };
    await f.state.update((draft) => { draft.tasks[next.id] = { ...next, status: "running" }; });
    const restored = await new PersistentState(f.state.file, { tasks: {} }).load();
    const result = await f.workspace(restored).create({ title: "Study", markdown: "Lesson", purpose: "study" }, next);
    assert.equal(result.canvasId, canvasId);
    assert.equal(result.existing, true);
    assert.equal(f.creations(), 0);
});

test("binding replacement", async (t) => {
    const f = await fixture(t);
    const args = { title: "Study", markdown: "Lesson", purpose: "study" };
    const created = await f.api.create(args, context);
    const reused = await f.api.create(args, context);
    assert.equal(created.canvasId, otherId);
    assert.equal(reused.canvasId, otherId);
    assert.equal(f.creations(), 1);
    await assert.rejects(f.api.bind({ canvasId, purpose: "study" }, context), /replaceCanvasId/);
    await f.api.bind({ canvasId, purpose: "study", replaceCanvasId: otherId }, context);
    assert.equal((await f.api.create(args, context)).canvasId, canvasId);
});

test("discovery authorization", async (t) => {
    const f = await fixture(t);
    f.files.set(otherId, { id: otherId, title: "Private notes", filetype: "canvas", channels: ["C2"] });
    const result = await f.api.find({}, context);
    assert.deepEqual(result.items.map((item) => item.canvasId), [canvasId]);
    assert.equal(result.unavailable, 1);
    const count = f.calls.length;
    await assert.rejects(f.api.find({}, { ...context, channel: "C2" }), /no longer authorized/);
    assert.equal(f.calls.length, count);
    await assert.rejects(f.api.read({ canvasId: otherId }, context), /not shared/);
    assert.equal(f.reads.length, 0);
});

test("read pagination", async (t) => {
    const f = await fixture(t);
    f.document.text = "a".repeat(12000) + "Tail";
    const first = await f.read();
    assert.equal(first.nextOffset, 12000);
    await assert.rejects(f.read({ offset: first.nextOffset }), /readId/);
    const second = await f.read({ offset: first.nextOffset, readId: first.readId });
    assert.equal(second.text, "Tail");
    assert.equal(second.nextOffset, null);
    assert.ok(f.reads.every((args) => args[0] === "C1" && args[3].fresh && args[3].canvasOnly));
    f.document.revision = "concurrent-edit";
    await assert.rejects(f.read({ offset: first.nextOffset, readId: first.readId }), /changed while paging/);
});

test("Canvas updates", async (t) => {
    const f = await fixture(t);
    const cases = [
        [{ operation: "insert_at_end", markdown: "Extra" },
            { operation: "insert_at_end", document_content: { type: "markdown", markdown: "Extra" } }],
        [{ operation: "replace", sectionId: "section1", markdown: "Corrected" },
            { operation: "replace", section_id: "section1",
                document_content: { type: "markdown", markdown: "Corrected" } }],
        [{ operation: "rename", title: "New title" },
            { operation: "rename", title_content: { type: "markdown", markdown: "New title" } }],
        [{ operation: "delete", sectionId: "section1" }, { operation: "delete", section_id: "section1" }],
    ];
    for (const [input, change] of cases) {
        const before = await f.read();
        const result = await f.api.update({ readId: before.readId, ...input }, context);
        assert.equal(result.status, "applied");
        assert.equal(result.verification, "read_back");
        assert.equal(result.changed, true);
        assert.deepEqual(f.edits().at(-1).body, { canvas_id: canvasId, changes: [change] });
        assert.equal(f.state.snapshot().canvasChanges[result.changeId].afterReadId, result.after.readId);
    }
});

test("edit validation", async (t) => {
    const f = await fixture(t);
    const before = await f.read();
    f.document.revision = "concurrent-edit";
    await assert.rejects(f.api.update({ readId: before.readId, operation: "insert_at_end", markdown: "Extra" }, context),
        /changed since reading/);
    const latest = await f.read();
    await assert.rejects(f.api.update({ readId: latest.readId, operation: "delete", sectionId: "unread" }, context),
        /Section was not returned/);
    f.controls.sections = [];
    await assert.rejects(f.api.update({ readId: latest.readId, operation: "delete", sectionId: "section1" }, context),
        /Section query is ambiguous|Section was not returned/);
    assert.equal(f.edits().length, 0);
    assert.deepEqual(f.state.snapshot().canvasChanges || {}, {});
});

test("truncated edits", async (t) => {
    const f = await fixture(t);
    f.document.truncated = true;
    const before = await f.read();
    for (const input of [{ operation: "replace_document", markdown: "All" },
        { operation: "replace", sectionId: "section1", markdown: "Part" },
        { operation: "delete", sectionId: "section1" }]) {
        await assert.rejects(f.api.update({ readId: before.readId, ...input }, context), /truncated/);
    }
    assert.equal(f.edits().length, 0);
    const result = await f.api.update({ readId: before.readId, operation: "insert_at_end", markdown: "Extra" }, context);
    assert.equal(result.status, "applied");
});

test("uncertain edits", async (t) => {
    const f = await fixture(t);
    const before = await f.read();
    f.controls.editError = true;
    const input = { readId: before.readId, operation: "insert_at_end", markdown: "Extra" };
    const result = await f.api.update(input, context);
    assert.equal(result.status, "uncertain");
    await assert.rejects(f.api.update(input, context), /uncertain/);
    const resolution = { operation: "resolve", changeId: result.changeId, outcome: "not_applied",
        reason: "The appended text is absent" };
    await assert.rejects(f.api.update({ ...resolution, readId: before.readId }, context), /Read the latest/);
    const latest = await f.read();
    assert.equal(latest.changes[0].changeId, result.changeId);
    const resolved = await f.api.update({ ...resolution, readId: latest.readId }, context);
    assert.equal(resolved.status, "resolved");
    assert.equal(f.state.snapshot().canvasChanges[result.changeId].resolution, "not_applied");
    assert.equal(f.edits().length, 1);
});

test("readback failure", async (t) => {
    const f = await fixture(t);
    const before = await f.read();
    f.controls.readbackError = true;
    const input = { readId: before.readId, operation: "insert_at_end", markdown: "Extra" };
    const result = await f.api.update(input, context);
    assert.equal(result.status, "applied");
    assert.equal(result.verification, "unavailable");
    assert.equal(f.state.snapshot().canvasChanges[result.changeId].status, "applied");
    const retry = await f.api.update(input, context);
    assert.deepEqual(retry, result);
    assert.equal(f.edits().length, 1);
});

test("operation deduplication", async (t) => {
    const f = await fixture(t);
    const before = await f.read();
    const input = { readId: before.readId, operation: "insert_at_end", markdown: "Extra" };
    const result = await f.api.update(input, context);
    const restored = await new PersistentState(f.state.file, { tasks: {} }).load();
    assert.deepEqual(await f.workspace(restored).update(input, context), result);
    assert.equal(f.edits().length, 1);
});

test("ambiguous sections", async (t) => {
    const f = await fixture(t);
    f.controls.sections.push({ id: "section2" });
    const before = await f.read();
    await assert.rejects(f.api.update({ readId: before.readId, operation: "replace",
        sectionId: "section1", markdown: "New lesson" }, context), /ambiguous/);
    assert.equal(f.edits().length, 0);
});

test("intentional repeated edits", async (t) => {
    const f = await fixture(t);
    const before = await f.read();
    const operation = { operation: "insert_at_end", markdown: "Extra" };
    const first = await f.api.update({ readId: before.readId, ...operation }, context);
    f.document.revision = before.revision;
    f.document.text = before.text;
    const next = { ...context, id: "task2", thread: "2.0" };
    await f.state.update((draft) => { draft.tasks[next.id] = { ...next, status: "running" }; });
    const latest = await f.api.read({ canvasId }, next);
    const second = await f.api.update({ readId: latest.readId, ...operation }, next);
    assert.equal(f.edits().length, 2);
    assert.notEqual(second.changeId, first.changeId);
    assert.equal(second.status, "applied");
});

test("uncertain creation", async (t) => {
    const f = await fixture(t);
    const changeId = "a".repeat(64);
    await f.state.update((draft) => {
        draft.canvasChanges = { [changeId]: { ...context, taskId: "old-task", canvasId: null,
            status: "uncertain", createdAt: 1,
            operation: { operation: "create", purpose: "study", title: "Study", markdown: "Lesson" } } };
    });
    const args = { title: "Study", markdown: "Lesson", purpose: "study" };
    await assert.rejects(f.api.create(args, context), /uncertain/);
    assert.equal(f.creations(), 0);
    const found = await f.api.find({}, context);
    assert.deepEqual(found.unresolvedCreations, [{ changeId, title: "Study", purpose: "study" }]);
    await assert.rejects(f.api.bind({ canvasId, purpose: "wrong", creationChangeId: changeId }, context),
        /Matching unresolved/);
    await f.api.bind({ canvasId, purpose: "study", creationChangeId: changeId }, context);
    const recovered = f.state.snapshot().canvasChanges[changeId];
    assert.equal(recovered.canvasId, canvasId);
    assert.equal(recovered.status, "resolved");
    assert.equal(recovered.resolution, "applied");
    assert.deepEqual((await f.api.find({}, context)).unresolvedCreations, []);
    assert.equal((await f.api.create(args, context)).canvasId, canvasId);
    assert.equal(f.creations(), 0);
});

test("creation resolution", async (t) => {
    const f = await fixture(t);
    const createId = "a".repeat(64);
    const editId = "b".repeat(64);
    const knownId = "c".repeat(64);
    await f.state.update((draft) => {
        const base = { ...context, status: "pending", canvasId: null, createdAt: 1 };
        draft.canvasChanges = {
            [createId]: { ...base, operation: { operation: "create", title: "Study" } },
            [editId]: { ...base, canvasId, operation: { operation: "insert_at_end", markdown: "Extra" } },
            [knownId]: { ...base, canvasId, operation: { operation: "create", title: "Study" } },
        };
    });
    const resolve = { operation: "resolve", outcome: "not_applied", reason: "Verified no Canvas was created" };
    for (const changeId of [editId, knownId]) {
        await assert.rejects(f.api.update({ ...resolve, changeId }, context), /current readId/);
    }
    await assert.rejects(f.api.update({ ...resolve, changeId: createId, outcome: "applied" }, context), /current readId/);
    const result = await f.api.update({ ...resolve, changeId: createId }, context);
    assert.equal(result.status, "resolved");
    assert.equal(result.outcome, "not_applied");
    assert.equal(f.edits().length, 0);
});

test("creation retry", async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const creator = createCanvases({ token: "test", state: f.state, workspaceUrl: "https://example.slack.com",
        request: async () => {
            if (++calls === 1) throw Error("Connection lost");
            return Response.json({ ok: true, canvas_id: otherId });
        } });
    const api = f.workspace(f.state, creator.create);
    const args = { title: "Notes", markdown: "Lesson" };
    await assert.rejects(api.create(args, context), /outcome is unknown/);
    const found = await api.find({}, context);
    const changeId = found.unresolvedCreations[0].changeId;
    await assert.rejects(api.create(args, context), /uncertain/);
    await api.update({ operation: "resolve", changeId, outcome: "not_applied",
        reason: "The user checked the channel and confirmed no canvas was created" }, context);
    assert.equal((await api.create(args, context)).canvasId, otherId);
    assert.equal(calls, 2);
    assert.equal(f.state.snapshot().canvasChanges[changeId].status, "applied");
    assert.equal(f.state.snapshot().canvasChanges[changeId].history[0].resolution, "not_applied");
});

test("concurrent creation", async (t) => {
    const f = await fixture(t);
    let release;
    f.controls.createWait = new Promise((resolve) => { release = resolve; });
    const args = { title: "Study", markdown: "Lesson", purpose: "study" };
    const first = f.api.create(args, context);
    try {
        await assert.rejects(f.api.create({ ...args, title: "Other title" }, context), /creation is running/);
    } finally { release(); }
    const result = await first;
    assert.equal(result.canvasId, otherId);
    assert.equal(f.creations(), 1);
});
