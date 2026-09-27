import { loadConfig } from "../channels/config.js";
import { redactSecrets } from "./formatting.js";

export function normalizeTitle(value) {
    if (typeof value !== "string") throw Error("Provide a thread title");
    const title = redactSecrets(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    if (!title || title.length > 200) throw Error("Title must contain 1 to 200 characters");
    return title;
}

export function suggestTitle(prompt) {
    const text = redactSecrets(prompt)
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, "$1")
        .replace(/<@[^>]+>|<![^>]+>/g, "")
        .replace(/[#*_`~>]/g, "")
        .replace(/\s+/g, " ").trim();
    return Array.from(text || "New conversation").slice(0, 80).join("");
}

export function createThreadTitles({ state, token, request = fetch, config = loadConfig }) {
    async function call(method, payload) {
        const response = await request("https://slack.com/api/" + method, {
            method: "POST",
            headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return { ok: false };
        return response.json();
    }

    async function syncTitle(context, title) {
        const payload = { channel_id: context.channel, thread_ts: context.thread, title };
        try {
            let result = await call("agents.sessions.rename", payload);
            if (result.error === "session_not_found") {
                result = await call("agents.sessions.setStatus", {
                    ...payload, status: "active", initiator_user_id: context.user,
                });
            }
            const fallbackErrors = ["unknown_method", "feature_disabled", "deprecated_endpoint", "not_authorized"];
            if (fallbackErrors.includes(result.error)) {
                result = await call("assistant.threads.setTitle", payload);
            }
            return result.ok === true;
        } catch {
            return false;
        }
    }

    async function save(context, title, automatic) {
        title = normalizeTitle(title);
        const accepted = await state.update((data) => {
            const thread = data.threads[context.key];
            if (!thread) throw Error("Thread not found");
            if (automatic && thread.title && (thread.titleSynced || thread.titleRetryAt > Date.now())) return false;
            if (automatic && thread.title) title = thread.title;
            thread.title = title;
            thread.titleSource = automatic ? thread.titleSource || "automatic" : "user";
            thread.titleRetryAt = Date.now() + 60000;
            return true;
        });
        if (!accepted) return { title, synced: state.snapshot().threads[context.key].titleSynced === true };
        const synced = await syncTitle(context, title);
        await state.update((data) => {
            if (data.threads[context.key].title === title) data.threads[context.key].titleSynced = synced;
        });
        return { title, synced };
    }

    return {
        set: (context, title) => save(context, title, false),
        ensure: (context, prompt) => save(context, suggestTitle(prompt), true),
        async changed({ body, event }) {
            const current = await config();
            const route = current.channels[event.channel];
            if ((body.team_id || event.team_id) !== current.team || !current.users.includes(event.user) ||
                !route || route.enabled === false || !/^\d+\.\d+$/.test(event.thread_ts || "")) return;
            const key = `${current.team}:${event.channel}:${event.thread_ts}:${route.agent}`;
            const title = normalizeTitle(event.title);
            await state.update((data) => {
                if (!data.threads[key]) return;
                data.threads[key].title = title;
                data.threads[key].titleSource = "slack";
                data.threads[key].titleSynced = true;
            });
        },
    };
}
