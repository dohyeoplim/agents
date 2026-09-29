import test from "node:test";
import assert from "node:assert/strict";
import { workerResponse } from "../../src/tasks/response.js";

function response(events) {
    const bytes = Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    return new Response(new ReadableStream({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7));
        controller.close();
    } }), { headers: { "content-type": "application/x-ndjson" } });
}

test("worker stream", async () => {
    const updates = [];
    const result = await workerResponse(response([
        { type: "text", text: "안녕하세요" }, { type: "result", session: "session", answer: "Done" },
    ]), (text) => updates.push(text));
    assert.deepEqual(updates, ["안녕하세요"]);
    assert.equal(result.answer, "Done");
    await assert.rejects(workerResponse(response([{ type: "text", text: "Partial" }])));
    await assert.rejects(workerResponse(response([{ type: "error" }])));
    await assert.rejects(workerResponse(response([{ type: "error", code: "RESEARCH_STALLED" }])),
        { code: "RESEARCH_STALLED" });
});

test("worker progress", async () => {
    const updates = [];
    const result = await workerResponse(response([
        { type: "heartbeat" },
        { type: "progress", providerEvents: 2, lastActivityAt: 1000 },
        { type: "text", text: "Output" },
        { type: "heartbeat" },
        { type: "result", session: "session", answer: "Done" },
    ]), undefined, { longRunning: true, onProgress: (value) => updates.push(value) });
    assert.deepEqual(updates, [{ providerEvents: 2, lastActivityAt: 1000 }]);
    assert.equal(result.answer, "Done");
});

test("progress validation", async () => {
    for (const key of ["providerEvents", "lastActivityAt"]) {
        for (const value of [undefined, null, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
            await assert.rejects(workerResponse(response([
                { type: "progress", providerEvents: 1, lastActivityAt: 1000, [key]: value },
            ]), undefined, { onProgress: () => assert.fail("Invalid event reached callback") }),
            /Invalid worker progress/);
        }
    }
});

test("progress failure", async () => {
    const failure = Error("Storage unavailable");
    await assert.rejects(workerResponse(response([
        { type: "progress", providerEvents: 1, lastActivityAt: 1000 },
        { type: "result", session: "session", answer: "Done" },
    ]), undefined, { onProgress: async () => { throw failure; } }), (error) => error === failure);
});

test("safe failures", async () => {
    for (const code of ["AUTH_REQUIRED", "RATE_LIMITED", "PROVIDER_PROTOCOL", "secret-token"]) {
        const expected = code === "secret-token" ? "WORKER_FAILED" : code;
        const payload = { type: "error", code, error: "secret-token" };
        for (const input of [response([payload]), Response.json(payload, { status: 500 })]) {
            await assert.rejects(workerResponse(input), (error) =>
                error.code === expected && !error.message.includes("secret-token"));
        }
    }
});
