import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

export function readDocument(data, kind, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(Error("Resource reading cancelled"));
        const child = spawn(process.execPath, [
            "--max-old-space-size=192", fileURLToPath(new URL("./extract.js", import.meta.url)), kind,
        ], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: "/tmp" } });
        let output = "";
        const decoder = new StringDecoder("utf8");
        const stop = () => child.kill("SIGKILL");
        const timer = setTimeout(stop, 15000);
        signal?.addEventListener("abort", stop, { once: true });
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", stop);
        };
        child.stdout.on("data", (chunk) => {
            output += decoder.write(chunk);
            if (output.length > 300000) stop();
        });
        child.stderr.resume();
        child.stdin.on("error", () => {});
        child.on("error", () => {
            cleanup();
            reject(Error("Document reader could not start"));
        });
        child.on("close", (code) => {
            cleanup();
            if (code !== 0 || signal?.aborted) return reject(Error("Document text could not be extracted"));
            try { resolve(JSON.parse(output.trim().split("\n").at(-1))); }
            catch { reject(Error("Invalid document reader response")); }
        });
        child.stdin.end(data);
        if (signal?.aborted) stop();
    });
}
