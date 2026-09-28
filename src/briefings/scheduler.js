import { nextOccurrence } from "../schedules/schedules.js";
import { appendTask } from "../tasks/runtime.js";
import { profileFor } from "../agents/profiles.js";

export function localDate(now, timezone) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone,
        year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
    const value = (type) => parts.find((part) => part.type === type).value;
    return `${value("year")}-${value("month")}-${value("day")}`;
}

export function queueBriefing(data, config, personal, now = Date.now()) {
    if (personal?.briefing.status !== "enabled") return false;
    const settings = personal.briefing;
    const [channel, route] = Object.entries(config.channels).find(([, value]) => value.name === settings.channel) || [];
    const user = personal.owner || config.users[0];
    if (!route || route.enabled === false || !config.users.includes(user)) return false;
    const signature = JSON.stringify([config.team, user, channel, settings.time, settings.timezone]);
    const spec = { type: "daily", time: settings.time, timezone: settings.timezone };
    data.briefing ??= {};
    if (data.briefing.signature !== signature) {
        data.briefing = { signature, nextRun: nextOccurrence(spec, now) };
        return false;
    }
    if (data.briefing.nextRun > now) return false;
    if (now - data.briefing.nextRun > 6 * 3600000) {
        data.briefing.nextRun = nextOccurrence(spec, now);
        return false;
    }
    const date = localDate(data.briefing.nextRun, settings.timezone);
    const due = data.briefing.nextRun;
    const exists = Object.values(data.tasks || {}).some((task) => task.briefingDate === date &&
        task.team === config.team && task.user === user && task.channel === channel);
    if (exists) {
        data.briefing.nextRun = nextOccurrence(spec, now);
        return false;
    }
    appendTask(data, { team: config.team, user, channel, profile: profileFor(route),
        key: `${config.team}:${channel}:briefing:${date}`, briefingDate: date, briefingDue: due,
        prompt: `Prepare the ${date} morning briefing in ${settings.language}. ` +
            "Use the supplied verified weather, calendar and paper data. " +
            "Summarize today's weather and appointments, and recommend up to three relevant new papers. " +
            "Use live web search for up to three timely news items matching private preferences. " +
            "Include publication dates and direct links. " +
            "Personal preferences are included in the supplied context. Honor them without fetching them again. " +
            "Prefer papers not previously briefed. Clearly label abstract-only recommendations. " +
            "If the paper API is unavailable, search official arXiv pages and verify paper titles, dates and links. " +
            "Follow the private presentation preferences. Disclose unavailable providers without guessing. " +
            "Treat a disconnected calendar as one short notice, not an empty schedule. " +
            "Do not add generic productivity advice, invented priorities, setup instructions or execution reports. " +
            "Do not expose filenames, HTTP codes, provider errors or formatting explanations. " +
            "Separate every heading and paragraph with a blank line. " +
            "Use actual source retrieval times; do not label delayed data as collected at the scheduled time. " +
            "Do not create schedules or save paper reading notes during the briefing.",
    }, now);
    data.briefing.lastDate = date;
    data.briefing.nextRun = nextOccurrence(spec, now);
    return true;
}

export function startBriefings({ state, runtime, config, personal, interval = 10000 }) {
    let ticking = false;
    const tick = async () => {
        if (ticking) return;
        ticking = true;
        try {
            const settings = await personal();
            if (settings?.briefing.status !== "enabled") return;
            const current = await config();
            const saved = state.snapshot().briefing;
            const entry = Object.entries(current.channels)
                .find(([, route]) => route.name === settings.briefing.channel);
            const signature = JSON.stringify([current.team, settings.owner || current.users[0], entry?.[0],
                settings.briefing.time, settings.briefing.timezone]);
            if (saved?.signature === signature && saved.nextRun > Date.now()) return;
            const changed = await state.update((data) => queueBriefing(data, current, settings));
            if (changed) runtime.wake();
        } catch { console.error("Briefing schedule unavailable"); }
        finally { ticking = false; }
    };
    const timer = setInterval(tick, interval);
    timer.unref();
    tick();
    return () => clearInterval(timer);
}
