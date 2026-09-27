import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { routeEvent } from "../../src/slack/routing.js";
import { validate, loadConfig, saveConfig } from "../../src/channels/config.js";
import { registerChannel, updateChannel } from "../../src/channels/registry.js";
import { discoverChannels } from "../../src/channels/discovery.js";

const config = {
    team: "T1",
    users: ["U1"],
    channels: {
        C1: { name: "inbox", agent: "assistant", cwd: "inbox", instructions: "Original role" },
    },
};

test("channel registration", () => {
    const added = registerChannel(config, "C2", "research");
    assert.equal(added.channels.C2.cwd, "research");
    assert.equal(added.channels.C2.enabled, true);
    assert.equal(added.channels.C1.instructions, "Original role");
    assert.equal(config.channels.C2, undefined);
    const renamed = registerChannel(added, "C1", "incoming");
    assert.equal(renamed.channels.C1.cwd, "inbox");
    assert.equal(renamed.channels.C1.instructions, "Original role");
    assert.throws(() => registerChannel(added, "C3", "research"));
    assert.throws(() => registerChannel(config, "C2", "../escape"));
});

test("thread isolation", () => {
    const channels = registerChannel(config, "C2", "research");
    const event = { channel: "C1", user: "U1", ts: "100.001", text: "<@BOT> hello" };
    const select = (message) => routeEvent(channels, { team_id: "T1" }, message, "BOT", () => false);
    const first = select(event);
    const second = select({ ...event, channel: "C2" });
    const third = select({ ...event, ts: "100.002" });
    assert.notEqual(first.key, second.key);
    assert.notEqual(first.key, third.key);
    assert.equal(first.route.cwd, "inbox");
    assert.equal(second.route.cwd, "research");
    assert.equal(select({ ...event, text: "No mention" }), null);
});

test("disabled channels", () => {
    const disabled = updateChannel(config, "inbox", { enabled: false });
    const event = { channel: "C1", user: "U1", ts: "100.002", thread_ts: "100.001", text: "<@BOT> hi" };
    assert.equal(routeEvent(disabled, { team_id: "T1" }, event, "BOT", () => true), null);
    const enabled = updateChannel(disabled, "C1", { enabled: true });
    assert.ok(routeEvent(enabled, { team_id: "T1" }, event, "BOT", () => true));
    assert.equal(enabled.channels.C1.instructions, "Original role");
    assert.throws(() => updateChannel(config, "missing", { enabled: true }));
    assert.throws(() => updateChannel(config, "C1", { cwd: "other" }));
});

test("channel validation", () => {
    for (const patch of [{ enabled: "false" }, { instructions: 12 }]) {
        assert.throws(() => updateChannel(config, "C1", patch));
    }
    assert.throws(() => validate({ ...config, users: "U1" }));
    assert.throws(() => validate({ ...config, channels: [] }));
});

test("channel discovery", async () => {
    const calls = [];
    const request = async (url) => {
        const parsed = new URL(url);
        calls.push(parsed.pathname);
        let data;
        if (parsed.pathname.endsWith("auth.test")) {
            data = { ok: true, team_id: "T1" };
        } else if (!parsed.searchParams.get("cursor")) {
            data = {
                ok: true,
                channels: [{ id: "C1", name: "inbox", is_member: true }],
                response_metadata: { next_cursor: "next" },
            };
        } else {
            data = { ok: true, channels: [{ id: "C2", name: "research", is_member: false }] };
        }
        return { ok: true, json: async () => data };
    };
    assert.deepEqual(await discoverChannels("test-token", "T1", request), [
        { id: "C1", name: "inbox", member: true },
        { id: "C2", name: "research", member: false },
    ]);
    assert.deepEqual(calls, ["/api/auth.test", "/api/conversations.list", "/api/conversations.list"]);
    await assert.rejects(discoverChannels("test-token", "T2", request), /workspace mismatch/);
});

test("missing scopes", async () => {
    const request = async () => ({ ok: true, json: async () => ({ ok: false, error: "missing_scope" }) });
    await assert.rejects(discoverChannels("secret-token", "T1", request), /Add channels:read/);
});

test("configuration persistence", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "channels-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "routes.json");
    await saveConfig(config, file, root);
    assert.equal((await loadConfig(file)).channels.C1.instructions, "Original role");
    const updated = updateChannel(config, "inbox", { instructions: "New role" });
    await saveConfig(updated, file, root);
    assert.equal((await loadConfig(file)).channels.C1.instructions, "New role");
    await mkdir(path.join(root, "outside"));
    await symlink(path.join(root, "outside"), path.join(root, "data/assistant/workspace/research"));
    await assert.rejects(saveConfig(registerChannel(updated, "C2", "research"), file, root));
    assert.equal((await loadConfig(file)).channels.C2, undefined);
});
