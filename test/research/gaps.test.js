import test from "node:test";
import assert from "node:assert/strict";
import { reconcileGaps } from "../../src/research/gaps.js";
import { researchOutput } from "../../src/research/output.js";

test("stable identity", () => {
    const knownGaps = [{ id: "g1", text: "Measure latency" }];
    const result = reconcileGaps({ gaps: ["Missing runtime measurements"], gapIds: ["g1"] }, knownGaps);
    assert.deepEqual(result, { knownGaps, newGaps: [] });
    assert.notEqual(result.knownGaps, knownGaps);
});

test("legacy identity", () => {
    const knownGaps = [{ id: "g1", text: "Measure latency" }];
    const result = reconcileGaps({ gaps: ["  MEASURE   latency  ", "Measure accuracy"] }, knownGaps);
    assert.deepEqual(result.newGaps, ["Measure accuracy"]);
    assert.deepEqual(result.knownGaps[1], { id: "g2", text: "Measure accuracy" });
    assert.equal(knownGaps.length, 1);
});

test("issued identities", () => {
    const result = reconcileGaps({ gaps: ["Measure accuracy", "Measure memory"], gapIds: ["g999", "g999"] },
        [{ id: "g2", text: "Measure latency" }]);
    assert.deepEqual(result.knownGaps.map((gap) => gap.id), ["g2", "g3", "g4"]);
    assert.deepEqual(result.newGaps, ["Measure accuracy", "Measure memory"]);
    assert.deepEqual(reconcileGaps({ gaps: ["Measure latency", "Measure memory"], gapIds: [null, "g1"] })
        .newGaps, ["Measure latency", "Measure memory"]);
});

test("duplicate questions", () => {
    const result = reconcileGaps({ gaps: ["Measure latency", "measure LATENCY", " "] });
    assert.deepEqual(result.newGaps, ["Measure latency"]);
    assert.deepEqual(result.knownGaps, [{ id: "g1", text: "Measure latency" }]);
});

test("review identities", () => {
    const review = { verdict: "needs_research", feedback: [], gaps: ["Measure latency"] };
    assert.deepEqual(researchOutput(JSON.stringify(review), "review"), review);
    for (const gapIds of [[null], ["g1"]]) {
        assert.deepEqual(researchOutput(JSON.stringify({ ...review, gapIds }), "review").gapIds, gapIds);
    }
    for (const gapIds of [[], ["g1", "g2"], ["invented"], ["g0"]]) {
        assert.throws(() => researchOutput(JSON.stringify({ ...review, gapIds }), "review"), /Invalid review/);
    }
});
