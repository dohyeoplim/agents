import { localDate } from "./scheduler.js";

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

export function createBriefingContext({ tools, personal }) {
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
        const context = { date: task.briefingDate, timezone: settings.briefing.timezone };
        for (let index = 0; index < results.length; index++) {
            const result = results[index];
            context[requests[index][0]] = result.status === "fulfilled" ? result.value :
                { unavailable: true, message: String(result.reason.message).slice(0, 200) };
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
