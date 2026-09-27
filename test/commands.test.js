import test from "node:test";
import assert from "node:assert/strict";
import { knowledgeCommand, parseCommand, requestedTask } from "../src/commands.js";
import { loadProfiles } from "../src/profiles.js";
import { loadSkills } from "../src/skills.js";

const profiles = await loadProfiles(new URL("../config/profiles.json", import.meta.url));
const skills = await loadSkills(new URL("../config/skills.json", import.meta.url));

test("specialist requests and skills are explicit and bounded", () => {
    assert.equal(parseCommand("Hello"), null);
    const job = requestedTask("!delegate scholar Review this paper", profiles, { name: "inbox" }, skills);
    assert.equal(job.profile, "scholar");
    assert.equal(job.prompt, "Review this paper");
    assert.equal(job.delegated, true);
    assert.throws(() => requestedTask("!delegate unknown hi", profiles, { name: "inbox" }, skills));
    assert.throws(() => requestedTask("!skill code-review hi", profiles, { name: "reading" }, skills));
    assert.throws(() => requestedTask("!delegate scholar !delegate engineer hi", profiles, {}, skills));
});

test("memory commands save and remove entries without model execution", async () => {
    const data = {};
    const store = { snapshot: () => structuredClone(data), update: async (fn) => fn(data) };
    const context = { team: "T1", user: "U1", channel: "C1", profile: "assistant", thread: "1.1" };
    const run = (text) => knowledgeCommand(parseCommand(text), context, store, profiles, skills);
    await run("!remember shared Use concise answers");
    const id = Object.keys(data.entries)[0];
    assert.ok((await run("!memories")).includes("Use concise answers"));
    await run("!forget " + id);
    assert.equal(await run("!memories"), "No matching entries");
});
