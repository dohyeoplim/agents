import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createWorker } from "../../src/agents/worker.js";
import { loadProfiles } from "../../src/agents/profiles.js";
import { loadSkills } from "../../src/agents/skills.js";
import { workerResponse } from "../../src/tasks/response.js";

async function fixture(t, run, claude, configured = () => {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "worker-"));
    await mkdir(path.join(root, "inbox"));
    const worker = createWorker({
        workspace: root, agent: "assistant", run, claude,
        config: async () => {
            configured();
            return { channels: { C1: { name: "inbox", agent: "assistant", cwd: "inbox" } } };
        },
        profiles: () => loadProfiles(new URL("../../config/profiles.json", import.meta.url)),
        skills: () => loadSkills(new URL("../../config/skills.json", import.meta.url)),
    });
    t.after(async () => {
        worker.closeAllConnections();
        if (worker.listening) await new Promise((resolve) => worker.close(resolve));
        await rm(root, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.listen(0, "127.0.0.1", resolve);
    });
    return (route, input) => fetch(`http://127.0.0.1:${worker.address().port}${route}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
}

test("worker context", async (t) => {
    let options;
    const request = await fixture(t, async (input) => {
        options = input;
        return { session: randomUUID(), answer: "Done" };
    });
    const response = await request("/run", {
        channel: "C1", prompt: "Read this", profile: "scholar", skill: "paper-review", context: "Saved preference",
        sourceContext: "Canvas reference text", historyContext: "Previous thread reference",
    });
    assert.equal(response.status, 200);
    assert.equal(options.policy.id, "scholar");
    assert.equal(options.policy.webSearch, "live");
    assert.equal(options.notionAccess, false);
    assert.ok(options.cwd.endsWith("/inbox"));
    assert.ok(options.prompt.includes("Saved preference"));
    assert.ok(options.prompt.includes("Canvas reference text"));
    assert.ok(options.prompt.includes("Previous thread reference"));
    assert.ok(options.prompt.includes("limitations"));
});

test("clarification policy", async (t) => {
    const request = await fixture(t, async (options) => {
        assert.equal(options.policy.webSearch, "disabled");
        return { session: randomUUID(), answer: "Plan" };
    });
    const response = await request("/run", { channel: "C1", prompt: "Clarify scope",
        researchId: randomUUID(), researchStage: "clarify" });
    assert.equal((await workerResponse(response)).answer, "Plan");
});

test("research isolation", async (t) => {
    let release;
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const request = await fixture(t, async ({ signal }) => {
        ready();
        await new Promise((resolve) => {
            release = resolve;
            signal.addEventListener("abort", resolve, { once: true });
        });
        return { session: randomUUID(), answer: "Normal" };
    }, async (options) => {
        assert.equal(options.timeout, null);
        assert.equal(options.onText, undefined);
        assert.equal(options.session, undefined);
        assert.equal(options.research, true);
        assert.match(options.cwd, /\/inbox\/\.research\/[\da-f-]+\/counter\/[\da-f-]+$/);
        return { session: randomUUID(), answer: "Research" };
    });
    const research = { channel: "C1", prompt: "Investigate", researchId: randomUUID(),
        researchRunId: randomUUID(), researchStage: "counter", provider: "claude" };
    for (const change of [{ researchId: "../escape" }, { researchStage: "bad" }, { provider: "gemini" },
        { researchRunId: "bad" }, { session: randomUUID() }, { researchId: undefined }]) {
        assert.equal((await request("/run", { ...research, ...change })).status, 400);
    }
    const normal = request("/run", { channel: "C1", prompt: "Normal" });
    await started;
    const response = await request("/run", research);
    assert.equal((await workerResponse(response)).answer, "Research");
    release();
    assert.equal((await normal).status, 200);
});

test("research cancellation", async (t) => {
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const request = await fixture(t, async ({ signal }) => {
        started();
        await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Error("Stopped"))));
    });
    const id = randomUUID();
    const response = await request("/run", { id, channel: "C1", prompt: "Research",
        researchId: randomUUID(), researchStage: "explore" });
    await ready;
    await request("/cancel", { id });
    await assert.rejects(workerResponse(response), /Worker failed/);
});

test("worker authorization", async (t) => {
    let called = false;
    const request = await fixture(t, async () => { called = true; });
    assert.equal((await request("/run", { channel: "C2", prompt: "hi" })).status, 400);
    assert.equal((await request("/run", { channel: "C1", prompt: "hi", skill: "code-review" })).status, 500);
    assert.equal((await request("/run", {
        channel: "C1", prompt: "hi", historyContext: "x".repeat(12001),
    })).status, 400);
    assert.equal(called, false);
});

test("worker Notion access", async (t) => {
    const values = [];
    const request = await fixture(t, async (input) => {
        values.push(input.notionAccess);
        return { session: randomUUID(), answer: "Done" };
    });
    for (const notionAccess of ["true", 1, null, {}, []]) {
        assert.equal((await request("/run", { channel: "C1", prompt: "hi", notionAccess })).status, 400);
    }
    for (const notionAccess of [true, false]) {
        assert.equal((await request("/run", {
            channel: "C1", prompt: "hi", notionAccess, toolToken: "x".repeat(43),
        })).status, 200);
    }
    assert.deepEqual(values, [true, false]);
});

test("worker cancellation", async (t) => {
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const request = await fixture(t, async ({ signal }) => {
        ready();
        await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Error("Stopped"))));
    });
    const id = randomUUID();
    const running = request("/run", { id, channel: "C1", prompt: "Wait" });
    await started;
    assert.equal((await request("/cancel", { id })).status, 200);
    assert.equal((await running).status, 500);
});

test("worker streaming", async (t) => {
    const request = await fixture(t, async ({ onText, images }) => {
        assert.equal(images.length, 1);
        onText("Hello ".repeat(30));
        return { session: randomUUID(), answer: "Complete" };
    });
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/" +
        "x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
    const response = await request("/run", { channel: "C1", prompt: "Image", images: [png], stream: true });
    const updates = [];
    const result = await workerResponse(response, (text) => updates.push(text));
    assert.equal(updates.length, 1);
    assert.equal(result.answer, "Complete");
    const invalid = await request("/run", { channel: "C1", prompt: "Image", images: ["file:///codex/auth.json"] });
    assert.equal(invalid.status, 400);
});

test("independent sessions", { timeout: 2000 }, async (t) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const request = await fixture(t, async ({ session }) => {
        if (session) {
            entered.resolve();
            await release.promise;
        }
        return { session: session || randomUUID(), answer: "Done" };
    });
    t.after(() => release.resolve());
    const first = request("/run", { channel: "C1", prompt: "First", session: randomUUID() });
    await entered.promise;
    assert.equal((await request("/run", { channel: "C1", prompt: "Independent" })).status, 200);
    release.resolve();
    assert.equal((await first).status, 200);
});

test("session serialization", { timeout: 2000 }, async (t) => {
    const entered = Promise.withResolvers();
    const queued = Promise.withResolvers();
    const release = Promise.withResolvers();
    const session = randomUUID();
    let running = 0;
    let maximum = 0;
    let configurations = 0;
    const request = await fixture(t, async () => {
        maximum = Math.max(maximum, ++running);
        entered.resolve();
        await release.promise;
        running--;
        return { session, answer: "Done" };
    }, undefined, () => {
        if (++configurations === 3) queued.resolve();
    });
    t.after(() => release.resolve());
    const first = request("/run", { channel: "C1", prompt: "First", session });
    await entered.promise;
    const second = request("/run", { channel: "C1", prompt: "Second", session });
    await queued.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(running, 1);
    release.resolve();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    assert.equal(maximum, 1);
});
