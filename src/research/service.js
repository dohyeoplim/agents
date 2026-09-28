import { randomUUID } from "node:crypto";
import { profileFor } from "../agents/profiles.js";
import { loadPersonal } from "../integrations/settings.js";
import { researchIntent } from "./intent.js";
import { createResearchEngine } from "./engine.js";
import { researchText } from "./copy.js";

const resumable = ["paused", "interrupted", "failed"];
const activeStatuses = ["queued", "running", "clarifying"];
const sameOwner = (job, context) => ["team", "user", "channel", "thread"].every((key) => job[key] === context[key]);

export function createResearch({ state, execute, library, config, post, personal = loadPersonal }) {
    const active = new Map();
    const pending = new Map();
    let ui;
    let closed = false;
    const get = (id) => state.snapshot().researchJobs?.[id];

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

    async function publish(job) {
        await authorize(job);
        try { await ui?.publish(job); }
        catch { console.warn("Research status delivery unavailable"); }
    }

    async function send(job, text) {
        await authorize(job);
        return post(job, text);
    }

    const engine = createResearchEngine({ state, execute, library, publish, post: send });

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
        const sources = Object.values(state.snapshot().researchSources || {})
            .filter((source) => source.researchId === job.id).length;
        return researchText("RESEARCH_STATUS", { title: job.title || researchText("UI_TITLE"),
            status: researchText(`UI_STATUS_${job.status}`) + (job.stage ? ` · ${job.stage}` : ""),
            sources, reports: (job.reports || []).length });
    }

    async function control(id, action, text, context) {
        const job = get(id);
        if (!job) throw Error(researchText("RESEARCH_NOT_FOUND"));
        await authorize(job, context);
        if (action === "status") return status(job);
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
            });
            schedule(next, next.mode);
            await publish(next);
            return "";
        }
        if (["edit", "reply", "more"].includes(action)) {
            if (typeof text !== "string" || !text.trim() || text.length > 16000) {
                throw Error(researchText("RESEARCH_INPUT_LIMIT"));
            }
            const next = await change(id, context, (current) => {
                if (action === "more" && current.status !== "completed") {
                    throw Error(researchText("RESEARCH_NOT_COMPLETE"));
                }
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
                    error: "", stage: researchText("STAGE_PREPARING"), finishRequested: false });
            });
            schedule(next, "clarify");
            await publish(next);
            return "";
        }
        throw Error("Unknown research action.");
    }

    async function handle(context, prompt, eventId) {
        const intent = researchIntent(prompt);
        let job = Object.values(state.snapshot().researchJobs || {}).find((item) => sameOwner(item, context));
        if (!job && intent !== "new") return false;
        if (job && !intent && job.status === "completed") return false;
        if (!job) {
            const input = { ...context, id: randomUUID(), request: prompt.replace(/^!research\s*/i, ""),
                messageTs: undefined, sourceMessageTs: context.messageTs,
                title: researchText("UI_TITLE"), status: "clarifying", mode: "clarify",
                stage: researchText("STAGE_PREPARING"),
                runId: randomUUID(), revision: 0, answers: [], updates: [], reports: [],
                events: [eventId], createdAt: Date.now(), updatedAt: Date.now() };
            await authorize(input);
            job = await state.update((data) => {
                data.researchJobs ??= {};
                data.researchJobs[input.id] = input;
                return input;
            });
            schedule(job, "clarify");
            await publish(job);
            return true;
        }
        if ((job.events || []).includes(eventId)) return true;
        await authorize(job, context);
        if (intent && intent !== "new") {
            const response = await control(job.id, intent, undefined, context);
            if (response) await send(get(job.id), response);
        } else if (job.status === "awaiting_input") {
            await control(job.id, "reply", prompt, context);
        } else if (job.status === "completed") {
            await control(job.id, "more", prompt, context);
        } else if (["ready", ...resumable].includes(job.status)) {
            await control(job.id, "edit", prompt, context);
        } else {
            const updated = await change(job.id, context, (current) => {
                current.updates = [...(current.updates || []), prompt];
                current.scopeVersion = (current.scopeVersion || 0) + 1;
                if (current.updates.join("\n").length > 12000) {
                    throw Error(researchText("RESEARCH_UPDATES_LIMIT"));
                }
                current.fileIds = context.fileIds || current.fileIds;
            });
            await send(updated, researchText("RESEARCH_UPDATE_SAVED"));
            await publish(updated);
        }
        await state.update((data) => {
            const current = data.researchJobs[job.id];
            current.events = [...(current.events || []), eventId].slice(-200);
        });
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

    return { handle, control, recover, stop, attach: (value) => { ui = value; },
        async idle() { while (active.size) await Promise.all([...active.values()].map((entry) => entry.promise)); } };
}
