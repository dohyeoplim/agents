import { knowledgeCommand } from "../knowledge/commands.js";
import { resolveSkill } from "../agents/skills.js";
import { resolveProfile } from "../agents/profiles.js";
import { parseCommand, splitFirst } from "../shared/text.js";
import { ownedTasks } from "../tasks/runtime.js";
import { addSchedule, changeSchedule, ownedSchedules } from "../schedules/schedules.js";
import { isFileId } from "../resources/identifiers.js";
import { sourceList } from "../resources/context.js";
import { researchText } from "../research/copy.js";

export const helpText = [
    "!profile - show agent profiles and the current profile",
    "!remember <shared|profile|channel> <text>",
    "!memories - list saved preferences",
    "!note <shared|profile|channel> <title> | <text>",
    "!search <words> - search accessible notes and memories",
    "!forget <entry-id>",
    "!new - start a new conversation in this thread",
    "!title [text] - view or change this thread's title",
    "!sources - list this channel's documents and folder resources",
    "!read <file-id> [request] - read a Slack file shared with this channel",
    "!skills - list this profile's skills",
    "!skill <name> <request>",
    "!delegate <profile> <request> - run a separate specialist session",
    "!tasks - list recent tasks in this channel",
    "!research <request> - prepare a deep research plan",
    "!stop [task-id] - stop this thread's tasks and research, or cancel one task",
    "!retry <task-id> - explicitly rerun a failed or interrupted task",
    "!redeliver <task-id> - resend a saved answer without rerunning the model",
    "!schedule every 1h [--on-change] <request>",
    "!schedule daily 09:00 Asia/Seoul [--on-change] <request>",
    "!schedule at <ISO-date-with-timezone> <request>",
    "!schedules - list schedules in this channel",
    "!schedule pause|resume|remove <schedule-id>",
].map((line) => {
    const [syntax, description] = line.split(" - ");
    return "`" + syntax + "`" + (description ? " - " + description : "");
}).join("\n");

export async function commandReply(command, context, { state, runtime, profiles, skills, titles, resources }) {
    const { name, args } = command;
    const profile = profiles[context.profile];
    if (name === "help") return helpText;
    if (name === "sources") return sourceList(await resources.catalog(context.channel, { refresh: true }));
    if (name === "title") {
        if (!args) return state.snapshot().threads[context.key]?.title || "No title set";
        const result = await titles.set(context, args);
        return result.synced ? "Title updated: " + result.title :
            "Title saved locally. Slack sync is unavailable. Check the Agent feature and app permissions.";
    }
    if (name === "profile") {
        return [`Current profile: ${context.profile}`, ...Object.entries(profiles).map(([id, item]) =>
            `${id} - ${item.name}; sandbox=${item.sandbox}; web=${item.webSearch}`)].join("\n");
    }
    if (name === "skills") {
        return profile.skills.map((id) => `${id} - ${skills[id]?.name || "Unavailable"}`).join("\n") || "No skills";
    }
    const knowledge = await knowledgeCommand(command, context, state);
    if (knowledge !== null) return knowledge;
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

export function requestedTask(prompt, profiles, route, skills) {
    const command = parseCommand(prompt);
    let requested;
    let skill;
    let fileIds;
    if (command?.name === "delegate") [requested, prompt] = splitFirst(command.args);
    else if (command?.name === "research") {
        prompt = researchText("RESEARCH_COMMAND", { request: command.args });
    }
    else if (command?.name === "skill") [skill, prompt] = splitFirst(command.args);
    else if (command?.name === "read") {
        const [id, question] = splitFirst(command.args);
        if (!isFileId(id)) throw Error("Use a file ID from !sources");
        fileIds = [id];
        prompt = question || "Summarize the requested Slack file and cite its source link.";
    }
    else if (command) throw Error("Unknown command. Use !help");
    if (!prompt.trim() || prompt.length > 16000 || prompt.startsWith("!")) throw Error("Provide a task request");
    const profile = resolveProfile(profiles, route, requested);
    resolveSkill(skills, profile, skill);
    return { prompt, profile: profile.id, skill, delegated: Boolean(requested), fileIds };
}
