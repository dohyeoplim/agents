import test from "node:test";
import assert from "node:assert/strict";
import { createAutoresearchSlack, renderAutoresearch } from "../../src/autoresearch/slack.js";
import { autoresearchText } from "../../src/autoresearch/copy.js";

const id = "05d1b22a-cf4f-484f-8d22-60a44e9932f7";

function fixture(overrides = {}) {
    const job = { id, team: "T1", user: "U1", channel: "C1", thread: "100.001", key: "T1:C1:100.001:codex",
        profile: "assistant", status: "ready", revision: 1, title: "Experiment", missing: [],
        plan: { objective: "Measure accuracy" }, messageTs: "101.001", ...overrides };
    const data = { autoresearchJobs: { [id]: job } };
    const calls = [];
    const state = { snapshot: () => structuredClone(data), update: async (fn) => fn(data) };
    const config = { team: "T1", users: ["U1", "U2"], channels: { C1: { agent: "codex" }, C2: { agent: "codex" } } };
    const client = { chat: {
        postMessage: async (value) => { calls.push(["post", value]); return { ts: "102.001" }; },
        update: async (value) => calls.push(["update", value]),
        postEphemeral: async (value) => calls.push(["ephemeral", value]),
    } };
    const handlers = {};
    const ui = createAutoresearchSlack({ client, state, config: async () => config,
        control: async (...args) => { calls.push(["control", ...args]); job.revision += 1; return "Accepted"; },
    });
    ui.register({ action: (pattern, fn) => { handlers.action = fn; handlers.pattern = pattern; } });
    function click(action = "approve", body = {}, value = `${id}:1`) {
        assert.match(`autoresearch_${action}`, handlers.pattern);
        return handlers.action({ ack: async () => calls.push(["ack"]),
            body: { team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
                message: { ts: "101.001" }, ...body }, action: { action_id: `autoresearch_${action}`, value } });
    }
    return { job, calls, client, config, ui, click };
}

test("offline actions", () => {
    for (const [status, labels] of [["draft", ["Cancel"]], ["ready", ["Prepare", "Cancel"]],
        ["prepared", ["Manifest", "Cancel"]], ["cancelled", []]]) {
        const { job } = fixture({ status });
        const result = renderAutoresearch(job);
        const buttons = result.blocks.find((block) => block.type === "actions")?.elements || [];
        assert.deepEqual(buttons.map((button) => button.text.text), labels);
        assert.match(result.blocks[2].elements[0].text, /연결되지/);
        assert.match(result.text, /Auto Research/);
    }
});

test("action replay", async () => {
    const { click, calls } = fixture();
    await click();
    await click();
    assert.equal(calls[0][0], "ack");
    assert.equal(calls.filter(([kind]) => kind === "control").length, 1);
    assert.deepEqual(calls.find(([kind]) => kind === "control").slice(1), [id, "approve",
        { team: "T1", user: "U1", channel: "C1", thread: "100.001", revision: 1 }]);
    assert.match(calls.at(-1)[1].text, /만료/);
});

test("action authorization", async () => {
    for (const body of [{ user: { id: "U2" } }, { team: { id: "T2" } }, { channel: { id: "C2" } },
        { message: { ts: "103.001" } }]) {
        const { click, calls } = fixture();
        await click("approve", body);
        assert.equal(calls.some(([kind]) => kind === "control"), false);
    }
    for (const route of [{ enabled: false }, { profile: "scholar" }, { agent: "other" }]) {
        const { click, calls, config } = fixture();
        Object.assign(config.channels.C1, route);
        await click();
        assert.equal(calls.some(([kind]) => kind === "control"), false);
    }
});

test("action validation", async () => {
    for (const value of [id, `${id}:NaN`, `${id}:1:2`, `${id}:-1`, `${id}:99999999999999999999`]) {
        const { click, calls } = fixture();
        await click("approve", {}, value);
        assert.equal(calls.some(([kind]) => kind === "control"), false);
    }
    const { click, calls } = fixture({ status: "draft" });
    await click();
    assert.equal(calls.some(([kind]) => kind === "control"), false);
});

test("deleted status", async () => {
    const { job, ui, client, calls } = fixture();
    const update = client.chat.update;
    client.chat.update = async (message) => {
        if (message.ts === "101.001") {
            job.status = "prepared";
            job.revision = 2;
            throw Object.assign(Error("deleted"), { data: { error: "message_not_found" } });
        }
        return update(message);
    };
    await Promise.all([ui.publish(job), ui.publish(job)]);
    const posts = calls.filter(([kind]) => kind === "post");
    assert.equal(posts.length, 1);
    assert.match(posts[0][1].text, /실험은 실행하지/);
    assert.equal(posts[0][1].thread_ts, "100.001");
    assert.equal(job.messageTs, "102.001");
    assert.equal(calls.find(([kind]) => kind === "update")[1].ts, "102.001");
});

test("update failure", async () => {
    const { job, ui, client, calls } = fixture();
    const failure = Object.assign(Error("rate"), { data: { error: "ratelimited" } });
    client.chat.update = async () => { throw failure; };
    await assert.rejects(ui.publish(job), (error) => error === failure);
    assert.equal(calls.some(([kind]) => kind === "post"), false);
});

test("bounded rendering", () => {
    const { job } = fixture({ title: "<@U1>".repeat(100), missing: ["repository"],
        plan: { objective: "x".repeat(6000), training: { command: ["x".repeat(20000)] } } });
    const rendered = renderAutoresearch(job);
    assert.equal(rendered.blocks[0].text.type, "plain_text");
    assert.equal(rendered.blocks[0].text.text.length, 150);
    assert.ok(rendered.blocks.every((block) => !block.text || block.text.text.length <= 2900));
    assert.ok(rendered.blocks.some((block) => block.elements?.some((element) => /생략/.test(element.text))));
    assert.ok(rendered.blocks.some((block) => /repository/.test(block.text?.text)));
    assert.throws(() => autoresearchText("missing"), /Unknown/);
    assert.throws(() => autoresearchText("UI_HEADING"), /Unknown/);
});
