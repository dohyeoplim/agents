import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore } from "../../src/storage/artifacts.js";

const source = { provider: "slack", channel: "C1", fileId: "F123456", version: "1", kind: "original" };

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), "agents-artifacts-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return { directory, store: createArtifactStore({ directory }) };
}

test("artifact publication preserves bytes and metadata across store instances", async (t) => {
    const { directory, store } = await fixture(t);
    const data = Buffer.from([0, 255, 42, 10]);
    const result = await store.put(data, { mime: "application/pdf", source });
    assert.deepEqual(await readFile(join(directory, result.path)), data);
    const manifest = JSON.parse(await readFile(join(directory, "manifests", result.id + ".json"), "utf8"));
    assert.deepEqual(manifest, result);
    assert.equal(result.size, data.length);
    assert.deepEqual(await createArtifactStore({ directory }).put(data, {
        mime: "application/pdf", source,
    }), result);
});

test("concurrent duplicate writes share an immutable blob without partial files", async (t) => {
    const { directory, store } = await fixture(t);
    const results = await Promise.all(Array.from({ length: 12 }, () => store.put("paper", {
        mime: "text/plain", source,
    })));
    assert.ok(results.every((result) => result.id === results[0].id));
    const other = await store.put("paper", { mime: "text/plain", source: { ...source, channel: "C2" } });
    assert.equal(other.hash, results[0].hash);
    assert.notEqual(other.id, results[0].id);
    assert.deepEqual(await readdir(join(directory, "blobs", other.hash.slice(0, 2))), [other.hash]);
    assert.equal((await readdir(join(directory, "manifests"))).length, 2);
});

test("source changes retain prior versions and cannot choose storage paths", async (t) => {
    const { directory, store } = await fixture(t);
    const first = await store.put("first", { mime: "text/plain", source });
    const second = await store.put("second", {
        mime: "text/plain", source: { ...source, fileId: "../../outside", version: "2", token: "secret" },
    });
    assert.notEqual(first.hash, second.hash);
    assert.equal(await readFile(join(directory, first.path), "utf8"), "first");
    assert.match(second.path, /^blobs\/[a-f0-9]{2}\/[a-f0-9]{64}$/);
    assert.equal(second.source.token, undefined);
    await assert.rejects(store.put({}, { mime: "text/plain", source }), /Invalid artifact content/);
    await assert.rejects(store.put("x", { mime: "../bad", source }), /Invalid artifact MIME/);
    await assert.rejects(store.put("x", { mime: "text/plain", source: {} }), /Invalid artifact source/);
});

test("existing damaged blobs are rejected without being overwritten", async (t) => {
    const { directory, store } = await fixture(t);
    const result = await store.put("first", { mime: "text/plain", source });
    await writeFile(join(directory, result.path), "damage");
    await assert.rejects(store.put("first", { mime: "text/plain", source }), /integrity check/);
    assert.equal(await readFile(join(directory, result.path), "utf8"), "damage");
    assert.deepEqual(await readdir(join(directory, "blobs", result.hash.slice(0, 2))), [result.hash]);
});

test("artifact reads verify manifest paths and content hashes for research sources", async (t) => {
    const { directory, store } = await fixture(t);
    const saved = await store.put("Evidence", {
        mime: "text/plain", source: { ...source, provider: "research", kind: "source" },
    });
    assert.equal((await store.get(saved.id)).data.toString(), "Evidence");
    await assert.rejects(store.get("../../outside"), /Invalid artifact ID/);
    await writeFile(join(directory, saved.path), "Modified");
    await assert.rejects(store.get(saved.id), /integrity check/);
    await writeFile(join(directory, "manifests", saved.id + ".json"),
        JSON.stringify({ ...saved, path: "../../outside" }));
    await assert.rejects(store.get(saved.id), /integrity check/);
});
