import { randomUUID } from "node:crypto";
import { appendTask, ownedTasks } from "../tasks/runtime.js";
import { splitFirst } from "../shared/text.js";

export function nextOccurrence(spec, after) {
    if (spec.type === "at") return spec.at > after ? spec.at : null;
    if (spec.type === "every") return after + spec.interval;
    const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: spec.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    let next = Math.floor(after / 60000) * 60000 + 60000;
    for (let count = 0; count < 49 * 60; count++, next += 60000) {
        if (formatter.format(new Date(next)) === spec.time) return next;
    }
    throw Error("Unable to resolve the next daily run");
}

export function parseSchedule(text, now = Date.now()) {
    const [type, rest] = splitFirst(text);
    const [value, remaining] = splitFirst(rest);
    let prompt = remaining;
    let spec;
    if (type === "every") {
        const match = /^(\d+)(m|h|d)$/.exec(value);
        if (!match) throw Error("Use an interval such as 30m, 1h or 1d");
        const interval = Number(match[1]) * { m: 60000, h: 3600000, d: 86400000 }[match[2]];
        if (interval < 60000 || interval > 30 * 86400000) throw Error("Interval must be between 1m and 30d");
        spec = { type, interval };
    } else if (type === "daily") {
        const [timezone, task] = splitFirst(remaining);
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw Error("Use a daily time such as 09:00");
        try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
        catch { throw Error("Provide a valid timezone such as Asia/Seoul"); }
        if (!timezone) throw Error("A daily schedule requires a timezone");
        spec = { type, time: value, timezone };
        prompt = task;
    } else if (type === "at") {
        if (!/(Z|[+-]\d\d:\d\d)$/.test(value)) throw Error("The date must include a timezone");
        const at = Date.parse(value);
        if (!Number.isFinite(at) || at <= now) throw Error("Provide a future date");
        spec = { type, at };
    } else throw Error("Use !schedule every, daily or at");
    const onChange = prompt.startsWith("--on-change ");
    if (onChange) prompt = prompt.slice(12).trim();
    if (!prompt || prompt.startsWith("!") || prompt.length > 16000) throw Error("Provide a plain task request");
    return { spec, prompt, onChange, nextRun: nextOccurrence(spec, now) };
}

export function ownedSchedules(data, context) {
    return Object.values(data.schedules || {}).filter((job) => job.team === context.team &&
        job.user === context.user && job.channel === context.channel);
}

export function addSchedule(data, context, text, now = Date.now()) {
    const parsed = parseSchedule(text, now);
    data.schedules ??= {};
    if (Object.keys(data.schedules).length >= 100) throw Error("Schedule limit reached");
    const id = randomUUID();
    data.schedules[id] = { ...context, ...parsed, id, enabled: true, createdAt: now };
    return id;
}

export function changeSchedule(data, context, selector, action, now = Date.now()) {
    if (!["pause", "resume", "remove"].includes(action)) throw Error("Invalid schedule action");
    if (!/^[0-9a-f-]{8,36}$/.test(selector || "")) throw Error("Provide a schedule ID from !schedules");
    const matches = ownedSchedules(data, context).filter((job) => job.id.startsWith(selector));
    if (matches.length !== 1) throw Error("Schedule not found or ID is ambiguous");
    const job = matches[0];
    if (action === "remove") delete data.schedules[job.id];
    else {
        job.enabled = action === "resume";
        if (job.enabled) {
            job.nextRun = nextOccurrence(job.spec, now);
            if (!job.nextRun) throw Error("This one-time schedule has expired");
        }
    }
}

export function dispatchDue(data, config, now = Date.now()) {
    let count = 0;
    for (const job of Object.values(data.schedules || {})) {
        if (!job.enabled || !job.nextRun || job.nextRun > now) continue;
        const route = config.channels[job.channel];
        if (config.team !== job.team || !config.users.includes(job.user) || !route || route.enabled === false) {
            job.enabled = false;
            continue;
        }
        const running = ownedTasks(data, job).some((task) => task.scheduleId === job.id &&
            ["queued", "running", "cancelling"].includes(task.status));
        if (running) continue;
        try {
            appendTask(data, { ...job, scheduleId: job.id }, now);
        } catch {
            break;
        }
        job.lastRun = now;
        job.nextRun = nextOccurrence(job.spec, now);
        if (!job.nextRun) job.enabled = false;
        count++;
    }
    return count;
}
