import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAutomaticChannels } from "../../src/channels/automatic.js";
import { loadConfig } from "../../src/channels/config.js";
import { confined } from "../../src/shared/paths.js";

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "automatic-channels-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "automatic.json");
    const manual = path.join(root, "manual.json");
    const base = { team: "T1", users: ["U1"], channels: {
        C1: { agent: "assistant", cwd: "original", enabled: false, instructions: "Custom" },
    } };
    await writeFile(manual, JSON.stringify(base));
    const config = () => loadConfig(manual, file);
    const joined = [];
    const errors = [];
    const available = [
        { id: "C1", name: "existing", is_member: true },
        { id: "C2", name: "coursework", is_member: false },
        { id: "G3", name: "private", is_member: true, is_private: true },
        { id: "G4", name: "hidden", is_member: false, is_private: true },
        { id: "C5", name: "archived", is_archived: true },
    ];
    const client = { conversations: {
        list: async ({ cursor }) => ({ ok: true,
            channels: cursor ? available.slice(2) : available.slice(0, 2),
            response_metadata: { next_cursor: cursor ? "" : "next" },
        }),
        join: async ({ channel }) => { joined.push(channel); return { ok: true }; },
        info: async ({ channel }) => ({ ok: true, channel: available.find((item) => item.id === channel) }),
    } };
    const automatic = createAutomaticChannels({ client, team: "T1", bot: "UBOT", file, config,
        report: (error) => errors.push(error) });
    return { root, file, manual, base, config, joined, errors, available, client, automatic };
}

test("scan joins public channels and persists routes shared with the worker", async (t) => {
    const f = await fixture(t);
    await f.automatic.sync();
    assert.deepEqual(f.joined, ["C2"]);
    const current = await f.config();
    assert.deepEqual(current.channels.C1, f.base.channels.C1);
    assert.equal(current.channels.C2.cwd, "c2");
    assert.match(current.channels.C2.instructions, /coursework/);
    assert.equal(current.channels.G3.cwd, "g3");
    assert.equal(current.channels.G4, undefined);
    assert.equal(current.channels.C5, undefined);
    assert.deepEqual(JSON.parse(await readFile(f.manual, "utf8")), f.base);
    f.available[1].is_member = true;
    await f.automatic.sync();
    assert.deepEqual(await f.config(), current);
    assert.deepEqual(f.errors, []);
});

test("creation and own membership events register channels and ignore foreign events", async (t) => {
    const f = await fixture(t);
    const event = { type: "channel_created", channel: { id: "C2" } };
    await f.automatic.handle({ body: { team_id: "T2" }, event });
    await f.automatic.handle({ body: { team_id: "T1" },
        event: { type: "member_joined_channel", user: "UOTHER", channel: "C2" } });
    assert.deepEqual(f.joined, []);
    await Promise.all([
        f.automatic.handle({ body: { team_id: "T1" }, event }),
        f.automatic.handle({ body: { team_id: "T1" },
            event: { type: "member_joined_channel", user: "UBOT", channel: "G3" } }),
    ]);
    const current = await f.config();
    assert.ok(current.channels.C2);
    assert.ok(current.channels.G3);
    await f.automatic.stop();
    await f.automatic.handle({ body: { team_id: "T1" }, event });
    assert.deepEqual(f.joined, ["C2"]);
});

test("failed joins are retried and do not prevent registration of other channels", async (t) => {
    const f = await fixture(t);
    const join = f.client.conversations.join;
    f.client.conversations.join = async () => { throw Error("missing_scope"); };
    await f.automatic.sync();
    assert.equal((await f.config()).channels.C2, undefined);
    assert.ok((await f.config()).channels.G3);
    assert.equal(f.errors.length, 1);
    f.client.conversations.join = join;
    await f.automatic.sync();
    assert.ok((await f.config()).channels.C2);
    await writeFile(f.file, JSON.stringify({ team: "T2", channels: {} }));
    await assert.rejects(f.config(), /workspace mismatch/);
});

test("manual overrides take precedence and corrupt automatic state is rejected", async (t) => {
    const f = await fixture(t);
    await f.automatic.sync();
    await writeFile(f.manual, JSON.stringify({ ...f.base, channels: {
        ...f.base.channels, C2: { agent: "assistant", cwd: "custom", enabled: false },
    } }));
    await f.automatic.sync();
    assert.equal((await f.config()).channels.C2.enabled, false);
    assert.equal((await f.config()).channels.C2.cwd, "custom");
    await writeFile(f.file, "broken");
    await assert.rejects(f.config(), SyntaxError);
});

test("new workspaces are created while symlink escapes are rejected before nested writes", async (t) => {
    const f = await fixture(t);
    const workspace = path.join(f.root, "workspace");
    const outside = path.join(f.root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    assert.equal(await confined(workspace, "c2", true), path.join(workspace, "c2"));
    await symlink(outside, path.join(workspace, "link"));
    await assert.rejects(confined(workspace, "link/nested", true), /Workspace escape/);
    await assert.rejects(confined(workspace, "../outside/nested", true), /Workspace escape/);
    await assert.rejects(readFile(path.join(outside, "nested")), { code: "ENOENT" });
});
