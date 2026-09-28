import { nextOccurrence } from "../schedules/schedules.js";
import { appendTask } from "../tasks/runtime.js";
import { profileFor } from "../agents/profiles.js";
import { buildBriefingPrompt } from "../agents/prompt.js";

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
        prompt: buildBriefingPrompt(date, settings.language),
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
