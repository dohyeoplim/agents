import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRemoteConfig } from "./config.js";
import { createSshTransport } from "./ssh.js";

const execute = promisify(execFile);
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    host: { type: "string" }, port: { type: "string", default: "2222" },
    user: { type: "string", default: "agent" }, key: { type: "string" },
    "known-hosts": { type: "string" },
} });

try {
    if (positionals[0] === "setup") {
        if (!values.host) throw Error("Use npm run remote -- setup --host HOST [--key PATH] [--known-hosts PATH]");
        const key = resolve(values.key ?? `${homedir()}/.ssh/gpu_agent`);
        const knownHosts = resolve(values["known-hosts"] ?? `${homedir()}/.ssh/known_hosts`);
        const connection = loadRemoteConfig({ REMOTE_HOST: values.host, REMOTE_PORT: values.port,
            REMOTE_USER: values.user, REMOTE_IDENTITY_FILE: key, REMOTE_KNOWN_HOSTS_FILE: knownHosts });
        const target = connection.port === 22 ? connection.host : `[${connection.host}]:${connection.port}`;
        let trusted;
        try {
            await execute("ssh-keygen", ["-y", "-P", "", "-f", key], { timeout: 5000 });
            const found = await execute("ssh-keygen", ["-F", target, "-f", knownHosts], { timeout: 5000 });
            trusted = found.stdout.split("\n").filter((line) => line && !line.startsWith("#")).join("\n");
            if (!trusted) throw Error();
        } catch { throw Error("Use an unencrypted dedicated key and an already verified known_hosts entry."); }
        await mkdir("data/secrets", { recursive: true });
        await writeFile("data/secrets/gpu_agent", await readFile(key), { mode: 0o600 });
        await chmod("data/secrets/gpu_agent", 0o600);
        await writeFile("data/secrets/gpu_known_hosts", `${trusted}\n`, { mode: 0o600 });
        await chmod("data/secrets/gpu_known_hosts", 0o600);
        let environment = await readFile(".env", "utf8").catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return "";
        });
        for (const [name, value] of Object.entries({ REMOTE_HOST: connection.host,
            REMOTE_PORT: String(connection.port), REMOTE_USER: connection.user })) {
            const pattern = new RegExp(`^(?:export\\s+)?${name}=.*$`, "gm");
            environment = environment.replace(pattern, "").replace(/\n*$/, "\n") + `${name}=${value}\n`;
        }
        await writeFile(".env", environment, { mode: 0o600 });
        console.log("Remote connection saved. Credentials stay in ignored data/secrets. Run npm run remote -- check.");
    } else if (positionals[0] === "check") {
        const connection = loadRemoteConfig({ ...process.env,
            REMOTE_IDENTITY_FILE: resolve("data/secrets/gpu_agent"),
            REMOTE_KNOWN_HOSTS_FILE: resolve("data/secrets/gpu_known_hosts") });
        if (!connection) throw Error("Remote workspace is not configured");
        const result = await createSshTransport(connection).request({ operation: "status", args: {},
            namespace: "0".repeat(64) });
        if (!result.ok) throw Error("Remote workspace check failed");
        console.log(JSON.stringify(result.result));
    } else throw Error("Use npm run remote -- setup or npm run remote -- check");
} catch (error) {
    console.error(error.name === "ZodError" ? "Invalid remote settings" : error.message);
    process.exitCode = 1;
}
