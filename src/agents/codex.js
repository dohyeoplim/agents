import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";

export function codexArgs(session, model, policy = {}) {
    const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "-c",
        'approval_policy="never"',
        "-c",
        `sandbox_mode=${JSON.stringify(policy.sandbox || "workspace-write")}`,
        "-c",
        `sandbox_workspace_write.network_access=${policy.networkAccess === true}`,
        "-c",
        `web_search=${JSON.stringify(policy.webSearch || "live")}`,
        "-c",
        'shell_environment_policy.inherit="none"',
        "-c",
        'shell_environment_policy.set={PATH="/usr/local/bin:/usr/bin:/bin",HOME="/tmp"}',
    ];
    if (model) args.push("--model", model);
    if (session) args.push("resume", session);
    args.push("-");
    return args;
}

export function runCodex({
    cwd,
    prompt,
    session,
    model,
    timeout = 600000,
    executable = "codex",
    policy = {},
    signal,
}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(Error("Task cancelled"));
        const child = spawn(executable, codexArgs(session, model, policy), {
            cwd,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                PATH: process.env.PATH,
                HOME: "/home/node",
                CODEX_HOME: process.env.CODEX_HOME || "/codex",
                LANG: "C.UTF-8",
            },
        });
        const decoder = new StringDecoder("utf8");
        let buffer = "",
            bytes = 0,
            id = session,
            answer = "",
            complete = false,
            failed = false;
        const kill = () => {
            try {
                process.kill(-child.pid, "SIGKILL");
            } catch {}
        };
        const timer = setTimeout(() => {
            failed = true;
            kill();
        }, timeout);
        const abort = () => { failed = true; kill(); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.stdout.on("data", (data) => {
            bytes += data.length;
            if (bytes > 8 * 1024 * 1024) {
                failed = true;
                kill();
                return;
            }
            buffer += decoder.write(data);
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                try {
                    const e = JSON.parse(line);
                    if (e.type === "thread.started") id = e.thread_id;
                    if (
                        e.type === "item.completed" &&
                        e.item?.type === "agent_message"
                    )
                        answer = e.item.text;
                    if (e.type === "turn.completed") complete = true;
                    if (e.type === "turn.failed" || e.type === "error")
                        failed = true;
                } catch {
                    failed = true;
                }
            }
        });
        child.stderr.resume();
        child.stdin.on("error", () => {});
        child.on("error", () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(Error("Codex launch failed"));
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (
                code !== 0 ||
                failed ||
                !complete ||
                !answer ||
                !/^[0-9a-f-]{36}$/i.test(id ?? "")
            )
                reject(Error("Codex run failed"));
            else resolve({ session: id, answer });
        });
        child.stdin.end(prompt);
    });
}
