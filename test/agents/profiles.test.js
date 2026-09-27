import test from "node:test";
import assert from "node:assert/strict";
import { loadProfiles, profileFor, resolveProfile, validateProfiles } from "../../src/agents/profiles.js";
import { codexArgs } from "../../src/agents/codex.js";

test("profile selection", () => {
    assert.equal(profileFor({ name: "reading" }), "scholar");
    assert.equal(profileFor({ name: "lab" }), "engineer");
    assert.equal(profileFor({ name: "inbox" }), "assistant");
    assert.equal(profileFor({ name: "lab", profile: "scholar" }), "scholar");
});

test("profile validation", async () => {
    const profiles = await loadProfiles(new URL("../../config/profiles.json", import.meta.url));
    assert.equal(resolveProfile(profiles, { name: "inbox" }, "scholar").id, "scholar");
    assert.throws(() => resolveProfile(profiles, { name: "inbox" }, "unknown"));
    const restricted = structuredClone(profiles);
    restricted.assistant.delegates = [];
    assert.throws(() => resolveProfile(restricted, { name: "inbox" }, "scholar"));
    restricted.assistant.sandbox = "danger-full-access";
    assert.throws(() => validateProfiles(restricted));
});

test("profile policies", () => {
    const policy = { sandbox: "read-only", networkAccess: false, webSearch: "live" };
    for (const session of [undefined, "12345678-1234-1234-1234-123456789abc"]) {
        const args = codexArgs(session, undefined, policy);
        assert.ok(args.includes('sandbox_mode="read-only"'));
        assert.ok(args.includes('web_search="live"'));
        assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
    }
});
