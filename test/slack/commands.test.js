import test from "node:test";
import assert from "node:assert/strict";
import { knowledgeCommand } from "../../src/knowledge/commands.js";
import { parseCommand } from "../../src/shared/text.js";
import { requestedTask } from "../../src/slack/commands.js";
import { loadProfiles } from "../../src/agents/profiles.js";
import { loadSkills } from "../../src/agents/skills.js";

const profiles = await loadProfiles(new URL("../../config/profiles.json", import.meta.url));
const skills = await loadSkills(new URL("../../config/skills.json", import.meta.url));

test("task commands", () => {
    assert.equal(parseCommand("Hello"), null);
    const job = requestedTask("!delegate scholar Review this paper", profiles, { name: "inbox" }, skills);
    assert.equal(job.profile, "scholar");
    assert.equal(job.prompt, "Review this paper");
    assert.equal(job.delegated, true);
    assert.throws(() => requestedTask("!delegate unknown hi", profiles, { name: "inbox" }, skills));
    assert.throws(() => requestedTask("!skill code-review hi", profiles, { name: "reading" }, skills));
    assert.throws(() => requestedTask("!delegate scholar !delegate engineer hi", profiles, {}, skills));
});

test("memory commands", async () => {
    const data = {};
    const store = { snapshot: () => structuredClone(data), update: async (fn) => fn(data) };
    const context = { team: "T1", user: "U1", channel: "C1", profile: "assistant", thread: "1.1" };
    const run = (text) => knowledgeCommand(parseCommand(text), context, store);
    await run("!remember shared Use concise answers");
    const id = Object.keys(data.entries)[0];
    assert.ok((await run("!memories")).includes("Use concise answers"));
    await run("!forget " + id);
    assert.equal(await run("!memories"), "No matching entries");
});

test("research command", () => {
    const job = requestedTask("!research Compare on-device methods", profiles, { name: "inbox" }, skills);
    assert.match(job.prompt, /research control tools/);
    assert.match(job.prompt, /Compare on-device methods/);
    assert.equal(job.profile, "assistant");
});
