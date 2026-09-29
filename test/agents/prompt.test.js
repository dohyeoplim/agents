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

test("autoresearch preparation", () => {
    const prompt = buildPrompt({ profile: { instructions: "Profile" }, route: {}, input: { prompt: "Study" } });
    assert.match(prompt, /Use autoresearch_status/);
    assert.match(prompt, /use autoresearch_campaign, not two separate/);
    assert.match(prompt, /Do not ask the user for repository commits/);
    assert.match(prompt, /Separately requested remote computer work may use remote_\* tools/);
    assert.match(prompt, /Prepare only freezes/);
});

test("campaign prompt", () => {
    const base = { profile: { instructions: "Policy" }, route: {}, input: { autoresearchId: "campaign",
        researchId: "campaign", researchStage: "campaign", prompt: '{"objective":"Find ideas"}' } };
    const prompt = buildPrompt(base);
    assert.match(prompt, /baseline first/);
    assert.match(prompt, /finalOnly/);
    assert.match(prompt, /Find ideas/);
    assert.doesNotMatch(prompt, /runner is not configured/);
    const review = buildPrompt({ ...base, input: { ...base.input, researchStage: "campaign-review" } });
    assert.match(review, /Independently critique/);
    assert.doesNotMatch(review, /"kind":"command"/);
    assert.throws(() => buildPrompt({ ...base, input: { ...base.input, autoresearchId: "other" } }));
});
