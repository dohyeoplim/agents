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
});
