import test from "node:test";
import assert from "node:assert/strict";
import { knowledgeContext } from "../src/knowledge.js";

test("delegation context", () => {
    const context = { team: "T1", user: "U1", key: "thread", profile: "scholar", delegated: true };
    const task = {
        ...context, id: "parent", prompt: "Check the source", answer: "Useful findings",
        status: "completed", finishedAt: 1,
    };
    const data = { tasks: {
        parent: task,
        other: { ...task, user: "U2", answer: "Private", finishedAt: 2 },
        unrelated: { ...task, key: "another-thread", answer: "Unrelated", finishedAt: 3 },
    } };
    const result = JSON.parse(knowledgeContext(data, context, "source"));
    assert.equal(result.parent.answer, "Useful findings");
    assert.equal(JSON.parse(knowledgeContext(data, { ...context, delegated: false }, "source")).parent, undefined);
});
