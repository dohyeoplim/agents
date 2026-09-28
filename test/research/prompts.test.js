import test from "node:test";
import assert from "node:assert/strict";
import { buildResearchPrompt } from "../../src/research/prompts.js";

test("prompt rendering", () => {
    const args = { profile: { instructions: "Profile rules" }, route: {},
        input: { researchStage: "explore", prompt: "Read {{profile}} literally" } };
    const prompt = buildResearchPrompt(args);
    assert.ok(prompt.includes("Read {{profile}} literally"));
    assert.ok(prompt.includes("Complete an independent research report"));
    assert.throws(() => buildResearchPrompt({ ...args, input: { researchStage: "unknown" } }), /Unknown/);
});
