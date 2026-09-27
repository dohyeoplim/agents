import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../src/channels/config.js";
import { routeEvent } from "../../src/slack/routing.js";

const config = validate({
    team: "T1",
    users: ["U1"],
    channels: { C1: { agent: "assistant", cwd: "project" } },
});
const event = {
    channel: "C1",
    user: "U1",
    ts: "123.456",
    text: "<@BOT> hello",
};

test("message routing", () => {
    const select = (e, team = "T1", known = () => false) =>
        routeEvent(config, { team_id: team }, e, "BOT", known);
    assert.equal(select(event).prompt, "hello");
    for (const e of [
        { ...event, user: "U2" },
        { ...event, channel: "C2" },
        { ...event, bot_id: "B1" },
        { ...event, subtype: "message_changed" },
        { ...event, text: "ordinary chat" },
    ])
        assert.equal(select(e), null);
    assert.equal(select(event, "T2"), null);
    assert.ok(
        select(
            { ...event, thread_ts: "120.000", text: "follow up" },
            "T1",
            () => true,
        ),
    );
    assert.equal(
        select({ ...event, thread_ts: "120.000", text: "follow up" }),
        null,
    );
});
