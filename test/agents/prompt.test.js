import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../../src/agents/prompt.js";

test("prompt composition preserves literal placeholders and replacement characters in supplied content", () => {
    const prompt = buildPrompt({ profile: { instructions: "Profile policy" },
        route: { instructions: "Channel policy" }, skill: "Skill policy",
        input: { context: "Memory {{request}}", sourceContext: "Source {{profile}} $&",
            prompt: "Create a canvas containing {{sources}} and $'" } });
    for (const text of ["Profile policy", "Channel policy", "Skill policy", "Memory {{request}}",
        "Source {{profile}} $&", "Create a canvas containing {{sources}} and $'"]) {
        assert.ok(prompt.includes(text));
    }
    assert.ok(prompt.indexOf("Profile policy") < prompt.indexOf("Memory {{request}}"));
    assert.ok(prompt.indexOf("Memory {{request}}") < prompt.indexOf("Create a canvas containing"));
});
