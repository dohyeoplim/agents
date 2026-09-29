import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteWorkspace } from "../src/remote/service.js";
import { researchToolAllowed } from "../src/research/policy.js";

const context = { team: "T1", user: "U1", channel: "C1", thread: "100.001" };

function setup(overrides = {}) {
    const calls = [];
    const service = createRemoteWorkspace({
        config: async () => ({ team: "T1", users: ["U1", "U2"],
            channels: { C1: {}, C2: {}, C3: { enabled: false } } }),
        personal: async () => ({ owner: "U1" }),
        connection: null,
        transport: { request: async (payload, signal) => {
            calls.push({ payload, signal });
            return { ok: true, result: { connected: true } };
        } },
        ...overrides,
    });
    return { service, calls };
}

test("remote owner access", async () => {
    const { service, calls } = setup();
    for (const override of [{ user: "U2" }, { user: "unknown" }, { team: "T2" },
        { channel: "missing" }, { channel: "C3" }]) {
        await assert.rejects(service.run("status", {}, { ...context, ...override }), /access denied/);
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(await service.run("status", {}, context), { configured: true, connected: true });
    assert.equal(calls.length, 1);
});

test("remote owner fallback", async () => {
    const { service, calls } = setup({ personal: async () => ({}) });
    await service.run("jobs", {}, context);
    await assert.rejects(service.run("jobs", {}, { ...context, user: "U2" }), /access denied/);
    assert.equal(calls.length, 1);
    const alternate = setup({ personal: async () => ({ owner: "U2" }) });
    await assert.rejects(alternate.service.run("jobs", {}, context), /access denied/);
    await alternate.service.run("jobs", {}, { ...context, user: "U2" });
    assert.equal(alternate.calls.length, 1);
});

test("remote background access", async () => {
    const { service, calls } = setup();
    for (const override of [{ researchId: "R1" }, { researchId: "R1", researchStage: "canvas" },
        { scheduleId: "S1" }, { briefingDate: "2026-09-29" }]) {
        await assert.rejects(service.run("exec", {}, { ...context, ...override }), /access denied/);
    }
    assert.equal(calls.length, 0);
});

test("remote missing config", async () => {
    const { service } = setup({ transport: null });
    assert.deepEqual(await service.run("status", {}, context), { configured: false, connected: false });
    await assert.rejects(service.run("exec", {}, context), /not configured/);
    await assert.rejects(service.run("status", {}, { ...context, user: "U2" }), /access denied/);
});

test("remote owner namespace", async () => {
    const { service, calls } = setup();
    const signal = new AbortController().signal;
    await service.run("jobs", {}, context, signal);
    await service.run("jobs", {}, { ...context, channel: "C2", thread: "200.001" }, signal);
    assert.match(calls[0].payload.namespace, /^[a-f0-9]{64}$/);
    assert.equal(calls[0].payload.namespace, calls[1].payload.namespace);
    assert.equal(calls[0].signal, signal);
    const alternate = setup({ personal: async () => ({ owner: "U2" }) });
    await alternate.service.run("jobs", {}, { ...context, user: "U2" });
    assert.notEqual(calls[0].payload.namespace, alternate.calls[0].payload.namespace);
});

test("remote invalid operation", async () => {
    const { service, calls } = setup();
    await assert.rejects(service.run("unknown", {}, context), /Unknown remote operation/);
    await assert.rejects(service.run("exec", {}, context, AbortSignal.abort()));
    assert.equal(calls.length, 0);
});

test("remote error envelope", async () => {
    const failed = setup({ transport: { request: async () => ({ ok: false, error: "REMOTE_FILE_CHANGED" }) } });
    await assert.rejects(failed.service.run("write", {}, context), { message: "REMOTE_FILE_CHANGED" });
    for (const raw of [null, [], { ok: true, result: [] }, { ok: true, result: {}, extra: true },
        { ok: false, error: "SECRET credential details" }, { ok: false, error: "REMOTE_FAILED", secret: "hidden" }]) {
        const { service } = setup({ transport: { request: async () => raw } });
        await assert.rejects(service.run("write", {}, context), (error) => {
            assert.match(error.message, /Invalid remote response/);
            assert.match(error.message, /Inspect job state/);
            assert.ok(!error.message.includes("SECRET"));
            return true;
        });
    }
    const error = Object.assign(Error("Transport disconnected"), { code: "REMOTE_CONNECT", uncertain: true });
    const { service } = setup({ transport: { request: async () => { throw error; } } });
    await assert.rejects(service.run("exec", {}, context), (received) => received === error);
});

test("remote tool policy", () => {
    const tools = ["remote_status", "remote_exec", "remote_jobs", "remote_job", "remote_cancel",
        "remote_read", "remote_write"];
    for (const name of tools) {
        assert.equal(researchToolAllowed({}, name), true);
        for (const task of [{ researchId: "R1", researchStage: "clarify" },
            { researchId: "R1", researchStage: "canvas" }, { scheduleId: "S1" }, { briefingDate: "2026-09-29" }]) {
            assert.equal(researchToolAllowed(task, name), false);
        }
    }
    assert.equal(researchToolAllowed({}, "remote_unknown"), false);
    assert.equal(researchToolAllowed({}, "remote_exec_extra"), false);
});
