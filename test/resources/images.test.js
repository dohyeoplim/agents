import test from "node:test";
import assert from "node:assert/strict";
import { imageInput, validateImages } from "../../src/resources/images.js";
import { createSlackResources } from "../../src/resources/slack.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
    "base64");

test("image validation", () => {
    assert.deepEqual(validateImages([imageInput(png)]), ["data:image/png;base64," + png.toString("base64")]);
    assert.throws(() => imageInput(Buffer.from("<html>login</html>")));
    assert.throws(() => imageInput(Buffer.alloc(6 * 1024 * 1024)));
    assert.throws(() => validateImages(["https://external.example/image.png"]));
    assert.throws(() => validateImages(["data:image/jpeg;base64," + png.toString("base64")]));
});

test("Slack images", async () => {
    const resources = createSlackResources({ token: "secret", request: async (url) => {
        if (url.startsWith("https://files.slack.com/")) return new Response(png);
        return Response.json({ ok: true, file: { id: "F123456", channels: ["C1"], mimetype: "image/png",
            url_private: "https://files.slack.com/image.png" } });
    } });
    const result = await resources.collect({ channel: "C1", prompt: "Describe this", fileIds: ["F123456"] });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0], imageInput(png));
    assert.ok(!result.images[0].includes("secret"));
    await assert.rejects(resources.read("C2", "F123456"));
});
