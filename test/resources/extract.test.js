import test from "node:test";
import assert from "node:assert/strict";
import { extractText } from "../../src/resources/extract.js";
import { readDocument } from "../../src/resources/reader.js";
import { slackFileIds } from "../../src/resources/identifiers.js";

function pdfFixture() {
    const stream = "BT /F1 12 Tf 50 100 Td (Hello PDF) Tj ET";
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] " +
        "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let text = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(text));
        text += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(text);
    text += "xref\n0 6\n0000000000 65535 f \n";
    text += offsets.slice(1).map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("");
    text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(text);
}

test("Canvas text", async () => {
    const result = await extractText(Buffer.from(
        '<h1>Project</h1><p>Useful note</p><script>secret</script>' +
        '<a href="https://example.slack.com/files/U123/F123456/paper.pdf">Paper</a>',
    ), "html");
    assert.ok(result.text.includes("Useful note"));
    assert.ok(!result.text.includes("secret"));
    assert.deepEqual(result.embedded, ["F123456"]);
});

test("PDF text", async () => {
    const result = await extractText(pdfFixture(), "pdf");
    assert.ok(result.text.includes("Hello PDF"));
    assert.equal(result.truncated, false);
});

test("reader process", async () => {
    const result = await readDocument(Buffer.from("Readable content"), "text");
    assert.equal(result.text, "Readable content");
    await assert.rejects(readDocument(Buffer.from("invalid"), "pdf"));
});

test("file limits", async () => {
    await assert.rejects(extractText(Buffer.alloc(5 * 1024 * 1024 + 1), "text"));
    await assert.rejects(extractText(Buffer.from([0, 1, 2]), "text"));
    await assert.rejects(extractText(Buffer.from("<input type='password'>"), "html"));
});

test("Slack links", () => {
    assert.deepEqual(slackFileIds('<https://example.slack.com/docs/T123/F123456|Canvas>'), ["F123456"]);
    assert.deepEqual(slackFileIds("https://external.example/docs/F123456"), []);
});
