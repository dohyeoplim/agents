import { createHash } from "node:crypto";
import { z } from "zod";
import { loadRemoteConfig } from "./config.js";
import { createSshTransport } from "./ssh.js";
import { logEvent } from "../shared/events.js";

const response = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), result: z.record(z.string(), z.unknown()) }).strict(),
    z.object({ ok: z.literal(false), error: z.string().regex(/^REMOTE_[A-Z_]+$/).max(80) }).strict(),
]);
const operations = new Set(["status", "exec", "jobs", "job", "cancel", "read", "write"]);

export function createRemoteWorkspace({ config, personal, connection = loadRemoteConfig(),
    transport = connection ? createSshTransport(connection) : null }) {
    let checked;
    const finished = new Set();
    const describe = () => ({ configured: Boolean(transport), connected: checked?.connected ?? null,
        ...(checked ? { checkedAt: checked.at } : {}) });
    return { describe, async run(operation, args, context, signal) {
        const current = await config();
        const settings = await personal();
        const route = current.channels[context.channel];
        if (context.team !== current.team || !current.users.includes(context.user) ||
            context.user !== (settings?.owner || current.users[0]) || !route || route.enabled === false ||
            (context.researchId && !(context.autoresearchId === context.researchId &&
                ["status", "jobs", "job", "read"].includes(operation))) || context.scheduleId || context.briefingDate) {
            throw Error("Remote workspace access denied");
        }
        if (!operations.has(operation)) throw Error("Unknown remote operation");
        signal?.throwIfAborted();
        if (!transport) {
            if (operation === "status") return { configured: false, connected: false };
            throw Error("Remote workspace is not configured");
        }
        const namespace = createHash("sha256").update(JSON.stringify([context.team, context.user])).digest("hex");
        let raw;
        try { raw = await transport.request({ operation, args, namespace }, signal); }
        catch (error) {
            if (operation === "status") checked = { connected: false, at: Date.now() };
            logEvent("remote_failed", { component: "remote", jobId: args.id, code: error.code });
            throw error;
        }
        const parsed = response.safeParse(raw);
        if (!parsed.success) throw Error("Invalid remote response. Inspect job state before retrying mutations.");
        if (!parsed.data.ok) {
            logEvent("remote_failed", { component: "remote", jobId: args.id, code: parsed.data.error });
            throw Error(parsed.data.error);
        }
        if (operation === "status") checked = { connected: parsed.data.result.connected === true, at: Date.now() };
        if (operation === "exec") logEvent("remote_submitted", { component: "remote", jobId: args.id,
            status: parsed.data.result.status });
        if (operation === "cancel") logEvent("remote_cancel_requested", { component: "remote", jobId: args.id,
            status: parsed.data.result.status });
        if (operation === "status") logEvent("remote_checked", { component: "remote",
            status: checked.connected ? "connected" : "disconnected" });
        if (operation === "job" && !["starting", "running"].includes(parsed.data.result.status) &&
            !finished.has(args.id)) {
            logEvent("remote_finished", { component: "remote", jobId: args.id,
                status: parsed.data.result.status, exitCode: parsed.data.result.exitCode });
            finished.add(args.id);
            if (finished.size > 256) finished.delete(finished.values().next().value);
        }
        return operation === "status" ? { ...parsed.data.result, configured: true } : parsed.data.result;
    } };
}
