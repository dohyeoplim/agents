import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { profileFor } from "../agents/profiles.js";
import { loadPersonal } from "../integrations/settings.js";
import { logFailure } from "../shared/diagnostics.js";
import { autoresearchActions } from "./actions.js";
import { autoresearchText } from "./copy.js";
import { buildManifest, missingFields } from "./plan.js";
import { offlineRunner } from "./runner.js";
import { proposalInput, statusInput, controlInput, manifestInput } from "./tools.js";

const sameOwner = (job, context) => ["team", "user", "channel", "thread"].every((key) => job[key] === context[key]);
const timestamp = (value) => /^\d+\.\d{1,6}$/.test(value || "") ?
    BigInt(value.split(".")[0] + value.split(".")[1].padEnd(6, "0")) : null;

export function createAutoresearch({ state, artifacts, config, personal = loadPersonal, now = Date.now }) {
    let ui;
    let closed = false;
    const get = (id) => state.snapshot().autoresearchJobs?.[id];
    const fail = (key) => { throw Error(autoresearchText(key)); };
    const view = (job) => ({ id: job.id, revision: job.revision, title: job.title, status: job.status,
        plan: job.plan, missing: job.missing, manifestId: job.manifestId, manifestHash: job.manifestHash,
        actions: autoresearchActions(job), runner: offlineRunner.status(), executed: false,
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
                await ui.publish(job);
                delivered = true;
            }
        } catch (error) { logFailure(error, { component: "autoresearch" }); }
        await state.update((data) => {
            const current = data.autoresearchJobs?.[job.id];
            if (current?.revision === job.revision) current.statusDelivery = delivered ? "confirmed" : "unconfirmed";
        });
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
        return { jobs: page, latestId: jobs[0]?.id,
            total: jobs.length, offset, nextOffset: end < jobs.length ? end : null,
            runner: offlineRunner.status() };
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
                if (current.revision !== args.revision) fail("CHANGED");
                if (!["draft", "ready"].includes(current.status)) fail("IMMUTABLE");
                if (isDeepStrictEqual(current.plan, args.plan)) return current;
            } else {
                const duplicate = Object.values(jobs).find((entry) => sameOwner(entry, context) &&
                    context.id && entry.proposalTaskId === context.id && entry.status !== "cancelled");
                if (duplicate) return duplicate;
                if (Object.values(jobs).some((entry) => sameOwner(entry, context) &&
                    ["draft", "ready"].includes(entry.status))) fail("ACTIVE");
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

    async function control(id, action, context, signal) {
        const job = get(id);
        if (!job) fail("NOT_FOUND");
        await authorize(job, context);
        signal?.throwIfAborted();
        if (closed) fail("STOPPED");
        if (context.revision !== job.revision) fail("CHANGED");
        if (action === "refresh") {
            if (!ui) fail("DELIVERY_FAILED");
            await ui.publish(job);
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
        if (action === "approve" && context.id) {
            const requestedAt = timestamp(context.messageTs);
            const proposedAt = timestamp(job.proposalMessageTs);
            if (context.id === job.proposalTaskId || requestedAt === null || proposedAt === null ||
                requestedAt <= proposedAt || requestedAt <= BigInt(job.confirmationAfter) * 1000n) {
                fail("CONFIRM_LATER");
            }
        }
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

    return { inspect, propose, act, control, readManifest, attach: (value) => { ui = value; },
        async recover() {
            for (const job of Object.values(state.snapshot().autoresearchJobs || {})) {
                if (job.status !== "cancelled") await publish(job);
            }
        },
        stop() { closed = true; },
    };
}
