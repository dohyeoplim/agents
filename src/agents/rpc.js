import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { providerError } from "../shared/diagnostics.js";

export function researchIdleTimeout(value = process.env.RESEARCH_IDLE_TIMEOUT_SECONDS ?? "1200") {
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 2147483 || String(value).trim() === "") {
        throw Error("Invalid RESEARCH_IDLE_TIMEOUT_SECONDS");
    }
    return seconds * 1000;
}

export function idleWatchdog(timeout, stalled) {
    let timer;
    const touch = () => {
        clearTimeout(timer);
        if (timeout > 0) timer = setTimeout(stalled, timeout);
    };
    touch();
    return { touch, close: () => clearTimeout(timer) };
}

export function startRpc({ executable, args, env, cwd, signal, timeout, notify, idleTimeout = 0 }) {
    const child = spawn(executable, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map();
    const decoder = new StringDecoder("utf8");
    let nextId = 0;
    let buffer = "";
    let bytes = 0;
    let closed = false;
    let failed = false;
    let stderr = "";
    let rejectFailure;
    const failure = new Promise((resolve, reject) => { rejectFailure = reject; });
    failure.catch(() => {});
    const stop = () => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
    };
    const fail = (reason) => {
        if (failed || closed) return;
        failed = true;
        const error = providerError("codex", reason || stderr);
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        rejectFailure(error);
        watchdog.close();
        clearTimeout(timer);
        stop();
    };
    const timer = timeout === null ? undefined : setTimeout(() => fail({ code: "TASK_TIMEOUT" }), timeout);
    const watchdog = idleWatchdog(idleTimeout, () => fail(Object.assign(
        Error("Codex produced no execution events within the inactivity limit"), { code: "RESEARCH_STALLED" },
    )));
    const abort = () => fail({ code: "TASK_CANCELLED" });
    signal?.addEventListener("abort", abort, { once: true });
    const write = (message) => {
        if (closed || failed || child.stdin.destroyed) throw providerError("codex", stderr);
        child.stdin.write(JSON.stringify(message) + "\n");
    };
    child.stdout.on("data", (data) => {
        bytes += data.length;
        if (timeout !== null && bytes > 128 * 1024 * 1024) return fail({ code: "PROVIDER_PROTOCOL" });
        buffer += decoder.write(data);
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            if (newline > 32 * 1024 * 1024) return fail({ code: "PROVIDER_PROTOCOL" });
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
                const event = JSON.parse(line);
                if (event && (typeof event.method === "string" || event.id !== undefined)) watchdog.touch();
                if (event.method && event.id !== undefined) {
                    write({ id: event.id, error: { code: -32601, message: "Interactive requests are disabled" } });
                } else if (event.id !== undefined) {
                    const request = pending.get(event.id);
                    pending.delete(event.id);
                    if (event.error) request?.reject(providerError("codex", event.error,
                        [-32600, -32601, -32602, -32700].includes(event.error.code) ?
                            "PROVIDER_PROTOCOL" : "PROVIDER_FAILED"));
                    else request?.resolve(event.result);
                } else if (event.method) notify(event);
            } catch { fail({ code: "PROVIDER_PROTOCOL" }); }
        }
        if (buffer.length > 32 * 1024 * 1024) fail({ code: "PROVIDER_PROTOCOL" });
    });
    child.stderr.on("data", (data) => { stderr = (stderr + data.toString("utf8")).slice(-16384); });
    child.stdin.on("error", fail);
    child.on("error", (error) => fail(providerError("codex", error, "PROVIDER_START_FAILED")));
    child.on("close", () => {
        if (!closed) fail();
    });
    if (signal?.aborted) abort();
    return {
        failure,
        notify: (method, params) => write({ method, params }),
        call: (method, params) => new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            try { write({ id, method, params }); } catch (error) { pending.delete(id); reject(error); }
        }),
        close: () => {
            closed = true;
            clearTimeout(timer);
            watchdog.close();
            signal?.removeEventListener("abort", abort);
            stop();
        },
    };
}
