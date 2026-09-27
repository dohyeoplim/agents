import test from "node:test";
import assert from "node:assert/strict";
import { loadProfiles, profileFor, resolveProfile, validateProfiles } from "../../src/agents/profiles.js";
import { threadOptions } from "../../src/agents/app-server.js";

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
    const options = threadOptions("/workspace/inbox", undefined, policy);
    assert.equal(options.sandbox, "read-only");
    assert.equal(options.config.web_search, "live");
    assert.equal(options.config["sandbox_workspace_write.network_access"], false);
});

test("live search defaults", async () => {
    const profiles = await loadProfiles(new URL("../../config/profiles.json", import.meta.url));
    assert.ok(Object.values(profiles).every((profile) => profile.webSearch === "live"));
    assert.equal(threadOptions("/workspace/inbox").config.web_search, "live");
    assert.equal(threadOptions("/workspace/inbox", undefined, { webSearch: "disabled" }).config.web_search, "disabled");
});
