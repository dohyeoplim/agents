import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { create } from "tar";
import { paperId, parseFeed, createArxiv } from "../../src/papers/arxiv.js";
import { readSource } from "../../src/papers/source.js";
import { createLibrary } from "../../src/papers/library.js";

const tex = "\\documentclass{article}\n\\begin{document}\nHello\\end{document}";

test("paper identifiers", () => {
    assert.equal(paperId("https://arxiv.org/abs/2401.12345v2"), "2401.12345v2");
    assert.equal(paperId("cs/0701001v1"), "cs/0701001v1");
    assert.throws(() => paperId("../../credentials"));
    assert.throws(() => paperId("https://external.example/2401.12345"));
});

test("paper feed", () => {
    const result = parseFeed(`<feed><entry><id>http://arxiv.org/abs/2401.12345v1</id><title>A paper</title>
        <summary>Abstract</summary><author><name>Author</name></author><category term="cs.CV"/></entry></feed>`);
    assert.equal(result[0].id, "2401.12345v1");
    assert.deepEqual(result[0].categories, ["cs.CV"]);
    assert.throws(() => parseFeed('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]><feed/>'));
});

test("search retry", async () => {
    let calls = 0;
    const arxiv = createArxiv({ interval: 0, request: async () => {
        if (++calls < 3) throw TypeError("fetch failed");
        return new Response('<feed xmlns="http://www.w3.org/2005/Atom"><title>arXiv</title></feed>');
    } });
    assert.deepEqual(await arxiv.search({ query: "all:test" }), []);
    assert.equal(calls, 3);
    await arxiv.search({ query: "all:test" });
    assert.equal(calls, 3);
    const limited = createArxiv({ interval: 0, request: async () => {
        calls++;
        return new Response(null, { status: 429 });
    } });
    await assert.rejects(limited.search({ query: "all:test" }), /rate limit/);
    assert.equal(calls, 4);
});

test("retry cancellation", async () => {
    const controller = new AbortController();
    let calls = 0;
    const arxiv = createArxiv({ interval: 0, request: async () => {
        calls++;
        controller.abort();
        throw TypeError("fetch failed");
    } });
    await assert.rejects(arxiv.search({ query: "all:test" }, controller.signal));
    assert.equal(calls, 1);
});

test("source archive", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "source-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "main.tex"), tex);
    await writeFile(path.join(root, "image.png"), "fixture");
    const chunks = [];
    for await (const part of create({ cwd: root, gzip: true }, ["main.tex", "image.png"])) chunks.push(part);
    const parsed = await readSource(Buffer.concat(chunks));
    assert.equal(parsed.files[0].text, tex);
    assert.deepEqual(parsed.figures, ["image.png"]);
    assert.equal((await readSource(gzipSync(Buffer.from(tex)))).files[0].name, "main.tex");
    await assert.rejects(readSource(gzipSync(Buffer.alloc(26 * 1024 * 1024))));
});

test("library notes", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "library-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const data = { entries: {} };
    let downloads = 0;
    const library = createLibrary({ root,
        state: { snapshot: () => structuredClone(data), update: async (fn) => fn(data) },
        arxiv: { search: async () => [{ id: "2401.12345v1", title: "Test", url: "https://arxiv.org/abs/2401.12345v1" }],
            source: async () => { downloads++; return Buffer.from(tex); } } });
    const manifest = await library.fetch("2401.12345");
    await library.fetch("2401.12345v1");
    assert.equal(downloads, 1);
    assert.equal(manifest.format, "tex");
    assert.equal((await library.read({ id: "2401.12345v1", file: "main.tex" })).text, tex);
    const context = { team: "T1", user: "U1", profile: "scholar", channel: "C1" };
    await library.note(context, { id: "2401.12345v1", status: "read", text: "My note" });
    assert.equal(library.search(context, "note").length, 1);
    assert.equal(library.search({ ...context, user: "U2" }, "note").length, 0);
});
