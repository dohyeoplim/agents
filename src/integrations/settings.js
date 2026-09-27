import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const topic = z.object({ topic: z.string().max(300) }).passthrough();
const settingsSchema = z.object({
    owner: z.string().regex(/^[UW][A-Z0-9]+$/).optional(),
    briefing: z.object({
        channel: z.string().regex(/^[a-z0-9_-]+$/),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        timezone: z.string().refine((value) => {
            try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
        }),
        language: z.string().max(10).default("en"),
        status: z.enum(["pending_integrations", "enabled", "paused"]).default("pending_integrations"),
        weather: z.object({
            location: z.string().max(200),
            latitude: z.number().min(-90).max(90).optional(),
            longitude: z.number().min(-180).max(180).optional(),
        }).passthrough(),
    }),
    reading: z.object({
        confirmedInterests: z.array(topic).max(20).default([]),
        experienceRelatedTopics: z.array(z.string().max(300)).max(20).default([]),
        tentativeInterests: z.array(topic).max(20).default([]),
        hardExcludedResearchTopics: z.array(z.string().max(300)).max(20).default([]),
        rankingGuidance: z.array(z.string().max(500)).max(20).default([]),
        query: z.string().max(500).optional(),
    }).passthrough(),
    news: z.object({
        confirmedTopics: z.array(z.string().max(300)).max(20).default([]),
        tentativeTopics: z.array(z.string().max(300)).max(20).default([]),
    }).passthrough().optional(),
    presentation: z.object({
        prefer: z.array(z.string().max(300)).max(20), avoid: z.array(z.string().max(300)).max(20),
    }).optional(),
}).passthrough();

export async function loadPersonal(file = "/config/.private/personal.json") {
    try {
        const content = await readFile(file, "utf8");
        if (content.length > 32000) throw Error("Personal settings too large");
        return settingsSchema.parse(JSON.parse(content));
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw Error("Invalid private settings");
    }
}

export async function loadSecret(name, root = "/run/secrets") {
    if (!/^[a-z0-9.-]+$/.test(name)) throw Error("Invalid secret file name");
    try {
        const content = await readFile(path.join(root, name), "utf8");
        if (content.length > 32000) throw Error("Secret file too large");
        return JSON.parse(content);
    } catch (error) {
        if (error.code === "ENOENT") throw Error(`Provider not configured: ${name}`);
        throw Error("Invalid provider credentials");
    }
}

export async function readPrivateKey(name, root = "/run/secrets") {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_.-]+\.p8$/.test(name)) throw Error("Invalid key file");
    const base = await realpath(root);
    const file = await realpath(path.join(root, name));
    if (!file.startsWith(base + path.sep)) throw Error("Invalid key path");
    return readFile(file, "utf8");
}

export function preferenceContext(personal) {
    if (!personal) return {};
    const { reading, news, presentation } = personal;
    return { reading, news, presentation,
        rule: "Honor exclusions in private settings. Inferred interests are tentative, not exclusions." };
}
