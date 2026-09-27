import { isFileId } from "../resources/identifiers.js";

export function routeEvent(config, body, event, bot, known) {
    const route = config.channels[event.channel];
    if (
        body.team_id !== config.team ||
        !route ||
        route.enabled === false ||
        !config.users.includes(event.user) ||
        event.bot_id ||
        (event.subtype && event.subtype !== "file_share") ||
        (event.text !== undefined && typeof event.text !== "string")
    )
        return null;
    const thread = event.thread_ts || event.ts;
    if (!/^\d+\.\d+$/.test(thread ?? "")) return null;
    const key = `${config.team}:${event.channel}:${thread}:${route.agent}`;
    const text = event.text || "";
    const fileIds = Array.isArray(event.files) ? event.files.map((file) => file?.id).filter(isFileId).slice(0, 6) : [];
    const mentioned = text.includes(`<@${bot}>`);
    if (!mentioned && !(event.thread_ts && known(key))) return null;
    const prompt = text.replaceAll(`<@${bot}>`, "").trim() || (fileIds.length ? "Summarize the attached files." : "");
    if (!prompt || prompt.length > 16000) return null;
    return {
        key,
        route,
        prompt,
        fileIds,
        thread,
        eventId: `${event.channel}:${event.ts}`,
    };
}
