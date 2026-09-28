import test from "node:test";
import assert from "node:assert/strict";
import { researchIntent } from "../../src/research/intent.js";
import { buildResearchPrompt } from "../../src/research/prompts.js";

test("research triggers distinguish explicit investigation from ordinary questions", () => {
    for (const text of ["이 주제 딥리서치 해줘", "심층 조사해주세요", "Start deep research on caching",
        "!research caching", "딥리서치 시작해"]) assert.equal(researchIntent(text), "new");
    for (const text of ["딥리서치 뭐야?", "딥리서치 시작하는 트리거는 어떻게?", "검색해줘",
        "딥리서치 하지 마", "What is deep research?"]) assert.equal(researchIntent(text), null);
    for (const [text, action] of [["그대로 시작해", "start"], ["잠깐 멈춰", "pause"],
        ["이어서 해", "resume"], ["!stop", "pause"], ["여기까지 하고 마무리해", "finish"]]) {
        assert.equal(researchIntent(text), action);
    }
});

test("research prompts preserve literal user placeholders and reject unknown stages", () => {
    const args = { profile: { instructions: "Profile rules" }, route: {},
        input: { researchStage: "explore", prompt: "Read {{profile}} literally" } };
    const prompt = buildResearchPrompt(args);
    assert.ok(prompt.includes("Read {{profile}} literally"));
    assert.ok(prompt.includes("Complete an independent research report"));
    assert.throws(() => buildResearchPrompt({ ...args, input: { researchStage: "unknown" } }), /Unknown/);
});
