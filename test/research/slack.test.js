import test from "node:test";
import assert from "node:assert/strict";
import { createResearchSlack, renderResearch } from "../../src/research/slack.js";
import { researchText } from "../../src/research/copy.js";

const id = "05d1b22a-cf4f-484f-8d22-60a44e9932f7";

test("copy rendering", () => {
    assert.equal(researchText("UI_HEADING", { title: "{{title}}" }), "Deep Research · {{title}}");
    assert.throws(() => researchText("missing"), /Unknown research text key/);
    assert.throws(() => researchText("UI_HEADING"), /Unknown research text placeholder/);
});

function fixture(overrides = {}) {
    const job = { id, team: "T1", user: "U1", channel: "C1", thread: "100.001", key: "T1:C1:100.001:codex",
        profile: "assistant", status: "ready", revision: 1, title: "Study", brief: "Scope", messageTs: "101.001",
        ...overrides };
    const data = { researchJobs: { [id]: job } };
    const calls = [];
    const state = { snapshot: () => structuredClone(data), update: async (fn) => fn(data) };
    const config = { team: "T1", users: ["U1", "U2"], channels: { C1: { agent: "codex" }, C2: { agent: "codex" } } };
    const client = {
        chat: {
            postMessage: async (value) => { calls.push(["post", value]); return { ts: "102.001" }; },
            update: async (value) => calls.push(["update", value]),
            postEphemeral: async (value) => calls.push(["ephemeral", value]),
        },
        views: { open: async (value) => calls.push(["open", value]) },
    };
    const handlers = {};
    const ui = createResearchSlack({ client, state, config: async () => config,
        control: async (...args) => {
            calls.push(["control", ...args]);
            job.revision += 1;
            return "Accepted";
        },
    });
    ui.register({ action: (_, fn) => { handlers.action = fn; }, view: (_, fn) => { handlers.view = fn; } });
    function click(action = "start", body = {}, value = `${id}:1`) {
        return handlers.action({ ack: async () => calls.push(["ack"]),
            body: { team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
                message: { ts: "101.001" }, trigger_id: "trigger", ...body },
            action: { action_id: `research_${action}`, value },
        });
    }
    return { job, data, calls, config, handlers, ui, click };
}

test("completion actions", () => {
    const { job } = fixture({ status: "completed", title: "<@U1>".repeat(100), brief: "x".repeat(9000) });
    const result = renderResearch(job);
    assert.deepEqual(result.blocks.at(-1).elements.map((button) => button.text.text),
        ["Research More", "Save to Canvas"]);
    assert.equal(result.blocks[0].text.type, "plain_text");
    assert.equal(result.blocks[0].text.text.length, 150);
    assert.equal(result.blocks[2].text.text.length, 2900);
});

test("clarification actions", async () => {
    for (const action of ["status", "pause"]) {
        const { job, click, calls } = fixture({ status: "clarifying" });
        assert.deepEqual(renderResearch(job).blocks.at(-1).elements.map((button) => button.text.text),
            ["Status", "Pause"]);
        await click(action);
        assert.equal(calls.find(([kind]) => kind === "control")[2], action);
    }
});

test("status publishing", async () => {
    const { job, ui, calls } = fixture({ messageTs: undefined });
    const first = ui.publish(job);
    job.status = "running";
    const second = ui.publish(job);
    await Promise.all([first, second]);
    assert.equal(calls.filter(([kind]) => kind === "post").length, 1);
    assert.equal(calls.filter(([kind]) => kind === "update").length, 1);
    assert.equal(job.messageTs, "102.001");
    assert.match(calls.find(([kind]) => kind === "post")[1].text, /running/);
});

test("action replay", async () => {
    const { click, calls } = fixture();
    await click();
    await click();
    assert.equal(calls[0][0], "ack");
    assert.equal(calls.filter(([kind]) => kind === "control").length, 1);
    assert.deepEqual(calls.find(([kind]) => kind === "control").slice(1), [id, "start", undefined,
        { team: "T1", user: "U1", channel: "C1", thread: "100.001", revision: 1 }]);
    assert.match(calls.at(-1)[1].text, /expired/);
});

test("action authorization", async () => {
    for (const body of [
        { user: { id: "U2" } }, { team: { id: "T2" } }, { channel: { id: "C2" } },
        { message: { ts: "103.001" } },
    ]) {
        const { click, calls } = fixture();
        await click("start", body);
        assert.equal(calls.some(([kind]) => kind === "control"), false);
    }
    const { click, config, calls } = fixture();
    config.channels.C1.enabled = false;
    await click();
    assert.equal(calls.some(([kind]) => kind === "control"), false);
});

test("action validation", async () => {
    for (const value of [id, `${id}:NaN`, `${id}:1:2`, `${id}:-1`, `${id}:99999999999999999999`]) {
        const { click, calls } = fixture();
        await click("start", {}, value);
        assert.equal(calls.some(([kind]) => kind === "control"), false);
    }
    const { click, calls } = fixture({ status: "running" });
    await click();
    assert.equal(calls.some(([kind]) => kind === "control"), false);
});

test("edit modal", async () => {
    const { click, calls, handlers } = fixture();
    await click("edit");
    const modal = calls.find(([kind]) => kind === "open")[1].view;
    assert.equal(modal.blocks[0].element.initial_value, undefined);
    assert.equal(modal.blocks[0].label.text, "Changes to scope");
    assert.equal(modal.blocks[0].element.max_length, 3000);
    const submit = (user) => handlers.view({ ack: async () => calls.push(["ack"]),
        body: { team: { id: "T1" }, user: { id: user } }, view: { ...modal,
            state: { values: { research_input: { text: { value: "Updated scope" } } } } },
    });
    await submit("U2");
    assert.equal(calls.some(([kind]) => kind === "control"), false);
    await submit("U1");
    assert.deepEqual(calls.find(([kind]) => kind === "control").slice(1, 4), [id, "edit", "Updated scope"]);
    await submit("U1");
    assert.equal(calls.filter(([kind]) => kind === "control").length, 1);
});

test("modal validation", async () => {
    for (const [channel, text] of [["C2", "Scope"], ["C1", "   "]]) {
        const { handlers, calls } = fixture({ status: "awaiting_input" });
        await handlers.view({ ack: async () => {}, body: { team: { id: "T1" }, user: { id: "U1" } },
            view: { private_metadata: JSON.stringify({ id, revision: 1, action: "reply", channel,
                messageTs: "101.001" }), state: { values: { research_input: { text: { value: text } } } } },
        });
        assert.equal(calls.some(([kind]) => kind === "control"), false);
    }
});
