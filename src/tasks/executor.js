import { loadConfig } from "../channels/config.js";
import { withSlackActivity } from "../slack/activity.js";
import { knowledgeContext } from "../knowledge/memory.js";
import { sessionFor } from "./runtime.js";
import { resourceContext } from "../resources/context.js";
import { workerResponse } from "./response.js";
import { loadPersonal } from "../integrations/settings.js";

export function createTaskExecutor({
    state, token, resources, streams, toolServer, briefingContext, historyContext,
    config = loadConfig, personal = loadPersonal, request = fetch, activity = withSlackActivity,
}) {
    return async (task, signal) => {
        const research = Boolean(task.researchId);
        const current = await config();
        const route = current.channels[task.channel];
        if (!route || route.enabled === false || task.team !== current.team || !current.users.includes(task.user)) {
            throw Error("Task is no longer authorized");
        }
        const settings = await personal();
        const notionOwner = task.user === (settings?.owner || current.users[0]);
        const endpoint = "http://" + route.agent + ":8080";
        let grant;
        const abort = () => {
            request(endpoint + "/cancel", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: task.id }), signal: AbortSignal.timeout(5000),
            }).catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            const showActivity = task.briefingDate || research ? async (context, run) => run() : activity;
            return await showActivity({
                token, channel: task.channel, thread: task.thread,
            }, async () => {
                if (signal.aborted) throw Error("Task cancelled");
                const data = state.snapshot();
                const session = research ? undefined : sessionFor(data, task);
                const history = historyContext && (!research || task.researchStage === "clarify") ?
                    await historyContext.hydrate(task, session, signal) : { text: "" };
                const sources = resources && !task.briefingDate ? await resources.collect(task, signal) :
                    { sources: [], notices: [] };
                const sourceContext = task.briefingDate ? await briefingContext(task, signal) :
                    resourceContext(sources, task.prompt);
                if (signal.aborted) throw Error("Task cancelled");
                grant = toolServer?.grant(task, signal);
                const response = await request(endpoint + "/run", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: task.id, channel: task.channel, prompt: task.prompt,
                        profile: task.profile, skill: task.skill, session,
                        context: knowledgeContext(data, task, task.prompt),
                        sourceContext, historyContext: history.text,
                        images: sources.images || [],
                        stream: research || Boolean(streams && !task.scheduleId && !task.briefingDate),
                        ...(research ? { researchId: task.researchId, researchStage: task.researchStage,
                            researchRunId: task.researchRunId,
                            provider: task.provider || "codex" } : {}),
                        toolToken: grant?.token,
                        notionAccess: notionOwner && Boolean(grant?.token),
                    }),
                    signal: research ? signal : AbortSignal.any([signal, AbortSignal.timeout(620000)]),
                });
                if (!response.ok) throw Error("Worker failed");
                const result = await workerResponse(response, research ? undefined :
                    (text) => streams?.update(task, text), { longRunning: research });
                if (typeof result.answer !== "string" || !/^[0-9a-f-]{36}$/i.test(result.session || "")) {
                    throw Error("Invalid worker response");
                }
                return { ...result, historyReceipt: history.receipt };
            });
        } finally {
            grant?.revoke();
            signal.removeEventListener("abort", abort);
        }
    };
}
