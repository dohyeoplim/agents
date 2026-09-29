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
import { runClaude } from "./claude.js";
import { researchStages, campaignStages } from "../research/policy.js";
import { failureCode, failureMessage, logFailure } from "../shared/diagnostics.js";
import { logEvent } from "../shared/events.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createWorker({
    config = loadConfig, profiles = loadProfiles, skills = loadSkills, run = runAppServer,
    workspace = "/workspace", agent = process.env.AGENT_ID, claude = runClaude, logger = console.error,
} = {}) {
    const sessions = new Map();
    const jobs = new Map();
    let researchJobs = 0;
    return http.createServer(async (req, res) => {
        let context = { component: "worker" };
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
            const research = input.researchId !== undefined;
            const campaign = input.autoresearchId !== undefined;
            if ((campaign && (!research || input.autoresearchId !== input.researchId ||
                !campaignStages.includes(input.researchStage))) ||
                (!campaign && campaignStages.includes(input.researchStage))) {
                return reply(400, { error: "Invalid campaign request" });
            }
            if ((research && (typeof input.researchId !== "string" || !uuid.test(input.researchId) ||
                (input.researchRunId !== undefined &&
                    (typeof input.researchRunId !== "string" || !uuid.test(input.researchRunId))) ||
                !(campaign ? campaignStages : researchStages).includes(input.researchStage) ||
                input.session !== undefined ||
                ![undefined, "codex", "claude"].includes(input.provider))) ||
                (!research && (input.researchStage !== undefined || input.provider !== undefined ||
                    input.researchRunId !== undefined))) {
                return reply(400, { error: "Invalid research request" });
            }
            if (!route || route.enabled === false || route.agent !== agent ||
                typeof input.prompt !== "string" || !input.prompt.trim() ||
                input.prompt.length > (research ? 64000 : 16000) ||
                (input.profile !== undefined && typeof input.profile !== "string") ||
                (input.skill !== undefined && typeof input.skill !== "string") ||
                (input.notionAccess !== undefined && typeof input.notionAccess !== "boolean") ||
                (input.toolToken !== undefined &&
                    (typeof input.toolToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.toolToken))) ||
                (input.session && (typeof input.session !== "string" || !/^[0-9a-f-]{36}$/i.test(input.session))) ||
                (input.context !== undefined && (typeof input.context !== "string" || input.context.length > 20000)) ||
                (input.sourceContext !== undefined &&
                    (typeof input.sourceContext !== "string" || input.sourceContext.length > 20000)) ||
                (input.historyContext !== undefined &&
                    (typeof input.historyContext !== "string" || input.historyContext.length > 12000)) ||
                (input.id !== undefined && (typeof input.id !== "string" || !/^[0-9a-f-]{36}$/i.test(input.id)))) {
                return reply(400, { error: "Invalid request" });
            }
            const id = input.id || randomUUID();
            context = { ...context, taskId: id, provider: input.provider || "codex", stage: input.researchStage };
            if (jobs.has(id)) return reply(409, { error: "Task already running" });
            if (research && researchJobs >= 4) return reply(429, { error: "Research capacity reached" });
            if (!research && jobs.size - researchJobs >= 32) return reply(429, { error: "Task capacity reached" });
            if (research) researchJobs++;
            const controller = new AbortController();
            jobs.set(id, controller);
            const startedAt = Date.now();
            logEvent("task_started", context);
            res.on("close", () => {
                if (!res.writableEnded) controller.abort();
            });
            let heartbeat;
            let providerEvents = 0;
            let lastActivityAt;
            let sentEvents = 0;
            const progress = () => {
                if (!research || !res.headersSent || res.destroyed || res.writableEnded ||
                    providerEvents === sentEvents) return;
                res.write(JSON.stringify({ type: "progress", providerEvents, lastActivityAt }) + "\n");
                sentEvents = providerEvents;
            };
            try {
                const perform = async () => {
                    if (controller.signal.aborted) throw Object.assign(Error(), { code: "TASK_CANCELLED" });
                    const current = (await config()).channels[input.channel];
                    if (!current || current.enabled === false || current.agent !== agent) {
                        throw Error("Channel disabled");
                    }
                    const channelCwd = await confined(workspace, current.cwd, true);
                    const cwd = research ? await confined(channelCwd,
                        `.research/${input.researchId}/${input.researchStage}/${id}`, true) : channelCwd;
                    const profile = resolveProfile(await profiles(), current, input.profile);
                    const skill = resolveSkill(await skills(), profile, input.skill);
                    if (input.stream === true || research) {
                        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
                        res.flushHeaders();
                        if (research) heartbeat = setInterval(() => {
                            if (!res.destroyed) res.write(JSON.stringify({ type: "heartbeat" }) + "\n");
                            progress();
                        }, 15000);
                    }
                    let streamed = "";
                    const provider = input.provider === "claude" ? claude : run;
                    return provider({
                        cwd,
                        session: input.session,
                        model: current.model || profile.model,
                        policy: input.researchStage === "clarify" ? { ...profile, webSearch: "disabled" } : profile,
                        timeout: research ? null : profile.timeoutSeconds * 1000,
                        signal: controller.signal,
                        images: input.images || [],
                        toolToken: input.toolToken,
                        notionAccess: input.notionAccess === true,
                        research,
                        onActivity: research ? () => {
                            providerEvents++;
                            lastActivityAt = Date.now();
                            if (providerEvents === 1) progress();
                        } : undefined,
                        onText: input.stream === true && !research ? (text) => {
                            if (text.startsWith(streamed) && text.length - streamed.length < 128) return;
                            streamed = text;
                            if (!res.destroyed) res.write(JSON.stringify({ type: "text", text }) + "\n");
                        } : undefined,
                        prompt: buildPrompt({ profile, route: current, skill, input }),
                    });
                };
                const session = !research && input.session;
                let queue;
                if (session) {
                    queue = sessions.get(session) || new SerialQueue();
                    sessions.set(session, queue);
                }
                const result = await (queue ? queue.run(perform) : perform());
                logEvent("task_completed", { ...context, durationMs: Date.now() - startedAt });
                progress();
                reply(200, result);
            } catch (error) {
                if (controller.signal.aborted) throw Object.assign(Error(), { code: "TASK_CANCELLED" });
                throw error;
            } finally {
                clearInterval(heartbeat);
                progress();
                if (research) researchJobs--;
                jobs.delete(id);
                for (const [session, queue] of sessions) {
                    void queue.tail.then(() => {
                        if (!queue.pending && sessions.get(session) === queue) sessions.delete(session);
                    });
                }
            }
        } catch (error) {
            const code = failureCode(error);
            logFailure(error, context, logger);
            reply(500, { code, error: failureMessage(code) });
        }
    });
}
