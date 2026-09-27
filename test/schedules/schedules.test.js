import test from "node:test";
import assert from "node:assert/strict";
import { parseSchedule, addSchedule, changeSchedule, dispatchDue } from "../../src/schedules/schedules.js";

const now = Date.parse("2026-09-27T00:00:00Z");
const context = {
    team: "T1", user: "U1", channel: "C1", thread: "1.1", key: "T1:C1:1.1:assistant", profile: "assistant",
};
const config = { team: "T1", users: ["U1"], channels: { C1: { enabled: true } } };

test("schedule parsing", () => {
    assert.equal(parseSchedule("every 1h --on-change Review notes", now).nextRun, now + 3600000);
    assert.equal(parseSchedule("every 1h --on-change Review notes", now).prompt, "Review notes");
    const daily = parseSchedule("daily 09:00 Asia/Seoul Review tasks", now);
    assert.equal(daily.nextRun, now + 86400000);
    assert.equal(parseSchedule("at 2026-09-27T10:00:00+09:00 Review tasks", now).nextRun, now + 3600000);
    assert.throws(() => parseSchedule("every 0m hi", now));
    assert.throws(() => parseSchedule("daily 25:00 UTC hi", now));
    assert.throws(() => parseSchedule("at 2026-09-27T10:00:00 hi", now));
    assert.throws(() => parseSchedule("every 1h !schedule every 1m spam", now));
});

test("schedule deduplication", () => {
    const data = {};
    const id = addSchedule(data, context, "every 1m Check notes", now);
    assert.equal(dispatchDue(data, config, now + 60000), 1);
    assert.equal(dispatchDue(data, config, now + 60000), 0);
    assert.equal(dispatchDue(data, config, now + 120000), 0);
    assert.equal(Object.keys(data.tasks).length, 1);
    const task = Object.values(data.tasks)[0];
    task.status = "completed";
    assert.equal(dispatchDue(data, config, now + 180000), 1);
    assert.equal(data.schedules[id].nextRun, now + 240000);
});

test("schedule authorization", () => {
    const data = {};
    const id = addSchedule(data, context, "every 1m Check notes", now);
    assert.throws(() => changeSchedule(data, { ...context, user: "U2" }, id, "remove", now));
    changeSchedule(data, context, id.slice(0, 8), "pause", now);
    assert.equal(dispatchDue(data, config, now + 60000), 0);
    changeSchedule(data, context, id, "resume", now);
    assert.equal(dispatchDue(data, { ...config, channels: {} }, now + 60000), 0);
    assert.equal(data.schedules[id].enabled, false);
});
