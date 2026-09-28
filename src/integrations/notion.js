import { spawn } from "node:child_process";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { runtimeHome } from "../agents/home.js";

export const notionUrl = "https://mcp.notion.com/mcp";
export const oauthConfig = ["-c", 'mcp_oauth_credentials_store="file"'];

export async function notionEnabled(home) {
    try {
        const value = JSON.parse(await readFile(path.join(home, "notion.json"), "utf8"));
        return value?.enabled === true;
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw Error("Cannot read Notion connection settings");
    }
}

export function notionConfig(enabled) {
    return { url: notionUrl, enabled, required: false, startup_timeout_sec: 20, tool_timeout_sec: 90,
        default_tools_approval_mode: "approve" };
}

async function saveEnabled(home, enabled) {
    const target = path.join(home, "notion.json");
    const temporary = target + "." + randomUUID();
    try {
        await writeFile(temporary, JSON.stringify({ enabled }) + "\n", { mode: 0o600, flag: "wx" });
        await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
}

function runCodex(args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn("codex", args, { ...options, stdio: "inherit" });
        child.once("error", () => reject(Error("Could not start Codex. Run this command in the assistant container.")));
        child.once("exit", (code) => code === 0 ? resolve() : reject(Error("Notion authentication did not complete")));
    });
}

export async function configureNotion(command, {
    root = process.env.CODEX_HOME || path.join(process.cwd(), "data/assistant/codex"), run = runCodex,
} = {}) {
    if (!["login", "logout", "status"].includes(command)) throw Error("Unknown Notion command");
    const home = await runtimeHome(root);
    if (command === "status") {
        return { enabled: await notionEnabled(home), url: notionUrl, liveConnectionChecked: false };
    }
    await saveEnabled(home, false);
    await run([...oauthConfig, "-c", `mcp_servers.notion.url="${notionUrl}"`,
        "mcp", command, "notion", ...(command === "login" ? ["--no-browser"] : [])],
    { cwd: "/tmp", env: { ...process.env, CODEX_HOME: home } });
    if (command === "login") await saveEnabled(home, true);
    return { enabled: command === "login", url: notionUrl };
}
