import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureNotion, notionEnabled, notionUrl } from "../../src/integrations/notion.js";
import { runtimeHome } from "../../src/agents/home.js";

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "notion-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = await runtimeHome(root);
    return { root, home };
}

test("Notion login", async (t) => {
    const { root, home } = await fixture(t);
    await writeFile(path.join(root, "auth.json"), "existing Codex login");
    assert.equal(await notionEnabled(home), false);
    const result = await configureNotion("login", { root, run: async (args, options) => {
        assert.equal(options.env.CODEX_HOME, home);
        assert.equal(options.cwd, "/tmp");
        assert.ok(args.includes('mcp_oauth_credentials_store="file"'));
        assert.ok(args.includes(`mcp_servers.notion.url="${notionUrl}"`));
        assert.deepEqual(args.slice(-4), ["mcp", "login", "notion", "--no-browser"]);
        assert.equal(await notionEnabled(home), false);
        await writeFile(path.join(home, ".credentials.json"), "fake OAuth credentials");
    } });
    assert.equal(result.enabled, true);
    const restarted = await runtimeHome(root);
    assert.equal(await notionEnabled(restarted), true);
    assert.equal(await readFile(path.join(restarted, ".credentials.json"), "utf8"), "fake OAuth credentials");
    assert.equal(await readFile(path.join(restarted, "auth.json"), "utf8"), "existing Codex login");
    assert.equal(await realpath(path.join(restarted, "sessions")), path.join(root, "sessions"));
    assert.equal((await stat(path.join(home, "notion.json"))).mode & 0o777, 0o600);
});

test("Notion disconnection", async (t) => {
    const { root, home } = await fixture(t);
    const success = async () => {};
    await configureNotion("login", { root, run: success });
    await assert.rejects(configureNotion("login", { root, run: async () => { throw Error("Login failed"); } }));
    assert.equal(await notionEnabled(home), false);
    await configureNotion("login", { root, run: success });
    await configureNotion("logout", { root, run: async (args) => {
        assert.equal(await notionEnabled(home), false);
        assert.deepEqual(args.slice(-3), ["mcp", "logout", "notion"]);
    } });
    assert.equal(await notionEnabled(home), false);
    assert.ok((await stat(path.join(home, "sessions"))).isDirectory());
});

test("Notion status", async (t) => {
    const { root, home } = await fixture(t);
    await writeFile(path.join(home, ".credentials.json"), "private-token");
    const status = await configureNotion("status", { root, run: () => assert.fail("Unexpected login") });
    assert.deepEqual(status, { enabled: false, url: notionUrl, liveConnectionChecked: false });
    await writeFile(path.join(home, "notion.json"), "broken");
    await assert.rejects(notionEnabled(home), /Cannot read Notion/);
    await assert.rejects(configureNotion("unknown", { root }), /Unknown Notion/);
});
