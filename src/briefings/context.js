import { localDate } from "./scheduler.js";
import { preferenceContext } from "../integrations/settings.js";

export function dayRange(date, timezone) {
    const noon = Date.parse(date + "T12:00:00Z");
    let start;
    let end;
    for (let stamp = noon - 36 * 3600000; stamp <= noon + 36 * 3600000; stamp += 60000) {
        if (localDate(stamp, timezone) === date) start ??= stamp;
        else if (start !== undefined) { end = stamp; break; }
    }
    if (start === undefined || end === undefined) throw Error("Unable to resolve briefing date");
    return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

export function createBriefingContext({ tools, personal, now = Date.now }) {
    return async (task, signal) => {
        const settings = await personal();
        const range = dayRange(task.briefingDate, settings.briefing.timezone);
        const query = settings.reading.query || settings.reading.confirmedInterests
            .map(({ topic }) => `all:"${topic.replace(/["\\]/g, " ")}"`).join(" OR ");
        const requests = [
            ["weather", "weather_forecast", {}],
            ["calendar", "calendar_events", range],
            ["papers", "papers_search", { query, days: 7, limit: 30 }],
        ];
        const results = await Promise.allSettled(requests.map(([, name, args]) =>
            tools.call(name, args, task, signal)));
        signal?.throwIfAborted();
        const context = { date: task.briefingDate, timezone: settings.briefing.timezone,
            preparedAt: new Date(now()).toISOString(), preferences: preferenceContext(settings) };
        for (let index = 0; index < results.length; index++) {
            const result = results[index];
            const provider = requests[index][0];
            if (result.status === "fulfilled") context[provider] = result.value;
            else {
                const missing = String(result.reason.message).startsWith("Provider not configured:");
                context[provider] = { unavailable: true,
                    reason: missing ? "not_connected" : "temporarily_unavailable" };
                console.warn("Briefing provider unavailable", JSON.stringify({ provider, task: task.id,
                    code: result.reason.cause?.code || result.reason.status || result.reason.name }));
            }
        }
        if (context.weather.current) {
            context.weather.hours = context.weather.hours.map((hour) => ({ time: hour.forecastStart,
                temperature: hour.temperature, rainChance: hour.precipitationChance, condition: hour.conditionCode }));
        }
        if (context.papers.papers) {
            context.papers.papers = context.papers.papers.filter((paper) =>
                !paper.previouslyBriefed && !["read", "skipped"].includes(paper.readingStatus))
                .slice(0, 10).map((paper) => ({ ...paper,
                abstract: paper.abstract.slice(0, 700), abstractTruncated: paper.abstract.length > 700,
                authors: paper.authors.slice(0, 3) }));
        }
        if (context.calendar.events?.length > 30) {
            context.calendar.events = context.calendar.events.slice(0, 30);
            context.calendar.notices.push("Only the first 30 calendar events are included in this briefing");
        }
        while (JSON.stringify(context).length > 18500 && context.papers.papers?.length) context.papers.papers.pop();
        if (JSON.stringify(context).length > 19500) throw Error("Briefing context too large");
        return JSON.stringify(context);
    };
}
