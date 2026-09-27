import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { confined } from "../../src/shared/paths.js";
import { validate } from "../../src/channels/config.js";

const config = validate({
    team: "T1",
    users: ["U1"],
    channels: { C1: { agent: "assistant", cwd: "project" } },
});

test("path confinement", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(path.join(dir, "root"));
    await mkdir(path.join(dir, "outside"));
    await symlink(path.join(dir, "outside"), path.join(dir, "root", "link"));
    await assert.rejects(confined(path.join(dir, "root"), "link"));
    await assert.rejects(confined(path.join(dir, "root"), "../outside"));
    assert.equal(
        await confined(path.join(dir, "root"), "."),
        await (
            await import("node:fs/promises")
        ).realpath(path.join(dir, "root")),
    );
    assert.throws(() =>
        validate({
            ...config,
            channels: { C1: { agent: "assistant", cwd: "../escape" } },
        }),
    );
});
