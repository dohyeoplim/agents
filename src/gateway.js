import bolt from "@slack/bolt";
import { routeEvent, SerialQueue, chunks } from "./core.js";
import { loadConfig } from "./channels.js";
import { withSlackActivity } from "./activity.js";
import { loadProfiles, profileFor } from "./profiles.js";
import { loadSkills } from "./skills.js";
import { PersistentState } from "./state.js";
import { knowledgeContext } from "./knowledge.js";
import { knowledgeCommand, parseCommand, requestedTask, splitFirst } from "./commands.js";
import { TaskRuntime, ownedTasks, sessionFor } from "./tasks.js";
import { addSchedule, changeSchedule, dispatchDue, ownedSchedules } from "./schedules.js";

const config = await loadConfig();
const state = await new PersistentState("/state/conversations.json", {
    threads: {}, events: {}, tasks: {}, entries: {}, schedules: {},
}).load();
const events = new SerialQueue();
const quietLogger = {
    debug() {},
    info() {},
    warn() { console.warn("Slack warning"); },
    error() { console.error("Slack error"); },
    setLevel() {},
    getLevel() { return "error"; },
    setName() {},
};
const app = new bolt.App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logger: quietLogger,
});
const identity = await app.client.auth.test();
if (identity.team_id !== config.team) throw Error("Slack workspace mismatch");

async function post(context, text) {
    const safe = text.replace(/xox[baprs]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
    for (const part of chunks(safe.slice(0, 28000))) {
        await app.client.chat.postMessage({
            channel: context.channel, thread_ts: context.thread, text: part,
            mrkdwn: false, unfurl_links: false, unfurl_media: false,
        });
    }
}

const runtime = new TaskRuntime({
    store: state,
    deliver: (task, answer) => post(task, task.profile + "\n\n" + answer),
    execute: async (task, signal) => {
        const current = await loadConfig();
        const route = current.channels[task.channel];
        if (!route || route.enabled === false || task.team !== current.team || !current.users.includes(task.user)) {
            throw Error("Task is no longer authorized");
        }
        const endpoint = "http://" + route.agent + ":8080";
        const abort = () => {
            fetch(endpoint + "/cancel", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: task.id }), signal: AbortSignal.timeout(5000),
            }).catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            return await withSlackActivity({
                token: process.env.SLACK_BOT_TOKEN, channel: task.channel, thread: task.thread,
            }, async () => {
                if (signal.aborted) throw Error("Task cancelled");
                const data = state.snapshot();
                const response = await fetch(endpoint + "/run", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: task.id, channel: task.channel, prompt: task.prompt,
                        profile: task.profile, skill: task.skill, session: sessionFor(data, task),
                        context: knowledgeContext(data, task, task.prompt),
                    }),
                    signal: AbortSignal.any([signal, AbortSignal.timeout(620000)]),
                });
                if (!response.ok) throw Error("Worker failed");
                const result = await response.json();
                if (typeof result.answer !== "string" || !/^[0-9a-f-]{36}$/i.test(result.session || "")) {
                    throw Error("Invalid worker response");
                }
                return result;
            });
        } finally {
            signal.removeEventListener("abort", abort);
        }
    },
});

async function commandReply(command, context, profiles, skills) {
    const knowledge = await knowledgeCommand(command, context, state, profiles, skills);
    if (knowledge !== null) return knowledge;
    const { name, args } = command;
    if (name === "tasks") {
        return ownedTasks(state.snapshot(), context).slice(-10).reverse().map((task) =>
            [task.id.slice(0, 8), task.status, task.profile, "delivery=" + task.delivery].join(" ")
        ).join("\n") || "No tasks";
    }
    if (name === "stop") return "Cancellation requested: " + (await runtime.cancel(context, args)).slice(0, 8);
    if (name === "retry") return "Queued retry: " + (await runtime.retry(context, args)).slice(0, 8);
    if (name === "redeliver") {
        await runtime.redeliver(context, args);
        return "Saved answer queued for delivery";
    }
    if (name === "schedules") {
        return ownedSchedules(state.snapshot(), context).map((job) => [
            job.id.slice(0, 8), job.enabled ? "enabled" : "paused",
            job.nextRun ? new Date(job.nextRun).toISOString() : "complete", job.prompt,
        ].join(" ")).join("\n") || "No schedules";
    }
    if (name === "schedule") {
        const [action, selector] = splitFirst(args);
        if (["pause", "resume", "remove"].includes(action)) {
            await state.update((data) => changeSchedule(data, context, selector, action));
            return "Schedule " + action + " completed";
        }
        const id = await state.update((data) => addSchedule(data, context, args));
        return "Schedule saved: " + id.slice(0, 8) + ". Replies will be sent to this thread.";
    }
    if (name === "new") {
        await state.update((data) => {
            if (ownedTasks(data, context).some((task) => task.key === context.key &&
                ["queued", "running", "cancelling"].includes(task.status))) {
                throw Error("Stop active tasks in this thread before starting a new conversation");
            }
            const thread = data.threads[context.key];
            const previous = thread.sessions || { legacy: thread.session };
            thread.previousSessions = [...(thread.previousSessions || []), previous].slice(-10);
            thread.session = null;
            thread.sessions = {};
        });
        return "The next request will start a new conversation. Saved memory and files are unchanged.";
    }
    return null;
}

async function handle({ body, event }) {
    await events.run(async () => {
        const current = await loadConfig();
        const selected = routeEvent(current, body, event, identity.user_id, (key) => !!state.snapshot().threads[key]);
        if (!selected) return;
        const claimed = await state.update((data) => {
            if (data.events[selected.eventId]) return false;
            data.events[selected.eventId] = Date.now();
            data.threads[selected.key] ??= { session: null };
            for (const [id, at] of Object.entries(data.events)) {
                if (Date.now() - at > 7 * 86400000) delete data.events[id];
            }
            return true;
        });
        if (!claimed) return;
        const context = {
            team: current.team, user: event.user, channel: event.channel, thread: selected.thread,
            key: selected.key, profile: profileFor(selected.route),
        };
        try {
            const profiles = await loadProfiles();
            const skills = await loadSkills();
            if (!Object.hasOwn(profiles, context.profile)) throw Error("Channel profile is unavailable");
            const command = parseCommand(selected.prompt);
            if (command) {
                const response = await commandReply(command, context, profiles, skills);
                if (response !== null) return post(context, response);
            }
            const task = requestedTask(selected.prompt, profiles, selected.route, skills);
            const busy = runtime.pumping;
            const id = await runtime.enqueue({ ...context, ...task });
            if (busy) await post(context, "Queued task " + id.slice(0, 8) + ". Use !tasks to check its status.");
        } catch (error) {
            await post(context, error.message + "\nUse !help for available commands.");
        }
    });
}

app.event("app_mention", handle);
app.event("message", handle);
app.error(async () => console.error("Slack event failed"));
await runtime.recover();
await app.start();
runtime.wake();
console.log("Slack bridge ready");

let ticking = false;
const scheduler = setInterval(async () => {
    if (ticking) return;
    const due = Object.values(state.snapshot().schedules).some((job) => job.enabled && job.nextRun <= Date.now());
    if (!due) return;
    ticking = true;
    try {
        const current = await loadConfig();
        await state.update((data) => dispatchDue(data, current));
        runtime.wake();
    } catch {
        console.error("Schedule dispatch failed");
    } finally {
        ticking = false;
    }
}, 10000);
scheduler.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        clearInterval(scheduler);
        await app.stop();
        await events.tail;
        runtime.closed = true;
        await runtime.idle();
        await state.tail;
        process.exit(0);
    });
}
