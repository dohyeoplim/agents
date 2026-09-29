import { appendTask, taskSpec } from "../tasks/runtime.js";
import { researchText } from "./copy.js";

export function reportChunks(text, limit = 20000) {
    const chunks = [];
    let start = 0;
    let boundary = 0;
    let offset = 0;
    let fence;
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
        if (offset + line.length - start > limit) {
            if (boundary <= start) throw Error(researchText("RESEARCH_CANVAS_BLOCK_LIMIT"));
            chunks.push(text.slice(start, boundary));
            start = boundary;
            if (offset + line.length - start > limit) throw Error(researchText("RESEARCH_CANVAS_BLOCK_LIMIT"));
        }
        const marker = line.replace(/\r?\n$/, "").match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (marker) {
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
                fence = undefined;
            }
        }
        offset += line.length;
        if (!fence) boundary = offset;
    }
    if (start < text.length) chunks.push(text.slice(start));
    return chunks;
}

export function createResearchExport({ state, library, canvases }) {
    return async (job, signal) => {
        if (!canvases) throw Error(researchText("RESEARCH_CANVAS_UNAVAILABLE"));
        let markdown = "";
        let offset = 0;
        do {
            signal.throwIfAborted();
            const page = await library.readReport(job, job.finalReportId, offset);
            markdown += page.text;
            offset = page.nextOffset;
        } while (offset !== null);
        const chunks = reportChunks(markdown);
        if (!chunks.length) throw Error(researchText("RESEARCH_NO_FINAL"));
        const context = await state.update((data) => {
            signal.throwIfAborted();
            const current = data.researchJobs[job.id];
            if (current.runId !== job.runId || current.status !== "running") {
                throw Error(researchText("RESEARCH_STOPPED"));
            }
            if (current.canvasExport?.reportId !== job.finalReportId) {
                current.canvasExport = { reportId: job.finalReportId, nextChunk: 0 };
            }
            const exported = current.canvasExport;
            if (!exported.taskId) {
                exported.taskId = appendTask(data, { ...job, prompt: "", messageTs: job.sourceMessageTs });
            }
            const task = data.tasks[exported.taskId] ??= {
                ...taskSpec({ ...job, prompt: "" }), id: exported.taskId,
            };
            return Object.assign(task, { status: "running", delivery: "suppressed", startedAt: Date.now(),
                researchId: job.id, researchRunId: job.runId, researchStage: "canvas", provider: "slack" });
        });
        const get = () => state.snapshot().researchJobs[job.id].canvasExport;
        const save = (changes) => state.update((data) => {
            const current = data.researchJobs[job.id];
            const exported = current.canvasExport;
            if (current.runId !== job.runId || exported.reportId !== job.finalReportId ||
                exported.taskId !== context.id) {
                throw Error(researchText("RESEARCH_RUN_CHANGED"));
            }
            Object.assign(exported, changes);
        });
        try {
            if (!get().canvasId) {
                signal.throwIfAborted();
                const created = await canvases.create({ title: job.title, markdown: chunks[0],
                    purpose: `research:${job.id}:${job.finalReportId}`.slice(0, 100) }, context, signal);
                await save({ canvasId: created.canvasId, url: created.url, nextChunk: 1, needsRead: true });
            }
            if (get().needsRead) {
                signal.throwIfAborted();
                const read = await canvases.read({ canvasId: get().canvasId }, context, signal);
                await save({ needsRead: false, revision: read.revision });
            }
            while (get().nextChunk < chunks.length) {
                signal.throwIfAborted();
                let exported = get();
                const resolved = Object.values(state.snapshot().canvasChanges || {}).find((change) =>
                    change.taskId === context.id && change.beforeReadId === exported.pendingReadId &&
                    change.canvasId === exported.canvasId && change.operation.operation === "insert_at_end" &&
                    change.operation.markdown === chunks[exported.nextChunk].trim() && change.status === "resolved");
                if (resolved?.resolution === "applied") {
                    const receipt = state.snapshot().canvasReads?.[resolved.afterReadId];
                    if (!receipt?.revision) throw Error(researchText("RESEARCH_CANVAS_UNVERIFIED"));
                    await save({ nextChunk: exported.nextChunk + 1, pendingReadId: null, revision: receipt.revision });
                    continue;
                }
                if (resolved?.resolution === "not_applied") {
                    await save({ pendingReadId: null });
                    exported = get();
                }
                if (!exported.pendingReadId) {
                    const read = await canvases.read({ canvasId: exported.canvasId }, context, signal);
                    if (exported.revision && read.revision !== exported.revision) {
                        throw Error(researchText("RESEARCH_CANVAS_CHANGED"));
                    }
                    await save({ pendingReadId: read.readId, revision: read.revision });
                    exported = get();
                }
                const result = await canvases.update({ readId: exported.pendingReadId,
                    operation: "insert_at_end", markdown: chunks[exported.nextChunk] }, context, signal);
                if (result.status !== "applied" || result.warning) {
                    throw Error(researchText("RESEARCH_CANVAS_UNCERTAIN"));
                }
                await save({ nextChunk: exported.nextChunk + 1, pendingReadId: null,
                    revision: result.after?.revision || exported.revision, needsRead: !result.after?.revision });
                if (!result.after?.revision) throw Error(researchText("RESEARCH_CANVAS_UNVERIFIED"));
            }
            signal.throwIfAborted();
            await state.update((data) => {
                if (data.tasks[context.id]?.researchRunId === job.runId) {
                    Object.assign(data.tasks[context.id], { status: "completed", finishedAt: Date.now() });
                }
            });
            return get().url;
        } catch (error) {
            await state.update((data) => {
                if (data.tasks[context.id]?.researchRunId === job.runId) {
                    Object.assign(data.tasks[context.id], {
                        status: signal.aborted ? "cancelled" : "failed", finishedAt: Date.now(),
                    });
                }
            });
            throw error;
        }
    };
}
