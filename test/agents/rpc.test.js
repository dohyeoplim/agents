import test from "node:test";
import assert from "node:assert/strict";
import { startRpc, researchIdleTimeout } from "../../src/agents/rpc.js";

test("RPC cancellation", async () => {
    const controller = new AbortController();
    const script = `process.stdin.once("data", data => {
        const request = JSON.parse(data.toString());
        setTimeout(() => process.stdout.write(JSON.stringify({id: request.id, result: "ready"}) + "\\n"), 30);
    }); setInterval(() => {}, 1000);`;
    const rpc = startRpc({ executable: process.execPath, args: ["-e", script], env: {}, cwd: "/tmp",
        timeout: null, signal: controller.signal, notify() {} });
    try {
        assert.equal(await Promise.race([rpc.call("initialize", {}), rpc.failure]), "ready");
        controller.abort();
        await assert.rejects(rpc.failure, (error) => error.code === "TASK_CANCELLED");
    } finally { rpc.close(); }
});

test("idle timeout settings", () => {
    assert.equal(researchIdleTimeout("1200"), 1200000);
    assert.equal(researchIdleTimeout("0"), 0);
    for (const value of ["", "bad", "-1", "0.1", "Infinity", "2147484"]) {
        assert.throws(() => researchIdleTimeout(value), /Invalid/);
    }
});

test("RPC activity tracking", async () => {
    const script = `let count = 0;
        const progress = setInterval(() => {
            process.stdout.write(JSON.stringify({ method: "item/progress", params: {} }) + "\\n");
            if (++count === 3) clearInterval(progress);
        }, 15);
        setInterval(() => process.stderr.write("still open\\n"), 5);`;
    let events = 0;
    const rpc = startRpc({ executable: process.execPath, args: ["-e", script], env: {}, cwd: "/tmp",
        timeout: null, idleTimeout: 100, notify: () => events++ });
    try {
        await assert.rejects(rpc.failure, (error) => error.code === "RESEARCH_STALLED");
        assert.equal(events, 3);
    } finally { rpc.close(); }
});

test("RPC error categories", async () => {
    const cases = [
        ["process.stderr.write('401 invalid token sk-fake-secret');process.exit(1)", "AUTH_REQUIRED"],
        ["process.stdout.write('bad json\\n')", "PROVIDER_PROTOCOL"],
        ["setInterval(()=>{},1000)", "TASK_TIMEOUT"],
    ];
    for (const [script, code] of cases) {
        const rpc = startRpc({ executable: process.execPath, args: ["-e", script], cwd: "/tmp", env: {},
            timeout: 100, notify() {} });
        try {
            await assert.rejects(rpc.failure, (error) => error.code === code &&
                !error.message.includes("sk-fake-secret") && error.detail === undefined);
        } finally { rpc.close(); }
    }
});

test("RPC request failure", async () => {
    const script = `process.stdin.once("data", data => {
        const request = JSON.parse(data.toString());
        process.stdout.write(JSON.stringify({id: request.id,
            error:{code:-32601,message:"unsupported method private prompt"}})+"\\n");
    });setInterval(()=>{},1000);`;
    const rpc = startRpc({ executable: process.execPath, args: ["-e", script], cwd: "/tmp", env: {},
        timeout: 2000, notify() {} });
    try {
        await assert.rejects(rpc.call("unknown", {}), (error) => error.code === "PROVIDER_PROTOCOL" &&
            error.detail === undefined && !error.message.includes("private"));
    } finally { rpc.close(); }
});
