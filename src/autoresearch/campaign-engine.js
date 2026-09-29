import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { appendTask } from "../tasks/runtime.js";
import { autoresearchText } from "./copy.js";
import { logEvent } from "../shared/events.js";

const report = z.object({ kind: z.literal("report"), text: z.string().min(1).max(20000) }).strict();
const decision = z.discriminatedUnion("kind", [report,
    z.object({ kind: z.literal("blocked"), question: z.string().min(1).max(2000) }).strict(),
    z.object({ kind: z.literal("command"), purpose: z.string().min(1).max(1000),
        command: z.string().min(1).max(16000).refine((value) => !value.includes("\0")),
        cwd: z.string().startsWith("/").max(4096).regex(/^[^\x00-\x1f\x7f]+$/),
        timeoutSeconds: z.number().int().positive() }).strict(),
]);
const stopped = () => Object.assign(Error("Campaign execution changed"), { code: "CAMPAIGN_STOPPED" });
const limited = () => Object.assign(Error("Campaign budget exhausted"), { code: "CAMPAIGN_LIMIT" });

function recent(history, limit = 30000) {
    const result = history.slice(-50);
    while (result.length && JSON.stringify(result).length > limit) result.shift();
    return result;
}

async function bounded(operation, signal) {
    signal.throwIfAborted();
    let abort;
    const cancelled = new Promise((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(operation), cancelled]); }
    finally { signal.removeEventListener("abort", abort); }
}

export function createCampaignEngine({ state, execute, remote, artifacts, publish, post,
    now = Date.now, pollMs = 3000 }) {
    return { async run(job, inputSignal = new AbortController().signal) {
        const { id, runId } = job;
        const get = () => state.snapshot().autoresearchJobs?.[id];
        const budget = { maxSteps: 24, maxCommands: 24, wallSeconds: 28800, gpuSeconds: 115200,
            trialSeconds: 1800, gpus: 4, ...job.campaign };
        const deadline = typeof job.executionDeadline === "number" ? job.executionDeadline :
            Date.parse(job.executionDeadline);
        if (!Number.isFinite(deadline)) throw Error("Campaign execution deadline is required");
        const expiry = new AbortController();
        const signal = AbortSignal.any([inputSignal, expiry.signal]);
        const timer = setTimeout(() => expiry.abort(limited()), Math.max(1, deadline - now()));
        const context = Object.fromEntries(["team", "user", "channel", "thread", "key", "profile"]
            .map((key) => [key, job[key]]));
        const check = () => {
            signal.throwIfAborted();
            if (now() >= deadline) throw limited();
            const current = get();
            if (current?.runId !== runId || current.status !== "running") throw stopped();
            return current;
        };
        async function update(change) {
            return state.update((data) => {
                const current = data.autoresearchJobs[id];
                if (current?.runId !== runId || current.status !== "running") throw stopped();
                current.campaignState ??= { steps: 0, commands: 0, gpuSeconds: 0, history: [] };
                const status = current.status;
                change(current, current.campaignState);
                current.updatedAt = now();
                if (current.status !== status) current.revision += 1;
                return current;
            });
        }
        async function notify(current, text) {
            if (get()?.runId !== runId) return;
            try {
                await publish(current);
                if (text && get()?.runId === runId) await post(current, text.slice(0, 20000));
            } catch {
                await state.update((data) => {
                    if (data.autoresearchJobs[id]?.runId === runId) {
                        data.autoresearchJobs[id].statusDelivery = "unconfirmed";
                    }
                });
            }
        }
        async function stage(provider, extra = {}, finalOnly = false) {
            check();
            const task = await state.update((data) => {
                const current = data.autoresearchJobs[id];
                if (current?.runId !== runId || current.status !== "running") throw stopped();
                const checkpoint = current.campaignState;
                if (checkpoint.steps >= budget.maxSteps) throw limited();
                checkpoint.steps += 1;
                current.stage = provider === "claude" ? "reviewing" : finalOnly ? "reporting" : "planning";
                const prompt = JSON.stringify({ objective: budget.objective, title: budget.title,
                    budget: { maxSteps: budget.maxSteps, maxCommands: budget.maxCommands,
                        gpuSeconds: budget.gpuSeconds, trialSeconds: budget.trialSeconds, gpus: budget.gpus,
                        executionDeadline: deadline, steps: checkpoint.steps,
                        commands: checkpoint.commands, reservedGpuSeconds: checkpoint.gpuSeconds },
                    history: finalOnly ? recent(checkpoint.history.map((entry) => ({ ...entry,
                        command: entry.command?.slice(0, 500), output: entry.output?.slice(-1000) })), 12000) :
                        recent(checkpoint.history),
                    updates: current.updates || [], finalOnly, ...extra });
                if (prompt.length > 64000) throw Error("Campaign context exceeds limit");
                const taskId = appendTask(data, { ...current, prompt }, now());
                return Object.assign(data.tasks[taskId], { status: "running", delivery: "suppressed",
                    startedAt: now(), researchId: id, autoresearchId: id, researchRunId: runId,
                    researchStage: provider === "claude" ? "campaign-review" : "campaign", provider });
            });
            logEvent("campaign_stage", { campaignId: id, runId, taskId: task.id, stage: task.researchStage,
                provider, steps: get()?.campaignState.steps });
            try {
                const result = await bounded(() => execute(task, signal), signal);
                check();
                const parsed = (finalOnly ? report : decision).parse(JSON.parse(result.answer));
                await state.update((data) => Object.assign(data.tasks[task.id], {
                    status: "completed", delivery: "suppressed", finishedAt: now() }));
                return parsed;
            } catch (error) {
                await state.update((data) => {
                    if (data.tasks[task.id]) Object.assign(data.tasks[task.id], {
                        status: signal.aborted ? "cancelled" : "failed", delivery: "suppressed",
                        errorCode: signal.aborted ? "TASK_CANCELLED" : "CAMPAIGN_STAGE_FAILED", finishedAt: now() });
                });
                throw error;
            }
        }
        async function cancelPending() {
            const current = get();
            if (current?.runId !== runId || !current.campaignState?.pending) return false;
            const cancellation = AbortSignal.timeout(10000);
            const pendingId = current.campaignState.pending.args.id;
            let confirmed = false;
            try {
                let result = await bounded(() => remote.run("cancel", { id: pendingId },
                    context, cancellation), cancellation);
                while (true) {
                    if (["completed", "failed", "cancelled", "timed_out"].includes(result.status) ||
                        result.orphanStopped === true) { confirmed = true; break; }
                    if (!["starting", "running"].includes(result.status)) break;
                    await delay(Math.min(pollMs, 500), undefined, { signal: cancellation });
                    result = await bounded(() => remote.run("job", { id: pendingId, offset: 0 },
                        context, cancellation), cancellation);
                }
            } catch {}
            await state.update((data) => {
                const current = data.autoresearchJobs[id];
                if (current?.runId !== runId || current.campaignState?.pending?.args.id !== pendingId) return;
                current.campaignState.cleanupPending = !confirmed;
                current.campaignState.pending.stoppedConfirmed = confirmed;
            });
            return confirmed;
        }
        async function followPending() {
            let pending = check().campaignState.pending;
            if (!pending.submitted) {
                await bounded(() => remote.run("exec", pending.args, context, signal), signal);
                check();
                await update((current, checkpoint) => { checkpoint.pending.submitted = true; });
            }
            while (true) {
                pending = check().campaignState.pending;
                const query = { id: pending.args.id, offset: pending.offset || 0 };
                const result = await bounded(() => remote.run("job", query, context, signal), signal);
                check();
                if (!result || !["starting", "running", "completed", "failed", "cancelled", "timed_out",
                    "interrupted"].includes(result.status)) throw Error("Invalid remote job status");
                if (result.output !== undefined && (typeof result.output !== "string" ||
                    result.output.length > 100000)) throw Error("Invalid remote job output");
                if (result.hasMore && (!Number.isSafeInteger(result.nextOffset) ||
                    result.nextOffset <= (pending.offset || 0))) throw Error("Invalid remote log cursor");
                const terminal = !["starting", "running"].includes(result.status);
                const finished = terminal && !result.hasMore;
                if (result.status === "interrupted" && !pending.stoppedConfirmed && !await cancelPending()) {
                    const blocked = await update((current) => {
                        current.status = "awaiting_input";
                        current.stage = "";
                        current.questions = [autoresearchText("CAMPAIGN_ORPHAN_CHECK")];
                    });
                    logEvent("campaign_blocked", { campaignId: id, runId, status: "awaiting_input" });
                    await notify(blocked, blocked.questions[0]);
                    return false;
                }
                await update((current, checkpoint) => {
                    const active = checkpoint.pending;
                    const output = (active.output || "") + (result.output || "");
                    active.outputTruncated ||= output.length > 12000 || result.logTruncated === true;
                    active.output = output.slice(-12000);
                    if (Number.isSafeInteger(result.nextOffset) && result.nextOffset >= (active.offset || 0)) {
                        active.offset = result.nextOffset;
                    }
                    if (finished) {
                        checkpoint.history = recent([...checkpoint.history, { id: active.args.id,
                            purpose: active.purpose, command: active.args.command.slice(0, 4000),
                            status: result.status, exitCode: result.exitCode, output: active.output,
                            outputTruncated: active.outputTruncated === true }]);
                        delete checkpoint.pending;
                        delete checkpoint.cleanupPending;
                    }
                });
                if (finished) {
                    logEvent("campaign_command", { campaignId: id, runId, jobId: pending.args.id,
                        status: result.status, commands: get()?.campaignState.commands,
                        reservedGpuSeconds: get()?.campaignState.gpuSeconds });
                    return true;
                }
                if (!terminal) await delay(pollMs, undefined, { signal });
            }
        }
        try {
            check();
            await update(() => {});
            const connection = await bounded(() => remote.run("status", {}, context, signal), signal);
            if (connection?.connected !== true) throw Error("Remote workspace is not connected");
            while (true) {
                let current = check();
                if (current.campaignState.pending) {
                    if (!await followPending()) return;
                    current = check();
                }
                if (current.campaignState.draft) {
                    if (!current.campaignState.review) {
                        const review = await stage("claude", { draft: current.campaignState.draft }, true);
                        await update((value, checkpoint) => { checkpoint.review = review.text; });
                    }
                    const checkpoint = check().campaignState;
                    const final = await stage("codex", { draft: checkpoint.draft, review: checkpoint.review }, true);
                    const saved = await artifacts.put(final.text, { mime: "text/markdown", source: {
                        provider: "autoresearch", channel: job.channel, fileId: id, version: runId,
                        kind: "campaign-report", title: budget.title } });
                    check();
                    const completed = await update((value, savedState) => {
                        savedState.finalReportId = saved.id;
                        value.finalReportId = saved.id;
                        value.status = "completed";
                        value.stage = "";
                        value.completedAt = now();
                    });
                    logEvent("campaign_completed", { campaignId: id, runId, status: "completed" });
                    await notify(completed, final.text);
                    return;
                }
                const checkpoint = current.campaignState;
                const finishOnly = checkpoint.steps >= budget.maxSteps - 3 ||
                    checkpoint.commands >= budget.maxCommands ||
                    budget.gpuSeconds - checkpoint.gpuSeconds < budget.gpus;
                const next = await stage("codex", {}, finishOnly);
                if (next.kind === "blocked") {
                    const blocked = await update((value) => {
                        value.status = "awaiting_input";
                        value.stage = "";
                        value.questions = [next.question];
                    });
                    logEvent("campaign_blocked", { campaignId: id, runId, status: "awaiting_input" });
                    await notify(blocked, next.question);
                    return;
                }
                if (next.kind === "report") {
                    await update((value, checkpoint) => { checkpoint.draft = next.text; });
                    continue;
                }
                check();
                if (next.timeoutSeconds > budget.trialSeconds) throw Error("Command exceeds trial budget");
                await update((value, checkpoint) => {
                    const gpuSeconds = next.timeoutSeconds * budget.gpus;
                    if (checkpoint.commands >= budget.maxCommands || checkpoint.gpuSeconds + gpuSeconds >
                        budget.gpuSeconds || next.timeoutSeconds * 1000 > deadline - now()) throw limited();
                    checkpoint.commands += 1;
                    checkpoint.gpuSeconds += gpuSeconds;
                    value.stage = "executing";
                    checkpoint.pending = { purpose: next.purpose, submitted: false, offset: 0,
                        args: { id: randomUUID(), command: next.command, cwd: next.cwd,
                            timeoutSeconds: next.timeoutSeconds } };
                });
                const reserved = check();
                logEvent("campaign_command", { campaignId: id, runId,
                    jobId: reserved.campaignState.pending.args.id, status: "reserved",
                    commands: reserved.campaignState.commands, reservedGpuSeconds: reserved.campaignState.gpuSeconds });
                await publish(reserved);
            }
        } catch (error) {
            await cancelPending();
            if ((error?.code === "CAMPAIGN_LIMIT" || expiry.signal.aborted) && !inputSignal.aborted &&
                get()?.runId === runId && get()?.status === "running") {
                const current = await update((value) => {
                    value.status = "limited";
                    value.stage = "";
                    value.limitReason = now() >= deadline ? "time" : "budget";
                });
                const checkpoint = current.campaignState;
                const summary = autoresearchText("CAMPAIGN_LIMIT_SUMMARY", checkpoint) + " " +
                    autoresearchText(checkpoint.pending ? "CAMPAIGN_PENDING_CHECK" : "CAMPAIGN_RESULTS_SAVED");
                const history = recent(checkpoint.history.map((entry) => ({ ...entry,
                    command: entry.command?.slice(0, 500), output: entry.output?.slice(-1000) })), 14000);
                const text = [budget.title, summary, checkpoint.draft || "", ...history.map((entry) =>
                    `${entry.purpose}\n${entry.status}\n${entry.output || ""}`)].join("\n\n").slice(0, 20000);
                const saved = await artifacts.put(text, { mime: "text/markdown", source: {
                    provider: "autoresearch", channel: job.channel, fileId: id, version: runId,
                    kind: "campaign-report", title: budget.title } });
                const updated = await state.update((data) => {
                    const latest = data.autoresearchJobs[id];
                    if (latest?.runId !== runId || latest.status !== "limited") throw stopped();
                    latest.finalReportId = saved.id;
                    latest.campaignState.finalReportId = saved.id;
                    return latest;
                });
                logEvent("campaign_limited", { campaignId: id, runId, status: "limited",
                    steps: updated.campaignState.steps, commands: updated.campaignState.commands,
                    reservedGpuSeconds: updated.campaignState.gpuSeconds });
                await notify(updated, text);
                return;
            }
            throw error;
        } finally { clearTimeout(timer); }
    } };
}
