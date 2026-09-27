import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PersistentState } from "../src/state.js";
import { addEntry, visibleEntries, forgetEntry, searchEntries, knowledgeContext } from "../src/knowledge.js";
import { loadSkills, resolveSkill } from "../src/skills.js";

const context = { team: "T1", user: "U1", channel: "C1", profile: "scholar", thread: "1.1" };

test("memory scopes exclude other users, profiles and channels", () => {
    const data = {};
    for (const scope of ["shared", "profile", "channel"]) {
        addEntry(data, context, { kind: "memory", scope, text: `Preference ${scope}` });
    }
    assert.equal(visibleEntries(data, context).length, 3);
    assert.equal(visibleEntries(data, { ...context, user: "U2" }).length, 0);
    assert.equal(visibleEntries(data, { ...context, channel: "C2", profile: "engineer" }).length, 1);
    assert.equal(visibleEntries(data, { ...context, channel: "C2" }).length, 2);
});

test("notes are searchable with provenance and can be forgotten only within their scope", () => {
    const data = {};
    const id = addEntry(data, context, {
        kind: "note", scope: "profile", title: "Attention", text: "Sparse attention research notes",
    });
    assert.equal(searchEntries(data, context, "sparse research")[0].id, id);
    assert.ok(knowledgeContext(data, context, "sparse").includes('"thread":"1.1"'));
    assert.throws(() => forgetEntry(data, { ...context, user: "U2" }, id));
    forgetEntry(data, context, id);
    assert.equal(searchEntries(data, context, "sparse").length, 0);
});

test("persistent state serializes concurrent writes and survives restart", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-state-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "state.json");
    const store = await new PersistentState(file, { count: 0 }).load();
    await Promise.all(Array.from({ length: 10 }, () => store.update((data) => { data.count++; })));
    await assert.rejects(store.update((data) => { data.count = 99; throw Error("Abort"); }));
    const restored = await new PersistentState(file, {}).load();
    assert.equal(restored.snapshot().count, 10);
});

test("skills are available only to assigned profiles", async () => {
    const skills = await loadSkills(new URL("../config/skills.json", import.meta.url));
    assert.ok(resolveSkill(skills, { skills: ["paper-review"] }, "paper-review").includes("source"));
    assert.throws(() => resolveSkill(skills, { skills: ["paper-review"] }, "code-review"));
});
