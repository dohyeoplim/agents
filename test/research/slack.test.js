import test from "node:test";
import assert from "node:assert/strict";
import { createResearchSlack, renderResearch } from "../../src/research/slack.js";
import { researchText } from "../../src/research/copy.js";
import { researchActions } from "../../src/research/actions.js";
import { researchProgress } from "../../src/research/progress.js";

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
    ui.register({
        action: (pattern, fn) => { handlers.action = fn; handlers.actionPattern = pattern; },
        view: (_, fn) => { handlers.view = fn; },
    });
    function click(action = "start", body = {}, value = `${id}:1`) {
        assert.match(`research_${action}`, handlers.actionPattern);
        return handlers.action({ ack: async () => calls.push(["ack"]),
            body: { team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
                message: { ts: "101.001" }, trigger_id: "trigger", ...body },
            action: { action_id: `research_${action}`, value },
        });
    }
    return { job, data, calls, client, config, handlers, ui, click };
}

test("completion actions", () => {
    const { job } = fixture({ status: "completed", title: "<@U1>".repeat(100), brief: "x".repeat(9000) });
    const result = renderResearch(job);
    assert.deepEqual(result.blocks.at(-1).elements.map((button) => button.text.text),
        ["Research More", "Save to Canvas"]);
    assert.equal(result.blocks[0].text.type, "plain_text");
    assert.equal(result.blocks[0].text.text.length, 150);
    assert.equal(result.blocks[3].text.text.length, 2900);
});

test("limited actions", async () => {
    for (const action of ["continue", "finish", "summarize", "cancel"]) {
        const { job, click, calls } = fixture({ status: "limited", finishRequested: true });
        assert.deepEqual(researchActions(job), ["continue", "finish", "summarize", "cancel"]);
        const result = renderResearch(job);
        assert.deepEqual(result.blocks.at(-1).elements.map((button) => button.text.text),
            ["Continue", "Finish", "Summarize", "Cancel"]);
        assert.ok(result.blocks.some((block) => block.text?.text.includes("자동 실행 한도")));
        await click(action);
        assert.equal(calls.find(([kind]) => kind === "control")[2], action);
    }
});

test("scope actions", async () => {
    for (const status of ["paused", "interrupted", "failed"]) {
        for (const scope of [{ startedAt: 1 }, { reports: [{ stage: "explore" }] }]) {
            const { job, click, calls } = fixture({ status, ...scope });
            assert.deepEqual(researchActions(job), ["resume", "edit", "cancel"]);
            await click("edit");
            assert.equal(calls.some(([kind]) => kind === "open"), true);
        }
        assert.deepEqual(researchActions({ status }), ["resume", "edit", "cancel"]);
    }
    assert.equal(researchActions({ status: "running", startedAt: 1 }).includes("edit"), false);
});

test("finishing status", () => {
    const { job } = fixture({ status: "running", finishRequested: true });
    const result = renderResearch(job);
    assert.match(result.blocks[2].elements[0].text, /Finish requested/);
    assert.equal(researchActions(job).includes("finish"), false);
    assert.equal(researchActions(job).includes("pause"), true);
    assert.equal(researchActions(job).includes("cancel"), true);
    job.status = "completed";
    assert.doesNotMatch(renderResearch(job).blocks[2].elements[0].text, /Finish requested/);
});

test("round progress", async () => {
    const { job, data, ui, calls } = fixture({ round: 2, runId: "current", phaseStartedAt: 1000,
        reports: [{ stage: "clarify" }] });
    data.researchSources = { a: { researchId: id }, b: { researchId: "previous" } };
    data.tasks = {
        active: { researchId: id, researchRunId: "current", status: "running", provider: "codex",
            researchStage: "explore", startedAt: 1000 },
        previous: { researchId: id, researchRunId: "previous", status: "running" },
        done: { researchId: id, researchRunId: "current", status: "completed" },
    };
    const progress = researchProgress(job, data);
    assert.equal(progress.sources, 1);
    assert.equal(progress.reports, 1);
    assert.deepEqual(progress.activeTasks, [{ provider: "codex", stage: "explore", startedAt: 1000 }]);
    await ui.publish(job);
    const rendered = calls.find(([kind]) => kind === "update")[1].blocks[2].elements[0].text;
    assert.match(rendered, /Round 2 · Sources 1 · Reports 1/);
    assert.match(rendered, /1970-01-01T00:00:01.000Z/);
    assert.match(rendered, /codex · explore running/);
});

test("clarification actions", async () => {
    for (const action of ["status", "pause", "cancel"]) {
        const { job, click, calls } = fixture({ status: "clarifying" });
        assert.deepEqual(renderResearch(job).blocks.at(-1).elements.map((button) => button.text.text),
            ["Status", "Pause", "Cancel"]);
        await click(action);
        assert.equal(calls.find(([kind]) => kind === "control")[2], action);
    }
});

test("provider activity", () => {
    const { job, data } = fixture({ status: "running", runId: "current" });
    data.tasks = { task: { researchId: id, researchRunId: "current", status: "running", provider: "claude",
        researchStage: "counter", startedAt: 1000, lastActivityAt: 4000, providerEvents: 7 } };
    const progress = researchProgress(job, data);
    assert.equal(progress.activeTasks[0].lastActivityAt, 4000);
    assert.equal(progress.activeTasks[0].providerEvents, 7);
    const result = renderResearch({ ...job, progress }, 19000);
    assert.match(result.blocks[2].elements[0].text, /claude · counter · last event 15s ago/);
    data.tasks.task.researchRunId = "previous";
    assert.deepEqual(researchProgress(job, data).activeTasks, []);
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

test("deleted status", async () => {
    const { job, ui, client, calls, click } = fixture();
    const update = client.chat.update;
    client.chat.update = async (message) => {
        if (message.ts === "101.001") {
            job.status = "paused";
            job.revision = 2;
            throw Object.assign(Error("deleted"), { data: { error: "message_not_found" } });
        }
        return update(message);
    };
    await Promise.all([ui.publish(job), ui.publish(job)]);
    const posts = calls.filter(([kind]) => kind === "post");
    assert.equal(posts.length, 1);
    assert.match(posts[0][1].text, /paused/);
    assert.equal(posts[0][1].thread_ts, "100.001");
    assert.equal(job.messageTs, "102.001");
    assert.equal(calls.find(([kind]) => kind === "update")[1].ts, "102.001");
    await click("resume", { message: { ts: "102.001" } }, `${id}:2`);
    assert.equal(calls.find(([kind]) => kind === "control")[2], "resume");
});

test("update failure", async () => {
    for (const reason of ["ratelimited", "internal_error", "not_authed"]) {
        const { job, ui, client, calls } = fixture();
        const failure = Object.assign(Error(reason), { data: { error: reason } });
        client.chat.update = async () => { throw failure; };
        await assert.rejects(ui.publish(job), (error) => error === failure);
        assert.equal(calls.some(([kind]) => kind === "post"), false);
        assert.equal(job.messageTs, "101.001");
    }
});

test("replacement race", async () => {
    const { job, ui, client, calls } = fixture();
    client.chat.update = async () => {
        job.messageTs = "103.001";
        throw Object.assign(Error("deleted"), { data: { error: "message_not_found" } });
    };
    await ui.publish(job);
    assert.equal(calls.some(([kind]) => kind === "post"), false);
    assert.equal(job.messageTs, "103.001");
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
