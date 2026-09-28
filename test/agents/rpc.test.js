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
        await assert.rejects(rpc.failure, /connection failed/);
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
