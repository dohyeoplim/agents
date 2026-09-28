import { z } from "zod";
import { profileFor } from "../agents/profiles.js";
import { researchText } from "./copy.js";
import { researchActions } from "./actions.js";
import { researchProgress } from "./progress.js";
const reference = z.object({ id: z.uuid(), revision: z.number().int().nonnegative() }).strict();
const metadata = reference.extend({
    action: z.enum(["edit", "reply", "more"]), channel: z.string().regex(/^[CG][A-Z0-9]+$/),
    messageTs: z.string().regex(/^\d+\.\d+$/),
}).strict();
const input = z.string().trim().min(1).max(3000);
const plain = (value, limit = 2900) => ({ type: "plain_text", text: String(value || " ").slice(0, limit) });

export function renderResearch(job, now = Date.now()) {
    const heading = researchText("UI_HEADING", { title: job.title || researchText("UI_UNTITLED") });
    const status = researchText(`UI_STATUS_${job.status}`);
    const blocks = [
        { type: "header", text: plain(heading, 150) },
        { type: "section",
            text: plain(job.stage ? researchText("UI_STATUS_LINE", { status, stage: job.stage }) : status) },
    ];
    const progress = job.progress || { sources: 0, reports: job.reports?.length || 0, activeTasks: [] };
    const details = [researchText("UI_ROUND_PROGRESS", {
        round: job.round || 1, sources: progress.sources, reports: progress.reports,
    })];
    if (job.finishRequested && !["completed", "cancelled"].includes(job.status)) {
        details.push(researchText("UI_FINISH_REQUESTED"));
    }
    const phaseStartedAt = progress.phaseStartedAt || job.phaseStartedAt;
    if (Number.isFinite(phaseStartedAt)) {
        details.push(researchText("UI_PHASE_STARTED", { time: new Date(phaseStartedAt).toISOString() }));
    }
    for (const task of progress.activeTasks || []) {
        details.push(researchText(task.lastActivityAt ? "UI_PROVIDER_ACTIVITY" : "UI_ACTIVE_TASK", {
            provider: task.provider, stage: task.stage,
            seconds: Math.max(0, Math.floor((now - task.lastActivityAt) / 1000)),
        }));
    }
    blocks.push({ type: "context", elements: [plain(details.join("\n"))] });
    for (let offset = 0; offset < (job.brief || "").length; offset += 2900) {
        blocks.push({ type: "section", text: plain(job.brief.slice(offset, offset + 2900)) });
    }
    for (const question of (job.questions || []).slice(0, 10)) {
        blocks.push({ type: "section", text: plain(question) });
    }
    if (job.error) blocks.push({ type: "section", text: plain(job.error) });
    const actions = researchActions(job);
    if (actions.length) blocks.push({
        type: "actions", block_id: `research_${job.id}_${job.revision}`,
        elements: actions.map((action) => ({
            type: "button", action_id: `research_${action}`, text: plain(researchText(`UI_BUTTON_${action}`), 75),
            value: `${job.id}:${job.revision}`,
        })),
    });
    return { text: researchText("UI_FALLBACK", { heading, status }).slice(0, 1000), blocks };
}

export function createResearchSlack({ client, state, config, control, reply }) {
    const pending = new Map();
    const get = (id) => state.snapshot().researchJobs?.[id];
    const messageFor = (job) => ({ channel: job.channel,
        ...renderResearch({ ...job, progress: researchProgress(job, state.snapshot()) }) });

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
            const sent = await client.chat.postMessage({
                ...messageFor(current), thread_ts: current.thread, unfurl_links: false, unfurl_media: false,
            });
            if (!/^\d+\.\d+$/.test(sent?.ts || "")) throw Error(researchText("UI_DELIVERY_UNCONFIRMED"));
            await state.update((data) => {
                const saved = data.researchJobs?.[current.id];
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
            throw Error(researchText("UI_UNAUTHORIZED"));
        }
        if (!messageTs || messageTs !== job.messageTs || ref.revision !== job.revision ||
            !researchActions(job).includes(action)) {
            throw Error(researchText("UI_EXPIRED"));
        }
        return job;
    }

    async function notify(body, channel, text) {
        if (!channel || !body.user?.id) return;
        try {
            if (reply) await reply({ channel, user: body.user.id, text });
            else await client.chat.postEphemeral({ channel, user: body.user.id, text });
        } catch { console.warn(researchText("UI_REPLY_UNAVAILABLE")); }
    }

    function context(job, revision) {
        return { team: job.team, user: job.user, channel: job.channel, thread: job.thread, revision };
    }

    async function execute(body, job, action, text, revision) {
        const result = await control(job.id, action, text, context(job, revision));
        if (typeof result === "string" && result) await notify(body, job.channel, result);
    }

    function register(app) {
        const actionPattern = /^research_(start|edit|reply|status|pause|cancel|summarize|finish|resume|more|canvas)$/;
        app.action(actionPattern, async (event) => {
            const { ack, body, action } = event;
            await ack();
            const channel = body.channel?.id;
            try {
                const parts = typeof action.value === "string" ? action.value.split(":") : [];
                if (parts.length !== 2 || !/^\d+$/.test(parts[1])) throw Error(researchText("UI_INVALID_ACTION"));
                const ref = reference.parse({ id: parts[0], revision: Number(parts[1]) });
                const name = action.action_id.replace(/^research_/, "");
                const job = await authorize(body, ref, channel, body.message?.ts, name);
                if (["edit", "reply", "more"].includes(name)) {
                    await client.views.open({ trigger_id: body.trigger_id, view: {
                        type: "modal", callback_id: "research_edit", title: plain(researchText("UI_TITLE"), 24),
                        submit: plain(researchText("UI_SUBMIT"), 24), close: plain(researchText("UI_CANCEL"), 24),
                        private_metadata: JSON.stringify({ ...ref, action: name, channel, messageTs: job.messageTs }),
                        blocks: [{ type: "input", block_id: "research_input",
                            label: plain(researchText(`UI_INPUT_${name}`)),
                            element: { type: "plain_text_input", action_id: "text", multiline: true, max_length: 3000 },
                        }],
                    } });
                } else await execute(body, job, name, undefined, ref.revision);
            } catch (error) {
                await notify(body, channel,
                    error instanceof z.ZodError ? researchText("UI_INVALID_ACTION") : error.message);
            }
        });
        app.view("research_edit", async ({ ack, body, view }) => {
            await ack();
            let channel;
            try {
                const ref = metadata.parse(JSON.parse(view.private_metadata));
                channel = ref.channel;
                const job = await authorize(body, ref, channel, ref.messageTs, ref.action);
                const text = input.parse(view.state?.values?.research_input?.text?.value);
                await execute(body, job, ref.action, text, ref.revision);
            } catch (error) {
                await notify(body, channel, error instanceof z.ZodError || error instanceof SyntaxError ?
                    researchText("UI_INVALID_INPUT") : error.message);
            }
        });
    }

    return { publish, register };
}
