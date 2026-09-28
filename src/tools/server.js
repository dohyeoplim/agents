import http from "node:http";
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { researchToolAllowed } from "../research/policy.js";

export function createToolServer({ tools, state, config, personal, healthy, now = Date.now }) {
    const grants = new Map();
    const grant = (task, signal) => {
        const token = randomBytes(32).toString("base64url");
        grants.set(token, { task, signal, until: now() + 12 * 60000, calls: 0, pending: 0 });
        return { token, revoke: () => grants.delete(token) };
    };
    const server = http.createServer(async (req, res) => {
        const reject = (status) => { res.writeHead(status); res.end(); };
        if (req.url === "/health" && req.method === "GET" && !req.headers.origin && healthy) {
            try { return reject(await healthy() ? 200 : 503); }
            catch { return reject(503); }
        }
        if (req.url !== "/mcp" || req.method !== "POST" || req.headers.origin) return reject(404);
        const token = req.headers.authorization?.replace(/^Bearer /, "");
        const access = grants.get(token);
        if (!access || access.signal?.aborted) return reject(401);
        try {
            const current = await config();
            const settings = await personal();
            const { task } = access;
            const route = current.channels[task.channel];
            if (task.team !== current.team || !current.users.includes(task.user) || !route || route.enabled === false ||
                task.user !== (settings?.owner || current.users[0]) ||
                state.snapshot().tasks[task.id]?.status !== "running") return reject(403);
            if (task.researchId) {
                const job = state.snapshot().researchJobs?.[task.researchId];
                if (!job || job.runId !== task.researchRunId || !["running", "clarifying"].includes(job.status) ||
                    ["team", "user", "channel"].some((key) => job[key] !== task[key])) return reject(403);
            }
            if (access.until <= now()) access.until = now() + 12 * 60000;
            const parts = [];
            let size = 0;
            for await (const part of req) {
                size += part.length;
                if (size > 256000) return reject(413);
                parts.push(part);
            }
            const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
            const mcp = new Server({ name: "personal-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
            mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
                tools: tools.definitions.filter((tool) => researchToolAllowed(task, tool.name)),
            }));
            mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
                if (!researchToolAllowed(task, request.params.name)) {
                    return { isError: true, content: [{ type: "text", text: "Tool unavailable in this stage" }] };
                }
                if ((!task.researchId && ++access.calls > 80) || access.pending >= 3) {
                    return { isError: true, content: [{ type: "text", text: "Tool call limit reached" }] };
                }
                access.pending++;
                try {
                    const signal = AbortSignal.any([extra.signal, ...(access.signal ? [access.signal] : []),
                        AbortSignal.timeout(90000)]);
                    const result = await tools.call(request.params.name, request.params.arguments || {}, task, signal);
                    const text = JSON.stringify(result);
                    if (text.length > 120000) throw Error("Tool output exceeds limit");
                    return { content: [{ type: "text", text }] };
                } catch (error) {
                    return { isError: true, content: [{ type: "text",
                        text: error.name === "ZodError" ? "Invalid tool arguments" :
                            String(error.message).slice(0, 250) }] };
                } finally { access.pending--; }
            });
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined, enableJsonResponse: true,
            });
            res.on("close", () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
            await mcp.connect(transport);
            await transport.handleRequest(req, res, body);
        } catch { if (!res.headersSent) reject(400); else res.end(); }
    });
    server.requestTimeout = 100000;
    return { server, grant };
}
