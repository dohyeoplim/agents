import http from "node:http";
import { randomUUID } from "node:crypto";
import { confined } from "../shared/paths.js";
import { SerialQueue } from "../shared/queue.js";
import { loadConfig } from "../channels/config.js";
import { runAppServer } from "./app-server.js";
import { validateImages } from "../resources/images.js";
import { loadProfiles, resolveProfile } from "./profiles.js";
import { loadSkills, resolveSkill } from "./skills.js";
import { buildPrompt } from "./prompt.js";

export function createWorker({
    config = loadConfig, profiles = loadProfiles, skills = loadSkills, run = runAppServer,
    workspace = "/workspace", agent = process.env.AGENT_ID,
} = {}) {
    const queue = new SerialQueue();
    const jobs = new Map();
    return http.createServer(async (req, res) => {
        const reply = (status, data) => {
            if (res.destroyed) return;
            if (res.headersSent) {
                res.end(JSON.stringify({ type: status === 200 ? "result" : "error", ...data }) + "\n");
                return;
            }
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
        };
        if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true });
        if (req.method !== "POST" || !["/run", "/cancel"].includes(req.url)) {
            return reply(404, { error: "Not found" });
        }
        try {
            const parts = [];
            let size = 0;
            for await (const part of req) {
                size += part.length;
                if (size > 29 * 1024 * 1024) return reply(413, { error: "Too large" });
                parts.push(part);
            }
            const input = JSON.parse(Buffer.concat(parts).toString("utf8"));
            if (!input || typeof input !== "object" || Array.isArray(input)) {
                return reply(400, { error: "Invalid request" });
            }
            try { validateImages(input.images); }
            catch { return reply(400, { error: "Invalid images" }); }
            if (req.url === "/cancel") {
                const controller = jobs.get(input.id);
                controller?.abort();
                return reply(200, { cancelled: Boolean(controller) });
            }
            const route = (await config()).channels[input.channel];
            if (!route || route.enabled === false || route.agent !== agent ||
                typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 16000 ||
                (input.profile !== undefined && typeof input.profile !== "string") ||
                (input.skill !== undefined && typeof input.skill !== "string") ||
                (input.toolToken !== undefined &&
                    (typeof input.toolToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.toolToken))) ||
                (input.session && (typeof input.session !== "string" || !/^[0-9a-f-]{36}$/i.test(input.session))) ||
                (input.context !== undefined && (typeof input.context !== "string" || input.context.length > 20000)) ||
                (input.sourceContext !== undefined &&
                    (typeof input.sourceContext !== "string" || input.sourceContext.length > 20000)) ||
                (input.id !== undefined && (typeof input.id !== "string" || !/^[0-9a-f-]{36}$/i.test(input.id)))) {
                return reply(400, { error: "Invalid request" });
            }
            const id = input.id || randomUUID();
            if (jobs.has(id)) return reply(409, { error: "Task already running" });
            const controller = new AbortController();
            jobs.set(id, controller);
            res.on("close", () => {
                if (!res.writableEnded) controller.abort();
            });
            try {
                const result = await queue.run(async () => {
                    if (controller.signal.aborted) throw Error("Task cancelled");
                    const current = (await config()).channels[input.channel];
                    if (!current || current.enabled === false || current.agent !== agent) {
                        throw Error("Channel disabled");
                    }
                    const cwd = await confined(workspace, current.cwd, true);
                    const profile = resolveProfile(await profiles(), current, input.profile);
                    const skill = resolveSkill(await skills(), profile, input.skill);
                    if (input.stream === true) {
                        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
                        res.flushHeaders();
                    }
                    let streamed = "";
                    return run({
                        cwd,
                        session: input.session,
                        model: current.model || profile.model,
                        policy: profile,
                        timeout: profile.timeoutSeconds * 1000,
                        signal: controller.signal,
                        images: input.images || [],
                        toolToken: input.toolToken,
                        onText: input.stream === true ? (text) => {
                            if (text.startsWith(streamed) && text.length - streamed.length < 128) return;
                            streamed = text;
                            if (!res.destroyed) res.write(JSON.stringify({ type: "text", text }) + "\n");
                        } : undefined,
                        prompt: buildPrompt({ profile, route: current, skill, input }),
                    });
                });
                reply(200, result);
            } finally {
                jobs.delete(id);
            }
        } catch {
            reply(500, { error: "Worker failed. Check authentication and sandbox support." });
        }
    });
}
