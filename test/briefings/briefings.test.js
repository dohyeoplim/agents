import test from "node:test";
import assert from "node:assert/strict";
import { queueBriefing } from "../../src/briefings/scheduler.js";
import { dayRange, createBriefingContext } from "../../src/briefings/context.js";
import { createDelivery } from "../../src/briefings/delivery.js";
import { formatBriefing } from "../../src/briefings/formatting.js";

const config = { team: "T1", users: ["U1"], channels: { C1: { name: "daily", agent: "assistant" } } };
const settings = { briefing: { status: "enabled", channel: "daily", time: "09:00", timezone: "UTC", language: "en" },
    reading: { confirmedInterests: [{ topic: "Test topic" }] } };

test("daily dispatch", () => {
    const data = { tasks: {} };
    queueBriefing(data, config, settings, Date.parse("2026-01-01T08:00:00Z"));
    assert.equal(Object.keys(data.tasks).length, 0);
    queueBriefing(data, config, settings, Date.parse("2026-01-01T09:00:01Z"));
    queueBriefing(data, config, settings, Date.parse("2026-01-01T09:00:02Z"));
    assert.equal(Object.keys(data.tasks).length, 1);
    assert.equal(Object.values(data.tasks)[0].briefingDate, "2026-01-01");
    assert.equal(Object.values(data.tasks)[0].thread, undefined);
    settings.briefing.status = "paused";
    queueBriefing(data, config, settings, Date.parse("2026-01-02T09:00:01Z"));
    assert.equal(Object.keys(data.tasks).length, 1);
    settings.briefing.status = "enabled";
});

test("calendar day", () => {
    const range = dayRange("2026-11-01", "America/New_York");
    assert.equal(Date.parse(range.to) - Date.parse(range.from), 25 * 3600000);
});

test("partial briefing", async () => {
    const prepare = createBriefingContext({ personal: async () => settings, tools: { call: async (name) => {
        if (name === "calendar_events") throw Error("Provider not configured: google-token.json");
        return name === "papers_search" ? { papers: [] } : { current: {}, hours: [] };
    } } });
    const result = JSON.parse(await prepare({ briefingDate: "2026-01-01" }, new AbortController().signal));
    assert.equal(result.calendar.unavailable, true);
    assert.equal(result.calendar.reason, "not_connected");
    assert.ok(!JSON.stringify(result).includes("google-token.json"));
    assert.deepEqual(result.preferences.reading.confirmedInterests, [{ topic: "Test topic" }]);
    assert.deepEqual(result.papers.papers, []);
});

test("briefing spacing", () => {
    assert.equal(formatBriefing("## Briefing\nIntro\n### Weather\nSunny"),
        "## Briefing\n\nIntro\n\n### Weather\n\nSunny");
    assert.equal(formatBriefing("```\n# code\nvalue\n```"), "```\n# code\nvalue\n```");
});

test("briefing thread", async () => {
    const task = { id: "task", key: "briefing", team: "T1", user: "U1", channel: "C1", briefingDate: "2026-01-01" };
    const data = { tasks: { task: {} }, threads: { briefing: { session: "session" } } };
    let posts = 0;
    const deliver = createDelivery({ state: { snapshot: () => structuredClone(data), update: async (fn) => fn(data) },
        config: async () => config, post: async () => { posts++; return { ts: "100.001" }; }, streams: {} });
    await deliver(task, "Paper https://arxiv.org/abs/2401.12345v1");
    await deliver(task, "Paper https://arxiv.org/abs/2401.12345v1");
    assert.equal(posts, 1);
    assert.equal(data.threads["T1:C1:100.001:assistant"].session, "session");
    assert.ok(data.briefingSeen["T1:U1"]["2401.12345"]);
});
