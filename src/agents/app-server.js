import { startRpc, researchIdleTimeout } from "./rpc.js";
import { runtimeHome } from "./home.js";
import { notionConfig, notionEnabled, oauthConfig } from "../integrations/notion.js";
import { providerError } from "../shared/diagnostics.js";

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
    cwd, prompt, session, model, policy = {}, images = [], onText = () => {}, onActivity, signal,
    timeout = 600000, executable = "codex", home = process.env.CODEX_HOME || "/codex", toolToken, notionAccess = false,
    research = false,
}) {
    if (signal?.aborted) throw providerError("codex", { code: "TASK_CANCELLED" });
    const codexHome = await runtimeHome(home);
    const notion = notionAccess === true && Boolean(toolToken) && await notionEnabled(codexHome);
    let threadId;
    let answer = "";
    let finalItem;
    let resolveTurn;
    let rejectTurn;
    const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    completed.catch(() => {});
    const rpc = startRpc({
        executable, args: [...oauthConfig, "app-server", "--stdio"], cwd: "/tmp", timeout, signal,
        idleTimeout: research ? researchIdleTimeout() : 0,
        env: { PATH: process.env.PATH, HOME: "/home/node", LANG: "C.UTF-8", CODEX_HOME: codexHome,
            ...(toolToken ? { PERSONAL_TOOLS_TOKEN: toolToken } : {}) },
        notify: ({ method, params }) => {
            if (!threadId || params?.threadId !== threadId) return;
            if (method.startsWith("item/") || method.startsWith("turn/")) onActivity?.();
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
                else rejectTurn(providerError("codex", params.turn?.error,
                    params.turn?.status === "completed" ? "PROVIDER_PROTOCOL" : "PROVIDER_FAILED"));
            }
        },
    });
    try {
        return await Promise.race([rpc.failure, (async () => {
            await rpc.call("initialize", { clientInfo: { name: "slack_agents", version: "0.1.0" } });
            rpc.notify("initialized", {});
            const options = threadOptions(cwd, model, policy);
            options.config["mcp_servers.notion"] = notionConfig(notion);
            if (research) options.config["mcp_servers.notion"].enabled_tools = [
                "notion-search", "notion-ai-search", "notion-get-tool-access", "notion-fetch",
            ];
            options.config.mcp_oauth_credentials_store = "file";
            if (notion) options.config.mcp_optional_startup_grace_ms = 0;
            options.config["mcp_servers.personal"] = toolToken ? {
                url: "http://gateway:8081/mcp", bearer_token_env_var: "PERSONAL_TOOLS_TOKEN",
                startup_timeout_sec: 15, tool_timeout_sec: 95, required: true,
                default_tools_approval_mode: "approve",
            } : { url: "http://gateway:8081/mcp", enabled: false };
            const result = await rpc.call(session ? "thread/resume" : "thread/start", {
                ...options, ...(session ? { threadId: session, excludeTurns: true } : {}),
            });
            threadId = result.thread?.id;
            if (!/^[0-9a-f-]{36}$/i.test(threadId || "")) {
                throw providerError("codex", { code: "PROVIDER_PROTOCOL" });
            }
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
