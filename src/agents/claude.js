import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { idleWatchdog, researchIdleTimeout } from "./rpc.js";
import { researchTools } from "../research/policy.js";
import { providerError } from "../shared/diagnostics.js";

const builtin = ["WebSearch", "WebFetch"];
const denied = ["Read", "Glob", "Grep", "Bash", "Edit", "Write", "NotebookEdit", "Agent"];

export function claudeArguments(toolToken) {
    const servers = toolToken ? { personal: { type: "http", url: "http://gateway:8081/mcp", timeout: 95000,
        headers: { Authorization: "Bearer ${PERSONAL_TOOLS_TOKEN}" } } } : {};
    return ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--restricted",
        "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true,
            permissions: { deny: denied } }),
        "--disable-slash-commands", "--no-session-persistence", "--permission-mode", "dontAsk",
        "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: servers }),
        "--tools", builtin.join(","), "--allowedTools",
        [...builtin, ...(toolToken ? researchTools.map((name) => `mcp__personal__${name}`) : [])].join(",")];
}

export function runClaude({ cwd, prompt, signal, toolToken, onActivity, executable = "claude",
    home = process.env.CLAUDE_CONFIG_DIR || "/claude", spawnProcess = spawn,
    idleTimeout = researchIdleTimeout() }) {
    if (signal?.aborted) return Promise.reject(providerError("claude", { code: "TASK_CANCELLED" }));
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
        let stderr = "";
        const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
        const finish = (error) => {
            if (settled) return;
            settled = true;
            watchdog.close();
            signal?.removeEventListener("abort", abort);
            stop();
            if (error) reject(providerError("claude", error));
            else resolve(result);
        };
        const abort = () => finish({ code: "TASK_CANCELLED" });
        const watchdog = idleWatchdog(idleTimeout, () => finish(Object.assign(
            Error("Claude produced no execution events within the inactivity limit"), { code: "RESEARCH_STALLED" },
        )));
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (data) => {
            buffer += decoder.write(data);
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
                if (newline > 4 * 1024 * 1024) return finish({ code: "PROVIDER_PROTOCOL" });
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
                    if (event.is_error || event.subtype !== "success") {
                        return finish(providerError("claude", [event.result, ...(Array.isArray(event.errors) ?
                            event.errors.filter((value) => typeof value === "string") : [])].join("\n")));
                    }
                    if (typeof event.result !== "string" ||
                        !event.result.trim() || event.result.length > 200000 ||
                        !/^[0-9a-f-]{36}$/i.test(event.session_id || "")) {
                        return finish({ code: "PROVIDER_PROTOCOL" });
                    }
                    result = { session: event.session_id, answer: event.result };
                } catch { return finish({ code: "PROVIDER_PROTOCOL" }); }
            }
            if (buffer.length > 4 * 1024 * 1024) finish({ code: "PROVIDER_PROTOCOL" });
        });
        child.stderr.on("data", (data) => { stderr = (stderr + data.toString("utf8")).slice(-16384); });
        child.stdin.on("error", (error) => finish(providerError("claude", stderr || error)));
        child.on("error", (error) => finish(providerError("claude", error, "PROVIDER_START_FAILED")));
        child.on("close", (code) => finish(code !== 0 || !result || Boolean(buffer.trim()) ?
            providerError("claude", stderr, code === 0 ? "PROVIDER_PROTOCOL" : "PROVIDER_FAILED") : undefined));
        child.stdin.end(prompt);
        if (signal?.aborted) abort();
    });
}
