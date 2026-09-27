import test from "node:test";
import assert from "node:assert/strict";
import { chunks } from "../../src/shared/text.js";

test("Unicode chunks", () =>
    assert.equal(chunks("🙂".repeat(6000)).join(""), "🙂".repeat(6000)));
