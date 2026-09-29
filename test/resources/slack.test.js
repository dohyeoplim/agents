import test from "node:test";
import assert from "node:assert/strict";
import { createSlackResources, flattenBookmarks } from "../../src/resources/slack.js";
import { resourceContext } from "../../src/resources/context.js";

const id = "F123456";

function fixture({ redirect, file = {}, bookmarks = [], artifacts } = {}) {
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
        token: "test-token", request, artifacts,
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

test("Canvas refresh", async () => {
    const saved = [];
    const { resources, edit } = fixture({
        file: { filetype: "canvas", updated: 1 },
        artifacts: { put: async (data, metadata) => {
            saved.push({ data, metadata });
            return { id: String(saved.length) };
        } },
    });
    const first = await resources.read("C1", id, undefined, { canvasOnly: true });
    const cached = await resources.read("C1", id);
    assert.match(first.revision, /^[a-f0-9]{64}$/);
    assert.equal(first.revision, cached.revision);
    edit();
    assert.equal((await resources.read("C1", id)).text, first.text);
    const fresh = await resources.read("C1", id, undefined, { fresh: true, canvasOnly: true });
    assert.notEqual(fresh.text, first.text);
    assert.notEqual(fresh.revision, first.revision);
    assert.equal(saved.length, 4);
    assert.equal(saved[2].data.toString(), fresh.text);
    assert.equal(fresh.artifacts.length, 2);
    assert.equal((await resources.read("C1", id)).revision, fresh.revision);
});

test("Canvas validation", async () => {
    const { resources, calls } = fixture({ file: { filetype: "html", mimetype: "text/html" } });
    await assert.rejects(resources.read("C1", id, undefined, { canvasOnly: true }), /not a Slack Canvas/);
    assert.ok(calls.every((call) => call.url.hostname === "slack.com"));
    for (const file of [{ filetype: "canvas" }, { filetype: "quip" },
        { mimetype: "application/vnd.slack-docs" }]) {
        const canvas = fixture({ file });
        assert.ok((await canvas.resources.read("C1", id, undefined, { canvasOnly: true })).revision);
    }
});

test("document revisions", async () => {
    let content = "<p>Hello</p>";
    let title = "Notes";
    const resources = createSlackResources({
        token: "secret",
        request: async (url) => {
            if (url.startsWith("https://files.slack.com/")) return new Response(content);
            return Response.json({ ok: true, file: {
                id, title, channels: ["C1"], filetype: "canvas", updated: 1,
                url_private: "https://files.slack.com/canvas.html",
            } });
        },
        extract: async () => ({ text: "Hello", truncated: false }),
    });
    const read = () => resources.read("C1", id, undefined, { fresh: true, canvasOnly: true });
    const first = await read();
    assert.equal((await read()).revision, first.revision);
    content = "<p><b>Hello</b></p>";
    const formatted = await read();
    assert.equal(formatted.text, first.text);
    assert.notEqual(formatted.revision, first.revision);
    title = "Renamed notes";
    const renamed = await resources.read("C1", id);
    assert.equal(renamed.title, title);
    assert.notEqual(renamed.revision, formatted.revision);
});

test("external sources", async () => {
    const { resources, calls } = fixture({ bookmarks: [
        { id: "B1", type: "link", title: "Drive", link: "https://drive.google.com/file/test" },
    ] });
    const result = await resources.collect({ channel: "C1", prompt: "Review Drive" });
    assert.equal(result.sources.length, 0);
    assert.ok(calls.every((call) => call.url.hostname === "slack.com"));
});

test("irrelevant sources", async () => {
    const { resources, calls } = fixture({ bookmarks: [
        { id: "B1", type: "file", entity_id: id, title: "Quantum computing" },
    ] });
    const result = await resources.collect({ channel: "C1", prompt: "고마워" });
    assert.deepEqual(result.sources, []);
    assert.equal(calls.filter((call) => call.url.pathname.endsWith("files.info")).length, 0);
    assert.ok(calls.every((call) => call.url.hostname === "slack.com"));
});

test("matching sources", async () => {
    const { resources } = fixture({ bookmarks: [
        { id: "B1", type: "file", entity_id: id, title: "Quantum computing" },
    ] });
    const result = await resources.collect({ channel: "C1", prompt: "Explain quantum computing" });
    assert.equal(result.sources[0].id, id);
});

test("explicit sources", async () => {
    for (const input of [{ fileIds: [id], prompt: "Review this" },
        { prompt: "Review https://example.slack.com/files/U1/F123456/file.txt" }]) {
        const { resources, calls } = fixture();
        const result = await resources.collect({ channel: "C1", ...input });
        assert.equal(result.sources[0].id, id);
        assert.ok(calls.every((call) => !call.url.pathname.endsWith("bookmarks.list") &&
            !call.url.pathname.endsWith("files.list")));
    }
});

test("bound sources", async () => {
    const { resources, calls } = fixture({ bookmarks: [
        { id: "B1", type: "file", entity_id: id, title: "Quantum computing" },
    ] });
    const empty = await resources.collect({ channel: "C1", prompt: "Quantum computing" },
        undefined, { discover: false });
    assert.deepEqual(empty.sources, []);
    assert.equal(calls.length, 0);
    const result = await resources.collect({ channel: "C1", prompt: "Quantum computing", fileIds: [id] },
        undefined, { discover: false });
    assert.equal(result.sources[0].id, id);
    assert.ok(calls.every((call) => !call.url.pathname.endsWith("bookmarks.list") &&
        !call.url.pathname.endsWith("files.list")));
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

test("document archiving", async () => {
    const saved = [];
    const artifacts = { put: async (data, metadata) => {
        const result = { id: String(saved.length), ...metadata };
        saved.push({ data, ...result });
        return result;
    } };
    const { resources, edit } = fixture({ artifacts, file: { channels: ["C1", "C2"] } });
    const first = await resources.read("C1", id);
    assert.equal(first.artifacts.length, 2);
    assert.ok(Buffer.isBuffer(saved[0].data));
    assert.equal(saved[1].data, first.text);
    assert.equal(saved[0].source.kind, "original");
    assert.equal(saved[1].source.kind, "extracted");
    assert.equal(saved[0].source.fileId, id);
    assert.ok(!JSON.stringify(saved).includes("test-token"));
    assert.ok(!JSON.stringify(saved).includes("url_private"));
    await resources.read("C1", id);
    assert.equal(saved.length, 2);
    await resources.read("C2", id);
    assert.equal(saved[2].source.channel, "C2");
    edit();
    await resources.read("C1", id);
    assert.equal(saved.length, 6);
    assert.notEqual(saved[0].source.version, saved[4].source.version);
});

test("archive authorization", async () => {
    let writes = 0;
    const { resources } = fixture({
        file: { channels: ["C2"] }, artifacts: { put: async () => { writes++; } },
    });
    await assert.rejects(resources.read("C1", id), /Share the file/);
    assert.equal(writes, 0);
});

test("image archiving", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
        "base64");
    const saved = [];
    let data = png;
    const resources = createSlackResources({
        token: "secret",
        artifacts: { put: async (bytes, metadata) => { saved.push({ bytes, metadata }); return metadata; } },
        request: async (url) => {
            if (url.startsWith("https://files.slack.com/")) return new Response(data);
            return Response.json({ ok: true, file: {
                id, channels: ["C1"], mimetype: "image/png", updated: 3,
                url_private: "https://files.slack.com/image.png",
            } });
        },
    });
    const result = await resources.read("C1", id);
    assert.equal(result.artifacts.length, 1);
    assert.deepEqual(saved[0].bytes, png);
    assert.equal(saved[0].metadata.mime, "image/png");
    assert.equal(saved[0].metadata.source.fileId, id);
    await assert.rejects(resources.read("C2", id), /Share the file/);
    data = Buffer.from("not an image");
    await assert.rejects(resources.read("C1", id), /Supported images/);
    assert.equal(saved.length, 1);
});
