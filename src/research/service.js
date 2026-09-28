import { randomUUID } from "node:crypto";
import { profileFor } from "../agents/profiles.js";
import { loadPersonal } from "../integrations/settings.js";
import { createResearchEngine } from "./engine.js";
import { researchText } from "./copy.js";
import { proposalInput, controlInput, resultInput } from "./tools.js";
import { researchActions } from "./actions.js";
import { researchProgress } from "./progress.js";

const resumable = ["paused", "interrupted", "failed"];
const activeStatuses = ["queued", "running", "clarifying"];
const sameOwner = (job, context) => ["team", "user", "channel", "thread"].every((key) => job[key] === context[key]);
const timestamp = (value) => /^\d+\.\d{1,6}$/.test(value || "") ?
    BigInt(value.split(".")[0] + value.split(".")[1].padEnd(6, "0")) : null;

export function createResearch({ state, execute, library, config, post, personal = loadPersonal, now = Date.now }) {
    const active = new Map();
    const pending = new Map();
    let ui;
    let closed = false;
    const get = (id) => state.snapshot().researchJobs?.[id];

    function view(job) {
        return { id: job.id, parentId: job.parentId, round: job.round || 1, title: job.title, brief: job.brief,
            status: job.status, revision: job.revision, questions: job.questions || [],
            actions: researchActions(job), progress: researchProgress(job, state.snapshot()),
            finalReportId: job.finalReportId, error: job.error || "" };
    }

    async function authorize(job, context = job) {
        const current = await config();
        const settings = await personal();
        const route = current.channels[job.channel];
        if (!sameOwner(job, context) || current.team !== job.team || !current.users.includes(job.user) ||
            job.user !== (settings?.owner || current.users[0]) || !route || route.enabled === false ||
            profileFor(route) !== job.profile ||
            job.key !== `${job.team}:${job.channel}:${job.thread}:${route.agent}`) {
            throw Error(researchText("RESEARCH_UNAVAILABLE"));
        }
    }

    async function inspect(context) {
        await authorize(context);
        const rounds = Object.values(state.snapshot().researchJobs || {}).filter((job) => sameOwner(job, context))
            .reverse().sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
        return { latestId: rounds[0]?.id, rounds: rounds.map(view) };
    }

    function proposal(data, args, context) {
        if (closed) throw Error(researchText("RESEARCH_STOPPED"));
        const jobs = data.researchJobs ??= {};
        const current = args.id ? jobs[args.id] : null;
        if (args.id && (!current || !sameOwner(current, context) || current.profile !== context.profile ||
            current.key !== context.key)) {
            throw Error(researchText("RESEARCH_NOT_FOUND"));
        }
        const parent = args.parentId ? jobs[args.parentId] : null;
        if (args.parentId && (!parent || !sameOwner(parent, context) || parent.status !== "completed" ||
            !parent.finalReportId)) throw Error(researchText("RESEARCH_PARENT_UNAVAILABLE"));
        if (current) {
            if (args.revision !== current.revision) throw Error(researchText("RESEARCH_CHANGED"));
            if (current.mode === "canvas") throw Error(researchText("RESEARCH_ACTION_UNAVAILABLE"));
            if (!["ready", "awaiting_input", ...resumable].includes(current.status)) {
                throw Error(researchText("RESEARCH_PAUSE_TO_EDIT"));
            }
            if (args.parentId && args.parentId !== current.parentId) {
                throw Error(researchText("RESEARCH_PARENT_UNAVAILABLE"));
            }
            if (current.title === args.title && current.brief === args.brief &&
                JSON.stringify(current.questions || []) === JSON.stringify(args.questions)) return current;
        } else {
            const existing = Object.values(jobs).find((job) => sameOwner(job, context) &&
                job.proposalTaskId && job.proposalTaskId === context.id);
            if (existing) return existing;
            if (Object.values(jobs).some((job) => sameOwner(job, context) && job.status !== "completed")) {
                throw Error(researchText("RESEARCH_ROUND_ACTIVE"));
            }
        }
        const job = current || { id: randomUUID(), team: context.team, user: context.user,
            channel: context.channel, thread: context.thread, key: context.key, profile: context.profile,
            parentId: parent?.id, round: parent ? (parent.round || 1) + 1 : 1,
            createdAt: Date.now(), reports: [], answers: [], updates: [], events: [], revision: -1, scopeVersion: 0 };
        Object.assign(job, { title: args.title, brief: args.brief, questions: args.questions,
            request: context.prompt || args.brief, fileIds: context.fileIds || job.fileIds || [],
            sourceMessageTs: context.messageTs || job.sourceMessageTs, proposalTaskId: context.id,
            proposalMessageTs: context.messageTs, status: args.questions.length ? "awaiting_input" : "ready",
            confirmationAfter: now(),
            mode: "run", runId: randomUUID(), stage: "", error: "", canvasBusy: false,
            finishRequested: false, updates: [], answers: [], ready: !args.questions.length,
            scopeVersion: (job.scopeVersion || 0) + 1, revision: job.revision + 1, updatedAt: Date.now() });
        jobs[job.id] = job;
        return job;
    }

    async function propose(input, context) {
        const args = proposalInput.parse(input);
        await authorize(context);
        if (context.researchId || context.scheduleId || context.briefingDate) {
            throw Error(researchText("RESEARCH_UNAVAILABLE"));
        }
        const job = await state.update((data) => proposal(data, args, context));
        await publish(job);
        return view(get(job.id));
    }

    async function act(input, context) {
        const args = controlInput.parse(input);
        if (context.researchId || context.scheduleId || context.briefingDate) {
            throw Error(researchText("RESEARCH_UNAVAILABLE"));
        }
        await control(args.id, args.action, undefined, { ...context, revision: args.revision });
        return view(get(args.id));
    }

    async function readResult(input, context) {
        const { id, offset } = resultInput.parse(input);
        const job = get(id);
        if (!job) throw Error(researchText("RESEARCH_NOT_FOUND"));
        await authorize(job, context);
        const reportId = job.finalReportId || [...(job.reports || [])].reverse().find((report) =>
            ["explore", "counter", "synthesize", "revise"].includes(report.stage))?.id;
        if (!reportId) return { available: false, ...view(job) };
        return { available: true, complete: job.status === "completed",
            report: await library.readReport(job, reportId, offset) };
    }

    async function publish(job) {
        await authorize(job);
        try { await ui?.publish(job); }
        catch { console.warn("Research status delivery unavailable"); }
    }

    async function send(job, text) {
        await authorize(job);
        return post(job, text);
    }

    const engine = createResearchEngine({ state, execute, library, publish, post: send, now });

    function pump() {
        if (closed) return;
        for (const [id, mode] of pending) {
            if (active.size >= 2) break;
            if (active.has(id)) continue;
            pending.delete(id);
            const job = get(id);
            if (!job || !activeStatuses.includes(job.status)) continue;
            const controller = new AbortController();
            const entry = { controller, promise: null };
            active.set(id, entry);
            entry.promise = Promise.resolve().then(async () => {
                await authorize(job);
                if (controller.signal.aborted) return;
                if (job.status === "queued") {
                    await state.update((data) => {
                        const current = data.researchJobs[id];
                        if (current.runId === job.runId && current.status === "queued") current.status = "running";
                    });
                }
                await publish(get(id));
                await engine[mode](get(id), controller.signal);
            }).catch(async (error) => {
                if (controller.signal.aborted) return;
                const failed = await state.update((data) => {
                    const current = data.researchJobs[id];
                    if (current.runId !== job.runId || !activeStatuses.includes(current.status)) return null;
                    Object.assign(current, { status: mode === "canvas" ? "completed" : "failed", canvasBusy: false,
                        error: String(error.message).slice(0, 500), revision: current.revision + 1,
                        updatedAt: Date.now() });
                    return current;
                });
                if (failed) await publish(failed).catch(() => {});
            }).catch(() => console.error("Research state update failed")).finally(() => {
                active.delete(id);
                pump();
            });
        }
    }

    function schedule(job, mode) {
        pending.set(job.id, mode);
        pump();
    }

    async function change(id, context, mutate) {
        const job = get(id);
        if (!job) throw Error(researchText("RESEARCH_NOT_FOUND"));
        await authorize(job, context);
        return state.update((data) => {
            if (closed) throw Error(researchText("RESEARCH_STOPPED"));
            const current = data.researchJobs[id];
            if (!sameOwner(current, context) || (context.revision !== undefined &&
                context.revision !== current.revision)) throw Error(researchText("RESEARCH_CHANGED"));
            mutate(current);
            current.revision++;
            current.updatedAt = Date.now();
            return current;
        });
    }

    function status(job) {
        const progress = researchProgress(job, state.snapshot());
        return researchText("RESEARCH_STATUS", { title: job.title || researchText("UI_TITLE"),
            status: researchText(`UI_STATUS_${job.status}`) + (job.stage ? ` · ${job.stage}` : ""),
            sources: progress.sources, reports: progress.reports, round: job.round || 1 });
    }

    async function control(id, action, text, context) {
        const job = get(id);
        if (!job) throw Error(researchText("RESEARCH_NOT_FOUND"));
        await authorize(job, context);
        if (action === "status") return status(job);
        if (closed) throw Error(researchText("RESEARCH_STOPPED"));
        if (!researchActions(job).includes(action)) throw Error(researchText("RESEARCH_ACTION_UNAVAILABLE"));
        if (action === "summarize") {
            const report = [...(job.reports || [])].reverse().find((item) =>
                ["explore", "counter", "synthesize", "revise"].includes(item.stage));
            if (!report) return status(job) + "\n" + researchText("RESEARCH_NO_REPORT");
            const saved = await library.readReport(job, report.id);
            await send(job, researchText("RESEARCH_INTERIM", { text: saved.text }) +
                (saved.nextOffset !== null ? "\n\n" + researchText("RESEARCH_PARTIAL") : ""));
            return "";
        }
        if (action === "pause") {
            const paused = await change(id, context, (current) => {
                if (!activeStatuses.includes(current.status)) throw Error(researchText("RESEARCH_NOT_RUNNING"));
                current.status = "paused";
                current.canvasBusy = false;
            });
            pending.delete(id);
            active.get(id)?.controller.abort();
            await publish(paused);
            return researchText("RESEARCH_PAUSED");
        }
        if (action === "finish") {
            const finishing = await change(id, context, (current) => {
                if (current.status !== "running" || current.mode !== "run") {
                    throw Error(researchText("RESEARCH_NOT_RUNNING"));
                }
                current.finishRequested = true;
            });
            await publish(finishing);
            return researchText("RESEARCH_FINISHING");
        }
        if (["start", "resume", "canvas"].includes(action)) {
            const next = await change(id, context, (current) => {
                if (action === "start" && context.id) {
                    const proposedAt = timestamp(current.proposalMessageTs || current.sourceMessageTs);
                    const requestedAt = timestamp(context.messageTs);
                    if (current.proposalTaskId === context.id || proposedAt === null || requestedAt === null ||
                        requestedAt <= proposedAt || (Number.isSafeInteger(current.confirmationAfter) &&
                            requestedAt <= BigInt(current.confirmationAfter) * 1000n)) {
                        throw Error(researchText("RESEARCH_CONFIRM_LATER"));
                    }
                }
                if (action === "start" && current.status !== "ready") {
                    throw Error(researchText("RESEARCH_CONFIRM_SCOPE"));
                }
                if (action === "resume" && !resumable.includes(current.status)) {
                    throw Error(researchText("RESEARCH_NOT_PAUSED"));
                }
                if (action === "canvas" && (current.status !== "completed" || !current.finalReportId)) {
                    throw Error(researchText("RESEARCH_NO_FINAL"));
                }
                const mode = action === "canvas" ? "canvas" : action === "resume" ? current.mode || "run" : "run";
                Object.assign(current, { mode, runId: randomUUID(),
                    status: mode === "clarify" ? "clarifying" : "queued", error: "",
                    canvasBusy: mode === "canvas", finishRequested: false, questions: [] });
                if (mode === "run") {
                    current.startedAt ??= Date.now();
                    current.confirmedPlans ??= [];
                    current.confirmedPlans.push({ runId: current.runId, version: current.scopeVersion || 0,
                        title: current.title, brief: current.brief, confirmedAt: Date.now() });
                }
            });
            schedule(next, next.mode);
            await publish(next);
            return "";
        }
        if (["edit", "reply", "more"].includes(action)) {
            if (typeof text !== "string" || !text.trim() || text.length > 16000) {
                throw Error(researchText("RESEARCH_INPUT_LIMIT"));
            }
            if (action === "more") {
                const next = await state.update((data) => {
                    const current = data.researchJobs[id];
                    if (context.revision !== undefined && context.revision !== current.revision) {
                        throw Error(researchText("RESEARCH_CHANGED"));
                    }
                    const created = proposal(data, { title: current.title, brief: text.trim(), questions: [],
                        parentId: id }, { ...current, ...context, id: undefined, messageTs: context.messageTs ||
                            current.sourceMessageTs, prompt: text.trim() });
                    Object.assign(created, { status: "clarifying", mode: "clarify",
                        stage: researchText("STAGE_PREPARING"), phaseStartedAt: Date.now() });
                    return created;
                });
                schedule(next, "clarify");
                await publish(next);
                return "";
            }
            const next = await change(id, context, (current) => {
                if (action === "reply" && current.status !== "awaiting_input") {
                    throw Error(researchText("RESEARCH_NO_QUESTION"));
                }
                if (action === "edit" && !["ready", ...resumable].includes(current.status)) {
                    throw Error(researchText("RESEARCH_PAUSE_TO_EDIT"));
                }
                current.answers = [...(current.answers || []), text.trim()];
                current.scopeVersion = (current.scopeVersion || 0) + 1;
                current.fileIds = context.fileIds || current.fileIds;
                current.sourceMessageTs = context.messageTs || current.sourceMessageTs;
                if (current.answers.join("\n").length > 24000) {
                    throw Error(researchText("RESEARCH_DETAILS_LIMIT"));
                }
                Object.assign(current, { status: "clarifying", mode: "clarify", runId: randomUUID(),
                    error: "", stage: researchText("STAGE_PREPARING"), finishRequested: false,
                    proposalTaskId: context.id, proposalMessageTs: context.messageTs,
                    confirmationAfter: now(),
                    phaseStartedAt: Date.now() });
            });
            schedule(next, "clarify");
            await publish(next);
            return "";
        }
        throw Error("Unknown research action.");
    }

    async function handle(context, prompt) {
        if (prompt.trim() !== "!stop") return false;
        const job = Object.values(state.snapshot().researchJobs || {}).find((item) =>
            sameOwner(item, context) && activeStatuses.includes(item.status));
        if (!job) return false;
        await send(job, await control(job.id, "pause", undefined, context));
        return true;
    }

    async function recover() {
        await state.update((data) => {
            for (const job of Object.values(data.researchJobs || {})) {
                if (!activeStatuses.includes(job.status)) continue;
                Object.assign(job, { status: "interrupted", canvasBusy: false, revision: job.revision + 1,
                    error: researchText("RESEARCH_INTERRUPTED") });
            }
        });
        for (const job of Object.values(state.snapshot().researchJobs || {})) {
            if (job.status === "interrupted") await publish(job).catch(() => {});
        }
    }

    async function stop() {
        closed = true;
        pending.clear();
        await state.update((data) => {
            for (const job of Object.values(data.researchJobs || {})) {
                if (activeStatuses.includes(job.status)) {
                    Object.assign(job, { status: "interrupted", canvasBusy: false, revision: job.revision + 1 });
                }
            }
        });
        for (const entry of active.values()) entry.controller.abort();
        await Promise.all([...active.values()].map((entry) => entry.promise));
    }

    return { handle, control, inspect, propose, act, readResult, recover, stop, attach: (value) => { ui = value; },
        async idle() { while (active.size) await Promise.all([...active.values()].map((entry) => entry.promise)); } };
}
