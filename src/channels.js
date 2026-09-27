import { readFile, writeFile, rename, mkdir, realpath, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./core.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const channelRoles = {
    daily: "Help review the day and plan priorities. Do not claim scheduled delivery is configured.",
    inbox: "Help with general requests and organize incoming tasks.",
    schedule: "Help plan schedules. Do not claim reminders are scheduled without an actual scheduling tool.",
    research: "Research questions carefully. Distinguish verified sources from assumptions.",
    writing: "Help draft and edit writing while preserving the user's intended meaning and voice.",
    coursework: "Help with coursework, explain concepts, and organize assignments.",
    reading: "Help analyze reading material and maintain useful reading notes with sources.",
    ideas: "Help develop ideas, examine tradeoffs, and record concrete next steps.",
    life: "Help organize personal tasks and everyday planning.",
    lab: "Help with coding and experiments. Verify changes and report actual limitations.",
    logs: "Help inspect logs and diagnose failures. Never reveal credentials.",
};

export async function loadConfig(file = "/config/routes.json") {
    return validate(JSON.parse(await readFile(file, "utf8")));
}

export function registerChannel(config, id, name) {
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) {
        throw Error("Invalid channel name");
    }
    if (!/^[CG][A-Z0-9]+$/.test(id)) throw Error("Invalid channel ID");
    if (Object.entries(config.channels).some(([key, route]) => key !== id && route.name === name)) {
        throw Error("Channel name is already registered");
    }
    const existing = config.channels[id];
    const route = existing
        ? { ...existing, name }
        : {
            name,
            enabled: true,
            agent: "assistant",
            cwd: name,
            instructions: channelRoles[name] || "Help the user with this channel's work.",
        };
    return validate({ ...config, channels: { ...config.channels, [id]: route } });
}

export function updateChannel(config, selector, patch) {
    const id = Object.keys(config.channels).find(
        (key) => key === selector || config.channels[key].name === selector,
    );
    if (!id) throw Error("Channel is not registered");
    if (Object.keys(patch).some((key) => !["enabled", "instructions"].includes(key))) {
        throw Error("Unsupported channel setting");
    }
    return validate({
        ...config,
        channels: { ...config.channels, [id]: { ...config.channels[id], ...patch } },
    });
}

export async function discoverChannels(token, team, request = fetch) {
    if (!token) throw Error("SLACK_BOT_TOKEN is missing");
    async function call(method, params = {}) {
        const response = await request(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error("Slack request failed");
        const result = await response.json();
        if (!result.ok) {
            if (result.error === "missing_scope") {
                throw Error("Add channels:read to Bot Token Scopes and reinstall the Slack app");
            }
            throw Error("Slack request was rejected");
        }
        return result;
    }
    const identity = await call("auth.test");
    if (identity.team_id !== team) throw Error("Slack workspace mismatch");
    const channels = [];
    const cursors = new Set();
    let cursor = "";
    do {
        const page = await call("conversations.list", {
            types: "public_channel",
            exclude_archived: "true",
            limit: "200",
            cursor,
        });
        if (!Array.isArray(page.channels)) throw Error("Invalid Slack channel list");
        for (const channel of page.channels) {
            if (typeof channel.id !== "string" || typeof channel.name !== "string") {
                throw Error("Invalid Slack channel");
            }
            channels.push({ id: channel.id, name: channel.name, member: channel.is_member === true });
        }
        cursor = page.response_metadata?.next_cursor || "";
        if (typeof cursor !== "string" || (cursor && cursors.has(cursor))) {
            throw Error("Invalid Slack pagination");
        }
        cursors.add(cursor);
    } while (cursor);
    return channels;
}

async function prepareDirectories(config, root) {
    const base = await realpath(root);
    for (const route of Object.values(config.channels)) {
        let current = base;
        for (const part of ["data", route.agent, "workspace", ...route.cwd.split("/")]) {
            if (part === ".") continue;
            current = path.join(current, part);
            try {
                await mkdir(current);
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
            }
            const info = await lstat(current);
            if (info.isSymbolicLink() || !info.isDirectory()) throw Error("Workspace path must be a directory");
        }
    }
}

export async function saveConfig(config, file, root) {
    validate(config);
    await prepareDirectories(config, root);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(config, null, 4) + "\n", { mode: 0o644, flag: "wx" });
        await rename(temporary, file);
    } finally {
        await unlink(temporary).catch((error) => {
            if (error.code !== "ENOENT") throw error;
        });
    }
}

async function main(args) {
    const file = path.join(project, "config/routes.json");
    const config = await loadConfig(file);
    const [command, selector, ...values] = args;
    if (command === "list") {
        console.table(Object.entries(config.channels).map(([id, route]) => ({
            id,
            name: route.name || route.cwd,
            enabled: route.enabled !== false,
            agent: route.agent,
            folder: route.cwd,
            role: route.instructions || "",
        })));
        return;
    }
    let updated;
    if (command === "add" && values.length === 1) {
        updated = registerChannel(config, selector, values[0]);
    } else if (["enable", "disable"].includes(command) && selector && !values.length) {
        updated = updateChannel(config, selector, { enabled: command === "enable" });
    } else if (command === "role" && selector && values.length) {
        updated = updateChannel(config, selector, { instructions: values.join(" ") });
    } else if (command === "discover" || command === "sync") {
        try {
            process.loadEnvFile(path.join(project, ".env"));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        const available = await discoverChannels(process.env.SLACK_BOT_TOKEN, config.team);
        if (command === "discover") {
            console.table(available);
            return;
        }
        const names = [selector, ...values].filter(Boolean).map((name) => name.replace(/^#/, ""));
        if (!names.length) throw Error("Provide channel names to sync");
        updated = config;
        for (const name of names) {
            const channel = available.find((item) => item.name === name);
            if (!channel) throw Error(`Channel not found: ${name}`);
            updated = registerChannel(updated, channel.id, channel.name);
            if (!channel.member) console.log(`Invite the bot to #${name} before chatting`);
        }
    } else {
        console.log("channels list | discover | sync <names...> | add <ID> <name>");
        console.log("channels enable <ID|name> | disable <ID|name> | role <ID|name> <instructions>");
        process.exitCode = 1;
        return;
    }
    await saveConfig(updated, file, project);
    console.log("Channel settings saved");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch((error) => {
        const message = error.message.replace(/xox[baprs]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+/g, "[REDACTED]");
        console.error(message);
        process.exitCode = 1;
    });
}
