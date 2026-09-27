import { loadProfiles } from "../agents/profiles.js";
import { markdownMessages, streamText } from "./formatting.js";

export function createSlackStreams({ state, token, post, request = fetch, profiles = loadProfiles, now = Date.now }) {
    const active = new Map();
    async function call(method, input) {
        const response = await request("https://slack.com/api/" + method, {
            method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify(input), signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw Error("Slack streaming request failed");
        const result = await response.json();
        if (!result.ok) throw Object.assign(Error("Slack streaming failed"), { code: result.error });
        return result;
    }

    async function update(task, text) {
        if (task.scheduleId) return;
        const current = active.get(task.id) || { sent: "", last: -Infinity, disabled: false };
        active.set(task.id, current);
        if (current.disabled || now() - current.last < 1000) return;
        const safe = streamText(text);
        if (!safe || safe === current.sent || !safe.startsWith(current.sent)) return;
        current.last = now();
        try {
            const saved = state.snapshot().tasks[task.id];
            if (!saved.streamTs) {
                const available = await profiles();
                const name = Object.hasOwn(available, task.profile) ? available[task.profile].name : undefined;
                const input = { channel: task.channel, thread_ts: task.thread, recipient_team_id: task.team,
                    recipient_user_id: task.user, markdown_text: safe, ...(name ? { username: name } : {}) };
                let result;
                try { result = await call("chat.startStream", input); }
                catch (error) {
                    if (error.code !== "missing_scope" || !input.username) throw error;
                    delete input.username;
                    result = await call("chat.startStream", input);
                }
                if (!/^\d+\.\d+$/.test(result.ts || "")) throw Error("Missing stream timestamp");
                await state.update((data) => { data.tasks[task.id].streamTs = result.ts; });
            } else {
                await call("chat.appendStream", { channel: task.channel, ts: saved.streamTs,
                    markdown_text: safe.slice(current.sent.length) });
            }
            current.sent = safe;
        } catch {
            current.disabled = true;
            console.warn("Slack streaming unavailable; final answer will still be delivered");
        }
    }

    async function deliver(task, answer) {
        active.delete(task.id);
        const saved = state.snapshot().tasks[task.id];
        if (!saved?.streamTs) return post(task, answer);
        try { await call("chat.stopStream", { channel: task.channel, ts: saved.streamTs }); }
        catch (error) { if (error.code !== "message_not_in_streaming_state") throw error; }
        const parts = markdownMessages(answer);
        await call("chat.update", { channel: task.channel, ts: saved.streamTs, markdown_text: parts[0],
            parse: "none", link_names: false });
        for (const part of parts.slice(1)) await post(task, part);
    }

    return { update, deliver };
}
