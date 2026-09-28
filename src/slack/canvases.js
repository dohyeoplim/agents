import { createHash } from "node:crypto";
import { z } from "zod";

export const canvasInput = z.object({
    title: z.string().trim().min(1).max(200),
    markdown: z.string().trim().min(1).max(20000),
}).strict();

const uncertain = "Canvas creation outcome is unknown. Check the channel's canvas tabs before creating another.";
const failures = {
    missing_scope: "Canvas creation needs canvases:write on the bot token. Reinstall the Slack app.",
    no_permission: "The bot cannot create a canvas in this channel. Check channel membership and permissions.",
    not_in_channel: "Invite the bot to this channel before creating a canvas.",
    canvas_disabled_user_team: "Canvas is disabled in this Slack workspace.",
    free_team_canvas_tab_already_exists: "This free workspace already has its allowed canvas tab in this channel.",
    canvas_creation_failed: "Slack rejected the canvas content. Simplify the Markdown and try again.",
    invalid_arguments: "Slack rejected the canvas arguments.",
    invalid_auth: "The Slack bot token is invalid.",
    token_revoked: "The Slack bot token has been revoked.",
    ratelimited: "Slack rate limit reached. Wait before trying again.",
};

export function createCanvases({ token, state, workspaceUrl, request = fetch }) {
    const origin = new URL(workspaceUrl);
    if (origin.protocol !== "https:" || !origin.hostname.endsWith(".slack.com") ||
        origin.username || origin.password) throw Error("Invalid Slack workspace URL");
    return {
        async create(input, context, signal) {
            const args = canvasInput.parse(input);
            if (!token) throw Error("Slack bot token is missing");
            if (!/^T[A-Z0-9]+$/.test(context.team) || !/^[CG][A-Z0-9]+$/.test(context.channel)) {
                throw Error("Invalid canvas context");
            }
            signal?.throwIfAborted();
            const key = createHash("sha256").update(JSON.stringify(args)).digest("hex");
            const existing = await state.update((draft) => {
                const task = draft.tasks[context.id];
                if (!task || task.status !== "running" || task.team !== context.team ||
                    task.user !== context.user || task.channel !== context.channel) {
                    throw Error("Canvas task is no longer authorized");
                }
                task.canvasCreations ||= {};
                if (task.canvasCreations[key]) return task.canvasCreations[key];
                task.canvasCreations[key] = { status: "pending", title: args.title };
                return null;
            });
            if (existing?.status === "created") return existing.result;
            if (existing) throw Error(uncertain);
            let result;
            let response;
            try {
                response = await request("https://slack.com/api/canvases.create", {
                    method: "POST", redirect: "error",
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
                    body: JSON.stringify({ title: args.title, channel_id: context.channel,
                        document_content: { type: "markdown", markdown: args.markdown } }),
                    signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
                });
                if (response.status === 429) result = { ok: false, error: "ratelimited" };
                else if (response.ok) result = await response.json();
            } catch { throw Error(uncertain); }
            if (result?.ok === false && Object.hasOwn(failures, result.error)) {
                await state.update((draft) => { delete draft.tasks[context.id].canvasCreations[key]; });
                throw Error(failures[result.error]);
            }
            if (result?.ok !== true || typeof result.canvas_id !== "string" ||
                !/^F[A-Z0-9]+$/.test(result.canvas_id)) throw Error(uncertain);
            const created = { canvasId: result.canvas_id, title: args.title, channel: context.channel,
                url: new URL(`/docs/${context.team}/${result.canvas_id}`, origin).href };
            try {
                await state.update((draft) => {
                    draft.tasks[context.id].canvasCreations[key] = { status: "created", result: created };
                });
            } catch {
                return { ...created, warning: "Canvas created, but saving its receipt failed. Do not create it again." };
            }
            return created;
        },
    };
}
