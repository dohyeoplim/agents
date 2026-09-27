export function routeEvent(config, body, event, bot, known) {
    const route = config.channels[event.channel];
    if (
        body.team_id !== config.team ||
        !route ||
        route.enabled === false ||
        !config.users.includes(event.user) ||
        event.bot_id ||
        event.subtype ||
        typeof event.text !== "string"
    )
        return null;
    const thread = event.thread_ts || event.ts;
    if (!/^\d+\.\d+$/.test(thread ?? "")) return null;
    const key = `${config.team}:${event.channel}:${thread}:${route.agent}`;
    const mentioned = event.text.includes(`<@${bot}>`);
    if (!mentioned && !(event.thread_ts && known(key))) return null;
    const prompt = event.text.replaceAll(`<@${bot}>`, "").trim();
    if (!prompt || prompt.length > 16000) return null;
    return {
        key,
        route,
        prompt,
        thread,
        eventId: `${event.channel}:${event.ts}`,
    };
}
