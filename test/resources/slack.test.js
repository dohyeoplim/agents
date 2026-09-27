import test from "node:test";
import assert from "node:assert/strict";
import { createSlackResources, flattenBookmarks } from "../../src/resources/slack.js";
import { resourceContext } from "../../src/resources/context.js";

const id = "F123456";

function fixture({ redirect, file = {}, bookmarks = [] } = {}) {
    const calls = [];
    let version = 1;
    let visible = true;
    const request = async (value, options) => {
        const url = new URL(value);
        calls.push({ url, options });
        if (url.hostname === "files.slack.com") {
            return redirect ? new Response(null, { status: 302, headers: { location: redirect } }) :
                new Response("Source text version " + version);
        }
        let data;
        if (url.pathname.endsWith("bookmarks.list")) data = { ok: true, bookmarks };
        else if (url.pathname.endsWith("files.list")) data = { ok: true, files: [] };
        else data = visible ? { ok: true, file: {
            id, filetype: "text", channels: ["C1"], title: "Source", updated: version,
            url_private_download: "https://files.slack.com/files-pri/T1-F123456/file.txt",
            permalink: "https://example.slack.com/files/U1/F123456/file.txt", ...file,
        } } : { ok: false, error: "file_not_found" };
        return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    };
    const resources = createSlackResources({
        token: "test-token", request,
        extract: async (data) => ({ text: data.toString(), embedded: [], truncated: false }),
    });
    return { resources, calls, edit: () => version++, revoke: () => { visible = false; } };
}

test("folder discovery", async () => {
    const bookmarks = [{ id: "B1", type: "folder", title: "Research", children: [
        { id: "B2", type: "file", entity_id: id, title: "Paper" },
    ] }];
    assert.equal(flattenBookmarks(bookmarks)[1].parent_id, "B1");
    const { resources } = fixture({ bookmarks });
    const catalog = await resources.catalog("C1");
    assert.equal(catalog.items[0].id, id);
    assert.equal(catalog.folders[0].children, 1);
});

test("file permissions", async () => {
    const { resources, calls } = fixture({ file: { channels: ["C2"] } });
    await assert.rejects(resources.read("C1", id), /Share the file/);
    assert.ok(calls.every((call) => call.url.hostname === "slack.com"));
});

test("redirect safety", async () => {
    const { resources, calls } = fixture({ redirect: "https://external.example/steal" });
    await assert.rejects(resources.read("C1", id), /Untrusted/);
    assert.ok(calls.every((call) => call.url.hostname !== "external.example"));
});

test("resource refresh", async () => {
    const { resources, calls, edit, revoke } = fixture();
    await resources.read("C1", id);
    await resources.read("C1", id);
    assert.equal(calls.filter((call) => call.url.hostname === "files.slack.com").length, 1);
    edit();
    assert.ok((await resources.read("C1", id)).text.includes("version 2"));
    revoke();
    await assert.rejects(resources.read("C1", id), /file_not_found/);
});

test("external sources", async () => {
    const { resources, calls } = fixture({ bookmarks: [
        { id: "B1", type: "link", title: "Drive", link: "https://drive.google.com/file/test" },
    ] });
    const result = await resources.collect({ channel: "C1", prompt: "Review Drive" });
    assert.equal(result.sources.length, 0);
    assert.ok(calls.every((call) => call.url.hostname === "slack.com"));
});

test("resource context", () => {
    const text = resourceContext({ sources: [{ id, title: "Source", text: "a".repeat(24000) }], notices: [] });
    const context = JSON.parse(text);
    assert.equal(context.sources[0].truncated, true);
    assert.ok(text.length < 20000);
    assert.ok(!text.includes("url_private"));
});

test("relevant excerpt", () => {
    const text = "a".repeat(10000) + " Important deadline: Friday " + "b".repeat(10000);
    const result = resourceContext({ sources: [{ id, title: "Project", text }], notices: [] }, "deadline");
    assert.ok(JSON.parse(result).sources[0].text.includes("deadline: Friday"));
});
