import { loadConfig } from "../channels/config.js";
import { withSlackActivity } from "../slack/activity.js";
import { knowledgeContext } from "../knowledge/memory.js";
import { sessionFor } from "./runtime.js";
import { resourceContext } from "../resources/context.js";
import { workerResponse } from "./response.js";

export function createTaskExecutor({
    state, token, resources, streams, config = loadConfig, request = fetch, activity = withSlackActivity,
}) {
    return async (task, signal) => {
        const current = await config();
        const route = current.channels[task.channel];
        if (!route || route.enabled === false || task.team !== current.team || !current.users.includes(task.user)) {
            throw Error("Task is no longer authorized");
        }
        const endpoint = "http://" + route.agent + ":8080";
        const abort = () => {
            request(endpoint + "/cancel", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: task.id }), signal: AbortSignal.timeout(5000),
            }).catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            return await activity({
                token, channel: task.channel, thread: task.thread,
            }, async () => {
                if (signal.aborted) throw Error("Task cancelled");
                const data = state.snapshot();
                const sources = resources ? await resources.collect(task, signal) : { sources: [], notices: [] };
                if (signal.aborted) throw Error("Task cancelled");
                const response = await request(endpoint + "/run", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: task.id, channel: task.channel, prompt: task.prompt,
                        profile: task.profile, skill: task.skill, session: sessionFor(data, task),
                        context: knowledgeContext(data, task, task.prompt),
                        sourceContext: resourceContext(sources, task.prompt),
                        images: sources.images || [], stream: Boolean(streams && !task.scheduleId),
                    }),
                    signal: AbortSignal.any([signal, AbortSignal.timeout(620000)]),
                });
                if (!response.ok) throw Error("Worker failed");
                const result = await workerResponse(response, (text) => streams?.update(task, text));
                if (typeof result.answer !== "string" || !/^[0-9a-f-]{36}$/i.test(result.session || "")) {
                    throw Error("Invalid worker response");
                }
                return result;
            });
        } finally {
            signal.removeEventListener("abort", abort);
        }
    };
}
