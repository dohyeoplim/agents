import { isIP } from "node:net";
import { z } from "zod";

const absolutePath = z.string().min(1).max(4096).startsWith("/").regex(/^[^\u0000-\u001f\u007f]+$/);
const hostname = z.string().min(1).max(253).refine((value) => {
    if (isIP(value) === 4) return true;
    if (/^[\d.]+$/.test(value)) return false;
    return value.split(".").every((label) =>
        /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}, "Invalid remote host");
const config = z.object({
    host: hostname,
    port: z.coerce.number().int().min(1).max(65535),
    user: z.string().min(1).max(64).regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/),
    identityFile: absolutePath,
    knownHostsFile: absolutePath,
}).strict();

export function loadRemoteConfig(env = process.env) {
    if (env.REMOTE_HOST === undefined || env.REMOTE_HOST === "") return null;
    return config.parse({
        host: env.REMOTE_HOST,
        port: env.REMOTE_PORT ?? 2222,
        user: env.REMOTE_USER ?? "agent",
        identityFile: env.REMOTE_IDENTITY_FILE ?? "/run/secrets/gpu_agent",
        knownHostsFile: env.REMOTE_KNOWN_HOSTS_FILE ?? "/run/secrets/gpu_known_hosts",
    });
}
