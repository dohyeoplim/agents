import { createHash } from "node:crypto";
import { z } from "zod";
import { loadRemoteConfig } from "./config.js";
import { createSshTransport } from "./ssh.js";

const response = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), result: z.record(z.string(), z.unknown()) }).strict(),
    z.object({ ok: z.literal(false), error: z.string().regex(/^REMOTE_[A-Z_]+$/).max(80) }).strict(),
]);
const operations = new Set(["status", "exec", "jobs", "job", "cancel", "read", "write"]);

export function createRemoteWorkspace({ config, personal, connection = loadRemoteConfig(),
    transport = connection ? createSshTransport(connection) : null }) {
    return { async run(operation, args, context, signal) {
        const current = await config();
        const settings = await personal();
        const route = current.channels[context.channel];
        if (context.team !== current.team || !current.users.includes(context.user) ||
            context.user !== (settings?.owner || current.users[0]) || !route || route.enabled === false ||
            context.researchId || context.scheduleId || context.briefingDate) {
            throw Error("Remote workspace access denied");
        }
        if (!operations.has(operation)) throw Error("Unknown remote operation");
        signal?.throwIfAborted();
        if (!transport) {
            if (operation === "status") return { configured: false, connected: false };
            throw Error("Remote workspace is not configured");
        }
        const namespace = createHash("sha256").update(JSON.stringify([context.team, context.user])).digest("hex");
        const raw = await transport.request({ operation, args, namespace }, signal);
        const parsed = response.safeParse(raw);
        if (!parsed.success) throw Error("Invalid remote response. Inspect job state before retrying mutations.");
        if (!parsed.data.ok) throw Error(parsed.data.error);
        return operation === "status" ? { ...parsed.data.result, configured: true } : parsed.data.result;
    } };
}
