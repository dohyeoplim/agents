import { z } from "zod";
import { failureCode, logFailure, providerError } from "../shared/diagnostics.js";
import { appendTask } from "../tasks/runtime.js";
import { researchText } from "./copy.js";
import { researchAncestors } from "./library.js";
import { createResearchExport } from "./export.js";

const clarification = z.object({ ready: z.boolean(), title: z.string().trim().min(1).max(150),
    brief: z.string().trim().min(1).max(6000), questions: z.array(z.string().trim().min(1).max(500)).max(3),
}).strict().refine((value) => value.ready ? !value.questions.length : value.questions.length > 0);
const review = z.object({ verdict: z.enum(["ready", "revise", "needs_research"]),
    feedback: z.array(z.string().max(1500)).max(12), gaps: z.array(z.string().max(1500)).max(12),
}).strict();
const normalizeGap = (gap) => gap.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

export function researchOutput(text, kind) {
    const content = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
    try { return (kind === "clarify" ? clarification : review).parse(JSON.parse(content)); }
    catch { throw Error(researchText("RESEARCH_OUTPUT_INVALID", { kind })); }
}

export function createResearchEngine({ state, execute, library, canvases, publish, post, now = Date.now }) {
    const get = (id) => state.snapshot().researchJobs[id];
    const exportReport = createResearchExport({ state, library, canvases });

    async function update(id, runId, changes, scopeVersion) {
        const result = await state.update((data) => {
            const job = data.researchJobs[id];
            if (job.runId !== runId || !["running", "clarifying"].includes(job.status)) {
                throw Error(researchText("RESEARCH_STOPPED"));
            }
            if (scopeVersion !== undefined && (job.scopeVersion || 0) !== scopeVersion) return null;
            const now = Date.now();
            if (changes.stage !== undefined && changes.stage !== job.stage) job.phaseStartedAt = now;
            Object.assign(job, changes, { updatedAt: now, revision: job.revision + 1 });
            return job;
        });
        if (result) await publish(result);
        return result;
    }

    async function stage(id, runId, researchStage, provider, signal, extra = {}) {
        signal.throwIfAborted();
        const job = get(id);
        if (job.runId !== runId) throw Error(researchText("RESEARCH_RUN_CHANGED"));
        const independent = ["explore", "counter"].includes(researchStage);
        const reports = (job.reports || []).filter((report) =>
            !independent || report.provider === provider).slice(-12);
        const parent = researchAncestors(state.snapshot(), job)[0];
        const prompt = JSON.stringify({ researchId: id, title: job.title,
            ...(parent ? { parentId: parent.id, previousRound: { title: parent.title, brief: parent.brief,
                finalReportId: parent.finalReportId } } : {}),
            ...(researchStage === "clarify" ? {
                request: job.request, questions: job.questions, answers: job.answers || [],
                conversation: { channel: job.channel, thread: job.thread, messageTs: job.sourceMessageTs },
            } : {}),
            brief: job.brief, updates: job.updates || [],
            reports, finishRequested: job.finishRequested === true, ...extra });
        if (prompt.length > 64000) throw Error(researchText("RESEARCH_SCOPE_LIMIT"));
        const task = await state.update((data) => {
            const current = data.researchJobs[id];
            if (current.runId !== runId || !["running", "clarifying"].includes(current.status)) {
                throw Error(researchText("RESEARCH_STOPPED"));
            }
            const taskId = appendTask(data, { ...current, messageTs: current.sourceMessageTs, prompt });
            return Object.assign(data.tasks[taskId], { status: "running", startedAt: Date.now(),
                researchId: id, researchRunId: runId, researchStage, provider });
        });
        let result;
        try {
            await publish(get(id));
            result = await execute(task, signal);
            signal.throwIfAborted();
            const report = await library.saveReport({ ...get(id), runId }, researchStage, result.answer, { provider });
            await state.update((data) => {
                Object.assign(data.tasks[task.id], { status: "completed", delivery: "suppressed",
                    session: result.session, reportId: report.id, finishedAt: Date.now() });
            });
            if (get(id).runId === runId) await publish(get(id));
            return { ...report, text: result.answer };
        } catch (error) {
            await state.update((data) => {
                Object.assign(data.tasks[task.id], { status: signal.aborted ? "cancelled" : "failed",
                    delivery: "suppressed", finishedAt: Date.now(), errorCode: failureCode(error) });
            });
            if (signal.aborted) throw error;
            logFailure(error, { component: "research", taskId: task.id, provider, stage: researchStage });
            throw providerError(provider, error);
        }
    }

    async function clarify(job, signal) {
        while (true) {
            const version = get(job.id).scopeVersion || 0;
            const result = await stage(job.id, job.runId, "clarify", "codex", signal);
            const plan = researchOutput(result.text, "clarify");
            const updated = await update(job.id, job.runId, {
                ...plan, status: plan.ready ? "ready" : "awaiting_input", stage: "", confirmationAfter: now(),
            }, version);
            if (updated) return;
        }
    }

    async function investigate(job, signal, extra, executeStage) {
        await update(job.id, job.runId, { stage: researchText("STAGE_RESEARCH") });
        const sibling = new AbortController();
        const combined = AbortSignal.any([signal, sibling.signal]);
        let failure;
        const run = (name, provider) => executeStage(name, provider, combined, extra).catch((error) => {
            failure ??= error;
            sibling.abort();
            throw error;
        });
        const results = await Promise.allSettled([
            run("explore", "codex"), run("counter", "claude"),
        ]);
        if (results.some((result) => result.status === "rejected")) throw failure;
    }

    async function run(job, signal) {
        const { id, runId } = job;
        const sourceCount = () => new Set(Object.values(state.snapshot().researchSources || {})
            .filter((source) => source.researchId === id)
            .map((source) => source.url + ":" + (source.contentHash || source.artifactId))).size;
        async function saveCheckpoint(change) {
            return state.update((data) => {
                signal.throwIfAborted();
                const current = data.researchJobs[id];
                if (current.runId !== runId || current.status !== "running") {
                    throw Error(researchText("RESEARCH_STOPPED"));
                }
                change(current);
                return current.checkpoint;
            });
        }
        async function executeStage(name, provider, stageSignal, extra) {
            stageSignal.throwIfAborted();
            const reportId = get(id).checkpoint.reports[name];
            if (reportId) {
                let result;
                let offset = 0;
                let text = "";
                do {
                    stageSignal.throwIfAborted();
                    result = await library.readReport(get(id), reportId, offset);
                    text += result.text;
                    offset = result.nextOffset;
                } while (offset !== null);
                return { ...result, id: reportId, text };
            }
            const result = await stage(id, runId, name, provider, stageSignal, extra);
            if (name === "review") researchOutput(result.text, "review");
            await saveCheckpoint((current) => { current.checkpoint.reports[name] = result.id; });
            return result;
        }
        while (true) {
            const checkpoint = await saveCheckpoint((current) => {
                if (current.checkpoint?.version !== (current.scopeVersion || 0)) {
                    current.checkpoint = { version: current.scopeVersion || 0, reports: {},
                        gaps: [], feedback: [], seenGaps: [], sourcesBefore: sourceCount() };
                }
            });
            if (!get(id).finishRequested) {
                await investigate(job, signal, { gaps: checkpoint.gaps, feedback: checkpoint.feedback }, executeStage);
            }
            const gainedEvidence = sourceCount() > checkpoint.sourcesBefore;
            await update(id, runId, { stage: researchText("STAGE_SYNTHESIS") });
            const version = get(id).scopeVersion || 0;
            const draft = await executeStage("synthesize", "codex", signal);
            await update(id, runId, { stage: researchText("STAGE_REVIEW"), draftReportId: draft.id });
            const critique = await executeStage("review", "claude", signal, { draftReportId: draft.id });
            const assessment = researchOutput(critique.text, "review");
            const seenGaps = new Set([...(checkpoint.seenGaps || []), ...checkpoint.gaps.map(normalizeGap)]);
            const newGaps = assessment.gaps.filter((gap) => normalizeGap(gap) && !seenGaps.has(normalizeGap(gap)));
            const fingerprint = JSON.stringify(assessment.gaps.map(normalizeGap).sort());
            if (assessment.verdict === "needs_research" && newGaps.length &&
                !get(id).finishRequested && gainedEvidence) {
                await saveCheckpoint((current) => {
                    current.checkpoint = { version, reports: {}, sourcesBefore: sourceCount(),
                        previousGaps: fingerprint, gaps: newGaps, feedback: assessment.feedback,
                        seenGaps: [...new Set([...seenGaps, ...assessment.gaps.map(normalizeGap)])] };
                });
                continue;
            }
            let final = draft;
            if (assessment.verdict !== "ready" || assessment.feedback.length) {
                await update(id, runId, { stage: researchText("STAGE_REVISION") });
                final = await executeStage("revise", "codex", signal, {
                    draftReportId: draft.id, reviewReportId: critique.id, assessment,
                    finishWithAvailableEvidence: true,
                });
            }
            const completed = await update(id, runId, { status: "completed", stage: "", finalReportId: final.id,
                questions: [], reviewReportId: critique.id, completedAt: Date.now(), error: "" }, version);
            if (!completed) continue;
            const text = final.text.length <= 24000 ? final.text : final.text.slice(0, 24000) +
                "\n\n" + researchText("RESEARCH_REPORT_PARTIAL");
            try { await post(get(id), text); }
            catch {
                await state.update((data) => {
                    if (data.researchJobs[id].runId === runId) data.researchJobs[id].error =
                        researchText("RESEARCH_REPORT_UNCONFIRMED");
                });
                await publish(get(id));
            }
            return;
        }
    }

    async function canvas(job, signal) {
        await update(job.id, job.runId, { stage: researchText("STAGE_CANVAS") });
        const url = await exportReport(job, signal);
        await update(job.id, job.runId, { status: "completed", stage: "", canvasBusy: false });
        await post(get(job.id), researchText("RESEARCH_CANVAS_SAVED", { url }));
    }

    return { clarify, run, canvas };
}
