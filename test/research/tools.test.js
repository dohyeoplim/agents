import test from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../../src/tools/registry.js";

const id = "c2c84fc2-12a2-423e-ae61-a0a36e1f104e";
const context = { id: "task", team: "team", channel: "channel", thread: "thread", user: "user" };

function setup() {
    const calls = [];
    const researchControl = Object.fromEntries(["inspect", "propose", "act", "readResult"].map((name) =>
        [name, (...args) => { calls.push({ name, args }); return { success: true }; }]));
    return { registry: createTools({ researchControl }), calls };
}

test("control definitions", () => {
    const { registry } = setup();
    const names = ["research_status", "research_propose", "research_control", "research_result"];
    for (const name of names) {
        const tool = registry.definitions.find((item) => item.name === name);
        assert.ok(tool.description);
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert.equal(tool.annotations.readOnlyHint, ["research_status", "research_result"].includes(name));
    }
    const standalone = createTools({});
    assert.ok(!standalone.definitions.some((tool) => names.includes(tool.name)));
});

test("control dispatch", async () => {
    const { registry, calls } = setup();
    assert.deepEqual(await registry.call("research_status", {}, context), { success: true });
    await registry.call("research_propose", { title: " Title ", brief: " Scope " }, context);
    await registry.call("research_propose", { title: "Followup", brief: "New scope", parentId: id }, context);
    await registry.call("research_propose", { id, revision: 0, title: "Edit", brief: "Scope",
        questions: ["Which device?"] }, context);
    for (const action of ["start", "resume", "pause", "finish", "canvas"]) {
        await registry.call("research_control", { id, revision: 2, action }, context);
    }
    await registry.call("research_result", { id }, context);
    assert.deepEqual(calls[0], { name: "inspect", args: [context] });
    assert.deepEqual(calls[1], { name: "propose", args: [{ title: "Title", brief: "Scope", questions: [] }, context] });
    assert.equal(calls[2].args[0].parentId, id);
    assert.equal(calls[3].args[0].revision, 0);
    assert.deepEqual(calls.slice(4, 9).map((call) => call.name), Array(5).fill("act"));
    assert.deepEqual(calls.at(-1), { name: "readResult", args: [{ id, offset: 0 }, context] });
});

test("control validation", async () => {
    const { registry, calls } = setup();
    const plan = { title: "Title", brief: "Scope" };
    const invalid = [
        ["research_status", { id }],
        ["research_propose", { ...plan, title: " " }],
        ["research_propose", { ...plan, title: "x".repeat(151) }],
        ["research_propose", { ...plan, brief: "x".repeat(6001) }],
        ["research_propose", { ...plan, questions: ["a", "b", "c", "d"] }],
        ["research_propose", { ...plan, questions: ["x".repeat(501)] }],
        ["research_propose", { ...plan, id }],
        ["research_propose", { ...plan, revision: 0 }],
        ["research_propose", { ...plan, id, revision: 0, parentId: id }],
        ["research_propose", { ...plan, parentId: "invalid" }],
        ["research_propose", { ...plan, start: true }],
        ["research_control", { id, revision: -1, action: "start" }],
        ["research_control", { id, revision: 1.5, action: "start" }],
        ["research_control", { id, revision: 0, action: "delete" }],
        ["research_control", { id, action: "start" }],
        ["research_result", { id, offset: -1 }],
        ["research_result", { id, channel: "other" }],
    ];
    for (const [name, args] of invalid) {
        await assert.rejects(registry.call(name, args, context), /Invalid tool arguments/);
    }
    assert.equal(calls.length, 0);
});

test("control cancellation", async () => {
    const { registry, calls } = setup();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(registry.call("research_propose", { title: "Title", brief: "Scope" },
        context, controller.signal), { name: "AbortError" });
    assert.equal(calls.length, 0);
});
