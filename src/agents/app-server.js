import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { startRpc } from "./rpc.js";

async function runtimeHome(root) {
    const home = path.join(root, "bridge-runtime");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(path.join(root, "sessions"), { recursive: true, mode: 0o700 });
    for (const name of ["auth.json", "sessions"]) {
        try { await symlink(path.join(root, name), path.join(home, name)); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    return home;
}

export function threadOptions(cwd, model, policy = {}) {
    return {
        cwd, ...(model ? { model } : {}), approvalPolicy: "never",
        sandbox: policy.sandbox === "read-only" ? "read-only" : "workspace-write",
        config: {
            web_search: policy.webSearch || "live",
            "sandbox_workspace_write.network_access": policy.networkAccess === true,
            "shell_environment_policy.inherit": "none",
            "shell_environment_policy.set": { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" },
            [`projects.${JSON.stringify(cwd)}.trust_level`]: "untrusted",
        },
    };
}

export async function runAppServer({
    cwd, prompt, session, model, policy = {}, images = [], onText = () => {}, signal,
    timeout = 600000, executable = "codex", home = process.env.CODEX_HOME || "/codex", toolToken,
}) {
    if (signal?.aborted) throw Error("Task cancelled");
    let threadId;
    let answer = "";
    let finalItem;
    let resolveTurn;
    let rejectTurn;
    const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    completed.catch(() => {});
    const rpc = startRpc({
        executable, args: ["app-server", "--stdio"], cwd: "/tmp", timeout, signal,
        env: { PATH: process.env.PATH, HOME: "/home/node", LANG: "C.UTF-8", CODEX_HOME: await runtimeHome(home),
            ...(toolToken ? { PERSONAL_TOOLS_TOKEN: toolToken } : {}) },
        notify: ({ method, params }) => {
            if (params?.threadId !== threadId) return;
            if (method === "item/started" && params.item?.type === "agentMessage" &&
                params.item.phase === "final_answer") {
                finalItem = params.item.id;
                answer = "";
            }
            if (method === "item/agentMessage/delta" && params.itemId === finalItem &&
                typeof params.delta === "string") {
                answer += params.delta;
                if (answer.length > 200000) throw Error("Response too large");
                onText(answer.slice(0, 28000));
            }
            if (method === "item/completed" && params.item?.type === "agentMessage" &&
                params.item.phase !== "commentary") {
                answer = params.item.text;
                onText(answer.slice(0, 28000));
            }
            if (method === "turn/completed") {
                if (params.turn?.status === "completed" && answer) resolveTurn({ session: threadId, answer });
                else rejectTurn(Error("Codex run failed"));
            }
        },
    });
    try {
        return await Promise.race([rpc.failure, (async () => {
            await rpc.call("initialize", { clientInfo: { name: "slack_agents", version: "0.1.0" } });
            rpc.notify("initialized", {});
            const options = threadOptions(cwd, model, policy);
            options.config["mcp_servers.personal"] = toolToken ? {
                url: "http://gateway:8081/mcp", bearer_token_env_var: "PERSONAL_TOOLS_TOKEN",
                startup_timeout_sec: 15, tool_timeout_sec: 95, required: true,
                default_tools_approval_mode: "approve",
            } : { url: "http://gateway:8081/mcp", enabled: false };
            const result = await rpc.call(session ? "thread/resume" : "thread/start", {
                ...options, ...(session ? { threadId: session, excludeTurns: true } : {}),
            });
            threadId = result.thread?.id;
            if (!/^[0-9a-f-]{36}$/i.test(threadId || "")) throw Error("Invalid Codex session");
            await rpc.call("turn/start", {
                threadId, approvalPolicy: "never", cwd,
                sandboxPolicy: { type: options.sandbox === "read-only" ? "readOnly" : "workspaceWrite",
                    networkAccess: policy.networkAccess === true,
                    ...(options.sandbox === "workspace-write" ? { writableRoots: [cwd] } : {}) },
                input: [{ type: "text", text: prompt }, ...images.map((url) => ({ type: "image", url }))],
            });
            return completed;
        })()]);
    } finally { rpc.close(); }
}
