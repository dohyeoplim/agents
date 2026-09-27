import { validate } from "./config.js";

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
    if (Object.keys(patch).some((key) => !["enabled", "instructions", "profile"].includes(key))) {
        throw Error("Unsupported channel setting");
    }
    return validate({
        ...config,
        channels: { ...config.channels, [id]: { ...config.channels[id], ...patch } },
    });
}
