import test from "node:test";
import assert from "node:assert/strict";
import { SerialQueue } from "../../src/shared/queue.js";

test("queue recovery", async () => {
    const q = new SerialQueue();
    const order = [];
    const a = q.run(async () => {
        await new Promise((r) => setTimeout(r, 15));
        order.push(1);
        throw Error("expected");
    });
    const b = q.run(async () => order.push(2));
    await assert.rejects(a);
    await b;
    assert.deepEqual(order, [1, 2]);
});
