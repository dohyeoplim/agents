import test from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../../src/tools/registry.js";

test("tool registration", async () => {
    const calls = [];
    const tools = createTools({ autoresearch: {
        propose: async (...args) => { calls.push(args); return { status: "draft" }; },
    } });
    const definitions = tools.definitions.filter((tool) => tool.name.startsWith("autoresearch_"));
    assert.equal(definitions.length, 6);
    const definition = definitions.find((tool) => tool.name === "autoresearch_propose");
    assert.equal(definition.inputSchema.properties.plan.type, "object");
    const context = { id: "task" };
    const result = await tools.call("autoresearch_propose", {
        plan: { title: "Study", objective: "Reduce memory" },
    }, context);
    assert.equal(result.status, "draft");
    assert.equal(calls[0][0].plan.budget.maxConcurrent, 4);
    assert.deepEqual(calls[0][1], context);
    await assert.rejects(tools.call("autoresearch_start", {}, context));
});
