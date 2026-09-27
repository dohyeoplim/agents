import http from "node:http";
import { confined, SerialQueue } from "./core.js";
import { loadConfig } from "./channels.js";
import { runCodex } from "./codex.js";

await loadConfig();
const agent = process.env.AGENT_ID;
const queue = new SerialQueue();

http.createServer(async (req, res) => {
    const reply = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
    };
    if (req.method === "GET" && req.url === "/health")
        return reply(200, { ok: true });
    if (req.method !== "POST" || req.url !== "/run")
        return reply(404, { error: "Not found" });
    try {
        let raw = "";
        for await (const part of req) {
            raw += part;
            if (raw.length > 20000) {
                reply(413, { error: "Too large" });
                return;
            }
        }
        const input = JSON.parse(raw);
        const config = await loadConfig();
        const route = config.channels[input.channel];
        if (
            !route ||
            route.enabled === false ||
            route.agent !== agent ||
            typeof input.prompt !== "string" ||
            input.prompt.length > 16000 ||
            (input.session && !/^[0-9a-f-]{36}$/i.test(input.session))
        )
            return reply(400, { error: "Invalid request" });
        const result = await queue.run(async () => {
            const cwd = await confined("/workspace", route.cwd);
            return runCodex({
                cwd,
                session: input.session,
                model: route.model,
                prompt: [
                    route.instructions || "Help the user with this workspace.",
                    `User request:\n${input.prompt}`,
                ].join("\n\n"),
            });
        });
        reply(200, result);
    } catch {
        reply(500, {
            error: "Worker failed. Check authentication and sandbox support.",
        });
    }
}).listen(8080, "0.0.0.0");
