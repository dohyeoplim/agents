import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.js";
import { registerChannel, updateChannel } from "./registry.js";
import { discoverChannels } from "./discovery.js";
import { loadProfiles, profileFor } from "../agents/profiles.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
            profile: profileFor(route),
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
    } else if (command === "profile" && selector && values.length === 1) {
        const profiles = await loadProfiles(path.join(project, "config/profiles.json"));
        if (!Object.hasOwn(profiles, values[0])) throw Error("Unknown profile");
        updated = updateChannel(config, selector, { profile: values[0] });
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
        console.log("channels profile <ID|name> <profile>");
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
