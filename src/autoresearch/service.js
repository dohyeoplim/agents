import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { profileFor } from "../agents/profiles.js";
import { loadPersonal } from "../integrations/settings.js";
import { logFailure } from "../shared/diagnostics.js";
import { logEvent } from "../shared/events.js";
import { autoresearchActions } from "./actions.js";
import { autoresearchText } from "./copy.js";
import { buildManifest, missingFields } from "./plan.js";
import { offlineRunner } from "./runner.js";
import { proposalInput, statusInput, controlInput, manifestInput } from "./tools.js";
import { campaignInput } from "./campaign-schema.js";
import { createCampaignEngine } from "./campaign-engine.js";
import { cleanupCampaign } from "./cleanup.js";

const sameOwner = (job, context) => ["team", "user", "channel", "thread"].every((key) => job[key] === context[key]);
const timestamp = (value) => /^\d+\.\d{1,6}$/.test(value || "") ?
    BigInt(value.split(".")[0] + value.split(".")[1].padEnd(6, "0")) : null;

export function createAutoresearch({ state, artifacts, config, personal = loadPersonal, now = Date.now,
    remote, execute, post, campaignEngine = createCampaignEngine }) {
    let ui;
    let closed = false;
    const active = new Map();
    const live = (job) => !["completed", "cancelled", "limited", "prepared"].includes(job.status);
    const connection = () => remote?.describe?.() || { configured: false, connected: null };
    const campaignRunner = () => ({ available: Boolean(connection().configured && execute),
        reason: connection().configured && execute ? null : "not_configured" });
    const get = (id) => state.snapshot().autoresearchJobs?.[id];
    const fail = (key) => { throw Error(autoresearchText(key)); };
    const view = (job) => ({ id: job.id, revision: job.revision, title: job.title, status: job.status,
        plan: job.plan, missing: job.missing, manifestId: job.manifestId, manifestHash: job.manifestHash,
        actions: autoresearchActions(job), runner: job.mode === "campaign" ? campaignRunner() : offlineRunner.status(),
        executed: Boolean(job.startedAt),
        ...(job.mode === "campaign" ? { mode: job.mode, campaign: job.campaign, connection: connection(),
            questions: job.questions || job.campaign.questions, stage: job.stage,
            executionDeadline: job.executionDeadline, finalReportId: job.finalReportId,
            cleanupPending: Boolean(job.campaignState?.cleanupPending),
            progress: { steps: job.campaignState?.steps || 0, commands: job.campaignState?.commands || 0,
                gpuSeconds: job.campaignState?.gpuSeconds || 0 },
            history: (job.campaignState?.history || []).slice(-5).map((entry) => ({
                id: entry.id, status: entry.status, purpose: String(entry.purpose || "").slice(0, 1500),
                output: String(entry.output || "").slice(0, 1500),
            })) } : {}),
        deliveryConfirmed: job.statusDelivery === "confirmed",
        ...(job.statusDelivery === "unconfirmed" ? { warning: autoresearchText("DELIVERY_FAILED") } : {}) });

    async function authorize(job, context = job) {
        const current = await config();
        const settings = await personal();
        const route = current.channels[job.channel];
        if (!sameOwner(job, context) || current.team !== job.team || !current.users.includes(job.user) ||
            job.user !== (settings?.owner || current.users[0]) || !route || route.enabled === false ||
            profileFor(route) !== job.profile ||
            job.key !== `${job.team}:${job.channel}:${job.thread}:${route.agent}` ||
            context.researchId || context.scheduleId || context.briefingDate) fail("AUTH");
    }

    async function publish(job) {
        let delivered = false;
        try {
            await authorize(job);
            if (ui) {
                await ui.publish({ ...job, connection: connection() });
                delivered = true;
            }
        } catch (error) { logFailure(error, { component: "autoresearch" }); }
        await state.update((data) => {
            const current = data.autoresearchJobs?.[job.id];
            if (current?.revision === job.revision) current.statusDelivery = delivered ? "confirmed" : "unconfirmed";
        });
    }

    const engine = campaignEngine({ state, execute, remote, artifacts, publish, now,
        post: async (job, text) => { await authorize(job); if (post) await post(job, text); } });

    function pump() {
        if (closed) return;
        const jobs = Object.values(state.snapshot().autoresearchJobs || {});
        for (const job of jobs) {
            if (active.size >= 1) break;
            if (job.mode !== "campaign" || job.status !== "queued" || active.has(job.id)) continue;
            if (jobs.some((other) => other.id !== job.id && other.campaignState?.cleanupPending)) continue;
            const controller = new AbortController();
            const task = { controller };
            active.set(job.id, task);
            let refreshing = false;
            const timer = setInterval(() => {
                const current = get(job.id);
                if (refreshing || !current || current.runId !== job.runId) return;
                refreshing = true;
                void publish(current).finally(() => { refreshing = false; }).catch(() => {});
            }, 15000);
            timer.unref?.();
            task.promise = Promise.resolve().then(async () => {
                await authorize(job);
                const running = await state.update((data) => {
                    const current = data.autoresearchJobs[job.id];
                    if (closed || current.status !== "queued" || current.runId !== job.runId) return null;
                    current.status = "running";
                    current.updatedAt = now();
                    return current;
                });
                if (!running) return;
                logEvent("campaign_started", { campaignId: running.id, runId: running.runId, status: running.status });
                await publish(running);
                await engine.run(running, controller.signal);
            }).catch(async (error) => {
                if (!controller.signal.aborted) logFailure(error, { component: "autoresearch" });
                const failed = await state.update((data) => {
                    const current = data.autoresearchJobs[job.id];
                    if (current.runId !== job.runId || !["running", "queued"].includes(current.status)) return null;
                    current.status = controller.signal.aborted ? "interrupted" : "failed";
                    current.error = autoresearchText(controller.signal.aborted ? "INTERRUPTED" : "CAMPAIGN_FAILED");
                    current.updatedAt = now();
                    current.revision++;
                    return current;
                });
                if (failed) {
                    logEvent(`campaign_${failed.status}`, {
                        campaignId: failed.id, runId: failed.runId, status: failed.status,
                    });
                    await publish(failed);
                }
            }).finally(() => { clearInterval(timer); active.delete(job.id); pump(); });
        }
    }

    async function inspect(context, input = {}) {
        const { offset, limit } = statusInput.parse(input);
        await authorize(context);
        const jobs = Object.values(state.snapshot().autoresearchJobs || {})
            .filter((job) => sameOwner(job, context)).reverse().sort((a, b) => b.createdAt - a.createdAt);
        const page = [];
        let end = offset;
        let size = 0;
        for (const job of jobs.slice(offset, offset + limit)) {
            const item = view(job);
            const length = JSON.stringify(item).length;
            if (page.length && size + length > 80000) break;
            page.push(item);
            size += length;
            end++;
        }
        const settings = await personal();
        return { jobs: page, latestId: jobs[0]?.id, currentTime: new Date(now()).toISOString(),
            timezone: settings?.briefing?.timezone || "Asia/Seoul", connection: connection(),
            total: jobs.length, offset, nextOffset: end < jobs.length ? end : null,
            runner: campaignRunner(), manifestRunner: offlineRunner.status(), campaignRunner: campaignRunner() };
    }

    async function campaign(input, context, signal) {
        const args = campaignInput.parse(input);
        await authorize(context);
        const settings = await personal();
        const { id, revision, ...details } = args;
        details.timezone ??= settings?.briefing?.timezone || "Asia/Seoul";
        if (details.deadline && Date.parse(details.deadline) <= now()) fail("DEADLINE_EXPIRED");
        const job = await state.update((data) => {
            signal?.throwIfAborted();
            if (closed) fail("STOPPED");
            const jobs = data.autoresearchJobs ??= {};
            const current = id ? jobs[id] : null;
            if (id && (!current || !sameOwner(current, context) || current.key !== context.key ||
                current.profile !== context.profile)) fail("NOT_FOUND");
            if (current) {
                if (current.revision !== revision) fail("CHANGED");
                if (active.has(id) || !["draft", "ready", "awaiting_input", "paused"].includes(current.status)) {
                    fail("IMMUTABLE");
                }
                if (current.mode === "campaign" && isDeepStrictEqual(current.campaign, details)) return current;
            } else {
                const duplicate = Object.values(jobs).find((entry) => sameOwner(entry, context) &&
                    entry.mode === "campaign" && context.id && entry.proposalTaskId === context.id && live(entry));
                if (duplicate) return duplicate;
                if (Object.values(jobs).some((entry) => sameOwner(entry, context) && live(entry))) fail("ACTIVE");
            }
            const saved = current || { id: randomUUID(), team: context.team, user: context.user,
                channel: context.channel, thread: context.thread, key: context.key, profile: context.profile,
                createdAt: now(), revision: -1 };
            if (saved.startedAt) {
                saved.updates = [...(saved.updates || []), { text: details.objective, at: now() }].slice(-10);
            }
            Object.assign(saved, { mode: "campaign", campaign: details, title: details.title,
                plan: { title: details.title, objective: details.objective }, missing: [], questions: details.questions,
                status: details.questions.length ? "awaiting_input" : saved.startedAt ? "paused" : "ready",
                revision: saved.revision + 1,
                proposalTaskId: context.id, proposalMessageTs: context.messageTs, confirmationAfter: now(),
                updatedAt: now() });
            delete saved.error;
            jobs[saved.id] = saved;
            return saved;
        });
        await publish(job);
        return view(get(job.id));
    }

    async function propose(input, context, signal) {
        const args = proposalInput.parse(input);
        await authorize(context);
        const job = await state.update((data) => {
            signal?.throwIfAborted();
            if (closed) fail("STOPPED");
            const jobs = data.autoresearchJobs ??= {};
            const current = args.id ? jobs[args.id] : null;
            if (args.id && (!current || !sameOwner(current, context) || current.key !== context.key ||
                current.profile !== context.profile)) fail("NOT_FOUND");
            if (current) {
                if (current.mode === "campaign") fail("IMMUTABLE");
                if (current.revision !== args.revision) fail("CHANGED");
                if (!["draft", "ready"].includes(current.status)) fail("IMMUTABLE");
                if (isDeepStrictEqual(current.plan, args.plan)) return current;
            } else {
                const duplicate = Object.values(jobs).find((entry) => sameOwner(entry, context) &&
                    context.id && entry.proposalTaskId === context.id && entry.status !== "cancelled");
                if (duplicate) return duplicate;
                if (Object.values(jobs).some((entry) => sameOwner(entry, context) &&
                    live(entry))) fail("ACTIVE");
            }
            const saved = current || { id: randomUUID(), team: context.team, user: context.user,
                channel: context.channel, thread: context.thread, key: context.key, profile: context.profile,
                createdAt: now(), revision: -1 };
            const missing = missingFields(args.plan);
            Object.assign(saved, { plan: args.plan, title: args.plan.title, missing,
                status: missing.length ? "draft" : "ready", revision: saved.revision + 1, updatedAt: now(),
                proposalTaskId: context.id, proposalMessageTs: context.messageTs, confirmationAfter: now() });
            jobs[saved.id] = saved;
            return saved;
        });
        await publish(job);
        return view(get(job.id));
    }

    async function readManifest(input, context) {
        const { id, offset } = manifestInput.parse(input);
        const job = get(id);
        if (!job) fail("NOT_FOUND");
        await authorize(job, context);
        if (!job.manifestId) return { available: false, ...view(job) };
        const saved = await artifacts.get(job.manifestId);
        const hash = createHash("sha256").update(saved.data).digest("hex");
        if (hash !== job.manifestHash || saved.source.provider !== "autoresearch" ||
            saved.source.fileId !== job.id || saved.source.channel !== job.channel) fail("MANIFEST_MISMATCH");
        const text = saved.data.toString("utf8");
        return { available: true, id, hash, text: text.slice(offset, offset + 8000), offset,
            nextOffset: offset + 8000 < text.length ? offset + 8000 : null, executed: false };
    }

    async function readResult(input, context) {
        const { id, offset } = manifestInput.parse(input);
        const job = get(id);
        if (!job) fail("NOT_FOUND");
        await authorize(job, context);
        const reportId = job.finalReportId || job.campaignState?.finalReportId;
        if (!reportId) return { available: false, ...view(job) };
        const saved = await artifacts.get(reportId);
        if (saved.source.provider !== "autoresearch" || saved.source.fileId !== job.id ||
            saved.source.channel !== job.channel || saved.source.kind !== "campaign-report") fail("MANIFEST_MISMATCH");
        const text = saved.data.toString("utf8");
        return { available: true, id, reportId, text: text.slice(offset, offset + 8000), offset,
            nextOffset: offset + 8000 < text.length ? offset + 8000 : null };
    }

    async function campaignControl(job, action, context, signal) {
        if (action === "result") {
            const result = await readResult({ id: job.id }, context);
            return result.available ? result.text.slice(0, 2500) : autoresearchText("NO_RESULT");
        }
        const starting = action === "start" || action === "resume";
        if (starting && !connection().configured) fail("REMOTE_REQUIRED");
        if (starting && (job.executionDeadline || Date.parse(job.campaign.deadline)) <= now()) {
            fail("DEADLINE_EXPIRED");
        }
        const changed = await state.update((data) => {
            signal?.throwIfAborted();
            if (closed) fail("STOPPED");
            const current = data.autoresearchJobs[job.id];
            if (current.revision !== job.revision || current.status !== job.status) fail("CHANGED");
            if (starting) {
                current.executionDeadline ??= Math.min(now() + current.campaign.wallSeconds * 1000,
                    current.campaign.deadline ? Date.parse(current.campaign.deadline) : Infinity);
                Object.assign(current, { status: "queued", runId: randomUUID(),
                    startedAt: current.startedAt ?? now() });
                delete current.error;
            } else {
                current.status = action === "pause" ? "paused" : "cancelled";
                if (action === "cancel") current.cancelledAt = now();
            }
            current.revision++;
            current.updatedAt = now();
            return current;
        });
        if (!starting) {
            logEvent(`campaign_${changed.status}`, {
                campaignId: changed.id, runId: changed.runId, status: changed.status,
            });
            const task = active.get(job.id);
            task?.controller.abort();
            if (task) await task.promise;
            else if (action === "cancel" && get(job.id).campaignState?.pending) {
                await cleanupCampaign({ job: get(job.id), remote, state });
            }
        }
        await publish(get(job.id));
        pump();
        return "";
    }

    async function control(id, action, context, signal) {
        const job = get(id);
        if (!job) fail("NOT_FOUND");
        await authorize(job, context);
        signal?.throwIfAborted();
        if (closed) fail("STOPPED");
        if (context.revision !== job.revision) fail("CHANGED");
        if (action === "refresh") {
            if (!ui) fail("DELIVERY_FAILED");
            await ui.publish({ ...job, connection: connection() });
            await state.update((data) => {
                const current = data.autoresearchJobs?.[id];
                if (current?.revision === job.revision) current.statusDelivery = "confirmed";
            });
            return "";
        }
        if (!autoresearchActions(job).includes(action)) fail("NOT_READY");
        if (action === "manifest") {
            const result = await readManifest({ id, offset: 0 }, context);
            return result.available ? autoresearchText("MANIFEST_PREVIEW", {
                hash: result.hash, text: result.text.slice(0, 2500),
            }) : autoresearchText("NO_MANIFEST");
        }
        if (["approve", "start", "resume"].includes(action) && context.id) {
            const requestedAt = timestamp(context.messageTs);
            const proposedAt = timestamp(job.proposalMessageTs);
            if (context.id === job.proposalTaskId || requestedAt === null || proposedAt === null ||
                requestedAt <= proposedAt || requestedAt <= BigInt(job.confirmationAfter) * 1000n) {
                fail("CONFIRM_LATER");
            }
        }
        if (job.mode === "campaign") return campaignControl(job, action, context, signal);
        let artifact;
        let hash;
        if (action === "approve") {
            const prepared = buildManifest(job.plan, { id: job.id, revision: job.revision + 1,
                team: job.team, user: job.user, channel: job.channel, thread: job.thread });
            hash = prepared.hash;
            artifact = await artifacts.put(JSON.stringify(prepared.manifest), { mime: "application/json",
                source: { provider: "autoresearch", channel: job.channel, fileId: id,
                    version: String(job.revision), kind: "manifest", title: job.title } });
        }
        const changed = await state.update((data) => {
            signal?.throwIfAborted();
            if (closed) fail("STOPPED");
            const current = data.autoresearchJobs[id];
            if (current.revision !== job.revision || current.status !== job.status) fail("CHANGED");
            if (action === "approve") {
                Object.assign(current, { status: "prepared", manifestId: artifact.id, manifestHash: hash,
                    approvedAt: now(), approvedRevision: job.revision });
            } else Object.assign(current, { status: "cancelled", cancelledAt: now() });
            current.revision++;
            current.updatedAt = now();
            return current;
        });
        await publish(changed);
        return "";
    }

    async function act(input, context, signal) {
        const args = controlInput.parse(input);
        await control(args.id, args.action, { ...context, revision: args.revision }, signal);
        return view(get(args.id));
    }

    return { inspect, propose, campaign, act, control, readManifest, readResult, attach: (value) => { ui = value; },
        async recover() {
            const recovered = [];
            await state.update((data) => {
                for (const job of Object.values(data.autoresearchJobs || {})) {
                    if (job.mode === "campaign" && ["queued", "running"].includes(job.status)) {
                        job.status = "interrupted";
                        if (job.campaignState?.pending) job.campaignState.cleanupPending = true;
                        job.revision++;
                        job.updatedAt = now();
                        recovered.push({ campaignId: job.id, runId: job.runId, status: job.status });
                    }
                }
            });
            for (const job of recovered) logEvent("campaign_interrupted", job);
            for (const job of Object.values(state.snapshot().autoresearchJobs || {})) {
                if (job.status !== "cancelled") await publish(job);
            }
        },
        async stop() {
            closed = true;
            const interrupted = [];
            await state.update((data) => {
                for (const job of Object.values(data.autoresearchJobs || {})) {
                    if (job.mode === "campaign" && ["queued", "running"].includes(job.status)) {
                        job.status = "interrupted";
                        if (job.campaignState?.pending) job.campaignState.cleanupPending = true;
                        job.revision++;
                        job.updatedAt = now();
                        interrupted.push({ campaignId: job.id, runId: job.runId, status: job.status });
                    }
                }
            });
            for (const job of interrupted) logEvent("campaign_interrupted", job);
            const tasks = [...active.values()];
            for (const task of tasks) task.controller.abort();
            await Promise.allSettled(tasks.map((task) => task.promise));
        },
    };
}
