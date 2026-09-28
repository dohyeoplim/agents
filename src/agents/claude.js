import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { idleWatchdog, researchIdleTimeout } from "./rpc.js";
import { researchTools } from "../research/policy.js";

const builtin = ["WebSearch", "WebFetch", "Read", "Glob", "Grep"];

export function claudeArguments(toolToken) {
    const servers = toolToken ? { personal: { type: "http", url: "http://gateway:8081/mcp", timeout: 95000,
        headers: { Authorization: "Bearer ${PERSONAL_TOOLS_TOKEN}" } } } : {};
    return ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--restricted",
        "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true }),
        "--disable-slash-commands", "--no-session-persistence", "--permission-mode", "dontAsk",
        "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: servers }),
        "--tools", builtin.join(","), "--allowedTools",
        [...builtin, ...(toolToken ? researchTools.map((name) => `mcp__personal__${name}`) : [])].join(",")];
}

export function runClaude({ cwd, prompt, signal, toolToken, onActivity, executable = "claude",
    home = process.env.CLAUDE_CONFIG_DIR || "/claude", spawnProcess = spawn,
    idleTimeout = researchIdleTimeout() }) {
    if (signal?.aborted) return Promise.reject(Error("Task cancelled"));
    return new Promise((resolve, reject) => {
        const child = spawnProcess(executable, claudeArguments(toolToken), {
            cwd, detached: true, stdio: ["pipe", "pipe", "pipe"],
            env: { PATH: process.env.PATH, HOME: "/home/node", LANG: "C.UTF-8", CLAUDE_CONFIG_DIR: home,
                ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
                ...(toolToken ? { PERSONAL_TOOLS_TOKEN: toolToken } : {}) },
        });
        const decoder = new StringDecoder("utf8");
        let buffer = "";
        let result;
        let settled = false;
        const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
        const finish = (error) => {
            if (settled) return;
            settled = true;
            watchdog.close();
            signal?.removeEventListener("abort", abort);
            stop();
            if (error?.code === "RESEARCH_STALLED") reject(error);
            else if (error) reject(Object.assign(Error("Claude run failed"), { code: "CLAUDE_FAILED" }));
            else resolve(result);
        };
        const abort = () => finish(true);
        const watchdog = idleWatchdog(idleTimeout, () => finish(Object.assign(
            Error("Claude produced no execution events within the inactivity limit"), { code: "RESEARCH_STALLED" },
        )));
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (data) => {
            buffer += decoder.write(data);
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
                if (newline > 4 * 1024 * 1024) return finish(true);
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);
                    const activity = ["system", "assistant", "user", "stream_event", "tool_progress", "result"];
                    if (activity.includes(event.type)) {
                        watchdog.touch();
                        onActivity?.();
                    }
                    if (event.type !== "result") continue;
                    if (event.is_error || event.subtype !== "success" || typeof event.result !== "string" ||
                        !event.result.trim() || event.result.length > 200000 ||
                        !/^[0-9a-f-]{36}$/i.test(event.session_id || "")) return finish(true);
                    result = { session: event.session_id, answer: event.result };
                } catch { return finish(true); }
            }
            if (buffer.length > 4 * 1024 * 1024) finish(true);
        });
        child.stderr.resume();
        child.stdin.on("error", () => finish(true));
        child.on("error", () => finish(true));
        child.on("close", (code) => finish(code !== 0 || !result || Boolean(buffer.trim())));
        child.stdin.end(prompt);
        if (signal?.aborted) abort();
    });
}
