import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../../src/agents/prompt.js";

test("prompt composition", () => {
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

test("research control prompt", () => {
    const prompt = buildPrompt({ profile: { instructions: "Profile" }, route: {},
        input: { prompt: "Continue research {{research}}", historyContext: "Prior decisions" } });
    assert.ok(prompt.includes("Use research_status before proposing"));
    assert.ok(prompt.includes("Never propose a plan and start it in response to the same user message"));
    assert.ok(prompt.includes("Questions about progress, ordinary chat and acknowledgments must not change"));
    assert.ok(prompt.includes("use its id as parentId"));
    assert.ok(prompt.includes("Continue research {{research}}"));
    assert.ok(prompt.includes("Prior decisions"));
});
