import { validate } from "./config.js";
import { readFile } from "node:fs/promises";

export const channelRoles = JSON.parse(await readFile(
    new URL("../agents/prompts/channel-roles.json", import.meta.url), "utf8"));

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
            instructions: channelRoles[name] || channelRoles.default,
        };
    return validate({ ...config, channels: { ...config.channels, [id]: route } });
}

export function updateChannel(config, selector, patch) {
    const id = Object.keys(config.channels).find(
        (key) => key === selector || config.channels[key].name === selector,
    );
    if (!id) throw Error("Channel is not registered");
    if (Object.keys(patch).some((key) => !["enabled", "instructions", "profile"].includes(key))) {
        throw Error("Unsupported channel setting");
    }
    return validate({
        ...config,
        channels: { ...config.channels, [id]: { ...config.channels[id], ...patch } },
    });
}
