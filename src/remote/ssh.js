import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";

const path = z.string().startsWith("/").max(4096).regex(/^[^\x00-\x1f\x7f]+$/);
const settings = z.strictObject({
    host: z.string().max(253).regex(/^[a-z0-9][a-z0-9.:-]*$/i),
    port: z.number().int().min(1).max(65535),
    user: z.string().max(64).regex(/^[a-z_][a-z0-9_-]*$/i),
    identityFile: path,
    knownHostsFile: path,
});
const messages = {
    REMOTE_CONNECT: "Remote connection failed",
    REMOTE_PROTOCOL: "Remote response was invalid",
    REMOTE_TIMEOUT: "Remote request timed out",
    REMOTE_OUTPUT: "Remote response exceeded the size limit",
    TASK_CANCELLED: "Remote request was cancelled",
};

function failure(code) {
    return Object.assign(Error(`${messages[code]}. Remote execution may have occurred; do not retry automatically.`),
        { code, uncertain: true });
}

export function createSshTransport(config, { spawnImpl = spawn } = {}) {
    const parsed = settings.safeParse(config);
    if (!parsed.success) throw Object.assign(Error("Invalid remote connection settings"), { code: "REMOTE_CONFIG" });
    const { host, port, user, identityFile, knownHostsFile } = parsed.data;
    const knownHosts = knownHostsFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const args = ["-F", "/dev/null", "-T", "-p", String(port), "-l", user, "-i", identityFile,
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile="${knownHosts}"`, "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", "-o", "ClearAllForwardings=yes",
        "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ControlMaster=no", "-o", "ControlPath=none",
        "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "UpdateHostKeys=no", host];

    return { async request(payload, signal) {
        if (signal?.aborted) throw failure("TASK_CANCELLED");
        let input;
        let command;
        try {
            input = JSON.stringify(payload);
            if (!input || Buffer.byteLength(input) > 256000) throw Error();
            const source = readFileSync(new URL("./bridge.py", import.meta.url), "utf8");
            command = `python3 -c '${source.replaceAll("'", "'\\''")}'`;
        } catch { throw failure("REMOTE_PROTOCOL"); }
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawnImpl("ssh", [...args, command], {
                    stdio: ["pipe", "pipe", "pipe"],
                    env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
                });
            } catch { reject(failure("REMOTE_CONNECT")); return; }
            let settled = false;
            let size = 0;
            const output = [];
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                if (error) {
                    try { child.kill("SIGKILL"); } catch {}
                    reject(error);
                } else resolve(result);
            };
            const abort = () => finish(failure("TASK_CANCELLED"));
            const timer = setTimeout(() => finish(failure("REMOTE_TIMEOUT")), 45000);
            signal?.addEventListener("abort", abort, { once: true });
            child.stdout.on("data", (chunk) => {
                if (settled) return;
                const data = Buffer.from(chunk);
                size += data.length;
                if (size > 128 * 1024) return finish(failure("REMOTE_OUTPUT"));
                output.push(data);
            });
            child.stderr.resume();
            child.stdin.on("error", () => finish(failure("REMOTE_CONNECT")));
            child.on("error", () => finish(failure("REMOTE_CONNECT")));
            child.on("close", (code) => {
                if (settled) return;
                if (code !== 0) return finish(failure("REMOTE_CONNECT"));
                try {
                    const result = JSON.parse(Buffer.concat(output).toString("utf8"));
                    if (!result || typeof result !== "object" || Array.isArray(result)) throw Error();
                    finish(undefined, result);
                } catch { finish(failure("REMOTE_PROTOCOL")); }
            });
            if (signal?.aborted) abort();
            if (!settled) {
                try { child.stdin.end(input); } catch { finish(failure("REMOTE_CONNECT")); }
            }
        });
    } };
}
