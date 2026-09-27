import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export function startRpc({ executable, args, env, cwd, signal, timeout, notify }) {
    const child = spawn(executable, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map();
    const decoder = new StringDecoder("utf8");
    let nextId = 0;
    let buffer = "";
    let bytes = 0;
    let closed = false;
    let rejectFailure;
    const failure = new Promise((resolve, reject) => { rejectFailure = reject; });
    failure.catch(() => {});
    const stop = () => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
    };
    const fail = () => {
        const error = Error("Codex connection failed");
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        rejectFailure(error);
        stop();
    };
    const timer = setTimeout(fail, timeout);
    signal?.addEventListener("abort", fail, { once: true });
    const write = (message) => {
        if (closed || child.stdin.destroyed) throw Error("Codex connection closed");
        child.stdin.write(JSON.stringify(message) + "\n");
    };
    child.stdout.on("data", (data) => {
        bytes += data.length;
        if (bytes > 128 * 1024 * 1024) return fail();
        buffer += decoder.write(data);
        if (buffer.length > 32 * 1024 * 1024) return fail();
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
                const event = JSON.parse(line);
                if (event.method && event.id !== undefined) {
                    write({ id: event.id, error: { code: -32601, message: "Interactive requests are disabled" } });
                } else if (event.id !== undefined) {
                    const request = pending.get(event.id);
                    pending.delete(event.id);
                    if (event.error) request?.reject(Object.assign(Error("Codex request failed"), {
                        detail: event.error.message,
                    }));
                    else request?.resolve(event.result);
                } else if (event.method) notify(event);
            } catch { fail(); }
        }
    });
    child.stderr.resume();
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.on("close", () => {
        if (!closed) fail();
    });
    if (signal?.aborted) fail();
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
            signal?.removeEventListener("abort", fail);
            stop();
        },
    };
}
