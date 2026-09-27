import { addEntry, forgetEntry, searchEntries, visibleEntries } from "./knowledge.js";
import { resolveSkill } from "./skills.js";
import { resolveProfile } from "./profiles.js";

export const helpText = [
    "!profile - show agent profiles and the current profile",
    "!remember <shared|profile|channel> <text>",
    "!memories - list saved preferences",
    "!note <shared|profile|channel> <title> | <text>",
    "!search <words> - search accessible notes and memories",
    "!forget <entry-id>",
    "!new - start a new conversation in this thread",
    "!skills - list this profile's skills",
    "!skill <name> <request>",
    "!delegate <profile> <request> - run a separate specialist session",
    "!tasks - list recent tasks in this channel",
    "!stop [task-id] - cancel a queued or running task",
    "!retry <task-id> - explicitly rerun a failed or interrupted task",
    "!redeliver <task-id> - resend a saved answer without rerunning the model",
    "!schedule every 1h [--on-change] <request>",
    "!schedule daily 09:00 Asia/Seoul [--on-change] <request>",
    "!schedule at <ISO-date-with-timezone> <request>",
    "!schedules - list schedules in this channel",
    "!schedule pause|resume|remove <schedule-id>",
].join("\n");

export function parseCommand(prompt) {
    if (!prompt.startsWith("!")) return null;
    const match = /^!([a-z]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
    if (!match) throw Error("Invalid command. Use !help");
    return { name: match[1], args: (match[2] || "").trim() };
}

export function splitFirst(text) {
    const index = text.search(/\s/);
    return index < 0 ? [text, ""] : [text.slice(0, index), text.slice(index).trim()];
}

export async function knowledgeCommand(command, context, store, profiles, skills) {
    const { name, args } = command;
    const profile = profiles[context.profile];
    if (name === "help") return helpText;
    if (name === "profile") {
        return [`Current profile: ${context.profile}`, ...Object.entries(profiles).map(([id, item]) =>
            `${id} - ${item.name}; sandbox=${item.sandbox}; web=${item.webSearch}`)].join("\n");
    }
    if (name === "skills") {
        return profile.skills.map((id) => `${id} - ${skills[id]?.name || "Unavailable"}`).join("\n") || "No skills";
    }
    if (name === "remember" || name === "note") {
        const [scope, body] = splitFirst(args);
        let title = "";
        let text = body;
        if (name === "note") {
            const separator = body.indexOf("|");
            if (separator < 1) throw Error("Use !note <scope> <title> | <text>");
            title = body.slice(0, separator).trim();
            text = body.slice(separator + 1).trim();
        }
        const id = await store.update((data) => addEntry(data, context, {
            kind: name === "note" ? "note" : "memory", scope, title, text,
        }));
        return `Saved ${name === "note" ? "note" : "memory"}: ${id}`;
    }
    if (name === "forget") {
        await store.update((data) => forgetEntry(data, context, args));
        return "Entry removed from saved memory. Existing conversations may still contain it.";
    }
    if (name === "memories" || name === "search") {
        const entries = name === "memories"
            ? visibleEntries(store.snapshot(), context).filter((entry) => entry.kind === "memory")
            : searchEntries(store.snapshot(), context, args, 10);
        return entries.map((entry) => `${entry.id} [${entry.scope}] ${entry.title}\n${entry.text}`).join("\n\n") ||
            "No matching entries";
    }
    return null;
}

export function requestedTask(prompt, profiles, route, skills) {
    const command = parseCommand(prompt);
    let requested;
    let skill;
    if (command?.name === "delegate") [requested, prompt] = splitFirst(command.args);
    else if (command?.name === "skill") [skill, prompt] = splitFirst(command.args);
    else if (command) throw Error("Unknown command. Use !help");
    if (!prompt.trim() || prompt.length > 16000 || prompt.startsWith("!")) throw Error("Provide a task request");
    const profile = resolveProfile(profiles, route, requested);
    resolveSkill(skills, profile, skill);
    return { prompt, profile: profile.id, skill, delegated: Boolean(requested) };
}
