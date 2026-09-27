import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PersistentState } from "../../src/shared/state.js";

test("session persistence", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "store-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new PersistentState(path.join(dir, "state.json"), { threads: {} });
    await store.load();
    await store.update((data) => {
        data.threads.a = { session: "abc" };
    });
    const next = new PersistentState(store.file, { threads: {} });
    await next.load();
    assert.equal(next.snapshot().threads.a.session, "abc");
});
