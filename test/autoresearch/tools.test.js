import test from "node:test";
import assert from "node:assert/strict";
import { proposalInput, controlInput, statusInput, manifestInput,
    createAutoresearchTools } from "../../src/autoresearch/tools.js";

const id = "05d1b22a-cf4f-484f-8d22-60a44e9932f7";
const plan = { title: "Experiment", objective: "Measure accuracy" };

test("plan references", () => {
    assert.equal(proposalInput.parse({ plan }).plan.budget.maxConcurrent, 4);
    assert.equal(proposalInput.parse({ plan, id, revision: 1 }).id, id);
    for (const value of [{ plan, id }, { plan, revision: 1 }, { plan, id, revision: -1 },
        { plan, execute: true }]) assert.equal(proposalInput.safeParse(value).success, false);
});

test("execution rejection", () => {
    for (const action of ["start", "run", "continue", "resume"]) {
        assert.equal(controlInput.safeParse({ id, revision: 1, action }).success, false);
    }
    for (const action of ["approve", "cancel", "refresh"]) {
        assert.equal(controlInput.parse({ id, revision: 1, action }).action, action);
    }
});

test("bounded pagination", () => {
    assert.deepEqual(statusInput.parse({}), { offset: 0, limit: 10 });
    assert.equal(manifestInput.parse({ id }).offset, 0);
    for (const value of [{ limit: 11 }, { offset: -1 }, { offset: 0.5 }, { limit: 0 }]) {
        assert.equal(statusInput.safeParse(value).success, false);
    }
});

test("service routing", async () => {
    const calls = [];
    const context = { channel: "C1", user: "U1" };
    const signal = new AbortController().signal;
    const service = Object.fromEntries(["inspect", "propose", "act", "readManifest"].map((name) =>
        [name, (...args) => { calls.push([name, ...args]); return name; }]));
    const tools = createAutoresearchTools(service);
    for (const [name, method, args] of [["status", "inspect", {}], ["propose", "propose", { plan }],
        ["control", "act", { id, revision: 1, action: "approve" }], ["manifest", "readManifest", { id }]]) {
        const tool = tools[`autoresearch_${name}`];
        const parsed = tool.schema.parse(args);
        assert.equal(await tool.run(parsed, context, signal), method);
        const expected = method === "inspect" ? [context, parsed] : [parsed, context];
        if (["propose", "act"].includes(method)) expected.push(signal);
        assert.deepEqual(calls.at(-1), [method, ...expected]);
    }
    assert.equal(tools.autoresearch_propose.readOnly, false);
    assert.equal(tools.autoresearch_control.readOnly, false);
    assert.deepEqual(createAutoresearchTools(), {});
});
