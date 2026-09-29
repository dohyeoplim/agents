import { z } from "zod";
import { profileFor } from "../agents/profiles.js";
import { autoresearchText } from "./copy.js";
import { autoresearchActions } from "./actions.js";

const reference = z.object({ id: z.uuid(), revision: z.number().int().nonnegative() }).strict();
const plain = (value, limit = 2900) => ({ type: "plain_text", text: String(value || " ").slice(0, limit) });

export function renderAutoresearch(job) {
    const heading = autoresearchText("UI_HEADING", { title: job.title || autoresearchText("UI_UNTITLED") });
    const status = autoresearchText(`UI_STATUS_${job.status}`);
    const blocks = [
        { type: "header", text: plain(heading, 150) },
        { type: "section", text: plain(status) },
        { type: "context", elements: [plain(autoresearchText("UI_OFFLINE"))] },
    ];
    const plan = job.plan || {};
    const sections = [plan.objective];
    if (plan.repository) sections.push(autoresearchText("UI_REPOSITORY", plan.repository));
    if (plan.dataset) sections.push(autoresearchText("UI_DATASET", { ...plan.dataset,
        train: plan.dataset.trainSplit, validation: plan.dataset.validationSplit, test: plan.dataset.testSplit }));
    if (plan.metric) sections.push(autoresearchText("UI_METRIC", { ...plan.metric,
        constraints: (plan.metric.constraints || []).map((item) =>
            `${item.name} ${item.operator === "gte" ? "≥" : "≤"} ${item.value}`).join("\n") }));
    if (plan.budget) sections.push(autoresearchText("UI_BUDGET", {
        experiments: plan.budget.maxExperiments, wall: plan.budget.wallSeconds, gpu: plan.budget.gpuSeconds,
        concurrent: plan.budget.maxConcurrent, devices: plan.budget.gpusPerExperiment,
        trial: plan.budget.trialSeconds, seeds: (plan.seeds || []).join(", "),
    }));
    if (plan.environment) sections.push(autoresearchText("UI_ENVIRONMENT", plan.environment));
    if (plan.training) sections.push(autoresearchText("UI_TRAINING", {
        command: JSON.stringify(plan.training.command),
    }));
    if (plan.evaluation) sections.push(autoresearchText("UI_EVALUATION", {
        command: JSON.stringify(plan.evaluation.command), paths: plan.evaluation.protectedPaths.join("\n"),
    }));
    if (plan.editablePaths) sections.push(autoresearchText("UI_EDITABLE", { paths: plan.editablePaths.join("\n") }));
    let truncated = false;
    let remaining = 24000;
    for (const section of sections.filter(Boolean)) {
        const limit = Math.min(section.length, 8700, remaining);
        truncated ||= section.length > limit;
        for (let offset = 0; offset < limit; offset += 2900) {
            blocks.push({ type: "section", text: plain(section.slice(offset, Math.min(offset + 2900, limit))) });
        }
        remaining -= limit;
    }
    if (truncated) blocks.push({ type: "context", elements: [plain(autoresearchText("UI_TRUNCATED"))] });
    if (job.missing?.length) blocks.push({ type: "section", text: plain(autoresearchText("UI_MISSING", {
        items: job.missing.join("\n"),
    })) });
    if (job.error) blocks.push({ type: "section", text: plain(job.error) });
    const actions = autoresearchActions(job);
    if (actions.length) blocks.push({ type: "actions", block_id: `autoresearch_${job.id}_${job.revision}`,
        elements: actions.map((action) => ({ type: "button", action_id: `autoresearch_${action}`,
            text: plain(autoresearchText(`UI_BUTTON_${action}`), 75), value: `${job.id}:${job.revision}` })) });
    return { text: autoresearchText("UI_FALLBACK", { heading, status }).slice(0, 1000), blocks };
}

export function createAutoresearchSlack({ client, state, config, control, reply }) {
    const pending = new Map();
    const get = (id) => state.snapshot().autoresearchJobs?.[id];
    const messageFor = (job) => ({ channel: job.channel, ...renderAutoresearch(job) });

    function publish(job) {
        const previous = pending.get(job.id) || Promise.resolve();
        const next = previous.catch(() => {}).then(async () => {
            let current = get(job.id);
            if (!current) return;
            if (current.messageTs) {
                try { return await client.chat.update({ ...messageFor(current), ts: current.messageTs }); }
                catch (error) {
                    if (error.data?.error !== "message_not_found") throw error;
                }
                const latest = get(job.id);
                if (!latest || latest.messageTs !== current.messageTs) return;
                current = latest;
            }
            const sent = await client.chat.postMessage({ ...messageFor(current), thread_ts: current.thread,
                unfurl_links: false, unfurl_media: false });
            if (!/^\d+\.\d+$/.test(sent?.ts || "")) throw Error(autoresearchText("UI_DELIVERY_UNCONFIRMED"));
            await state.update((data) => {
                const saved = data.autoresearchJobs?.[current.id];
                if (saved && saved.messageTs === current.messageTs) saved.messageTs = sent.ts;
            });
        });
        pending.set(job.id, next);
        void next.finally(() => { if (pending.get(job.id) === next) pending.delete(job.id); }).catch(() => {});
        return next;
    }

    async function authorize(body, ref, channel, messageTs, action) {
        const current = await config();
        const job = get(ref.id);
        const route = current.channels[channel];
        if (!job || body.team?.id !== job.team || body.user?.id !== job.user || channel !== job.channel ||
            job.team !== current.team || !current.users.includes(job.user) || !route || route.enabled === false ||
            profileFor(route) !== job.profile ||
            job.key !== `${job.team}:${job.channel}:${job.thread}:${route.agent}`) {
            throw Error(autoresearchText("UI_UNAUTHORIZED"));
        }
        if (!messageTs || messageTs !== job.messageTs || ref.revision !== job.revision ||
            !autoresearchActions(job).includes(action)) throw Error(autoresearchText("UI_EXPIRED"));
        return job;
    }

    async function notify(body, channel, text) {
        if (!channel || !body.user?.id) return;
        try {
            const message = { channel, user: body.user.id, text };
            if (reply) await reply(message);
            else await client.chat.postEphemeral(message);
        } catch { console.warn(autoresearchText("UI_REPLY_UNAVAILABLE")); }
    }

    function register(app) {
        app.action(/^autoresearch_(approve|cancel|manifest)$/, async ({ ack, body, action }) => {
            await ack();
            const channel = body.channel?.id;
            try {
                const parts = typeof action.value === "string" ? action.value.split(":") : [];
                if (parts.length !== 2 || !/^\d+$/.test(parts[1])) {
                    throw Error(autoresearchText("UI_INVALID_ACTION"));
                }
                const ref = reference.parse({ id: parts[0], revision: Number(parts[1]) });
                const name = action.action_id.replace(/^autoresearch_/, "");
                const job = await authorize(body, ref, channel, body.message?.ts, name);
                const result = await control(job.id, name, { team: job.team, user: job.user, channel: job.channel,
                    thread: job.thread, revision: ref.revision });
                if (typeof result === "string" && result) await notify(body, channel, result);
            } catch (error) {
                await notify(body, channel,
                    error instanceof z.ZodError ? autoresearchText("UI_INVALID_ACTION") : error.message);
            }
        });
    }

    return { publish, register };
}
