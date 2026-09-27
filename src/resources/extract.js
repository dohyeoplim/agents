import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert } from "html-to-text";
import { slackFileIds } from "./identifiers.js";

export async function extractText(data, kind) {
    if (!Buffer.isBuffer(data) || data.length > 5 * 1024 * 1024) throw Error("File exceeds the 5 MB limit");
    let text;
    let truncated = false;
    let embedded = [];
    if (kind === "pdf") {
        if (data.subarray(0, 5).toString() !== "%PDF-") throw Error("Invalid PDF data");
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: new Uint8Array(data), isEvalSupported: false });
        try {
            const result = await parser.getText({ first: 100, pageJoiner: "" });
            text = result.text;
            truncated = result.total > 100;
        } finally {
            await parser.destroy();
        }
    } else if (kind === "html") {
        const html = data.toString("utf8");
        if (/<input[^>]+type=["']password["']/i.test(html)) throw Error("File requires sign-in");
        text = convert(html, {
            wordwrap: false,
            limits: { maxInputLength: 5 * 1024 * 1024 },
            selectors: ["script", "style", "img"].map((selector) => ({ selector, format: "skip" })),
        });
        embedded = slackFileIds(text).slice(0, 10);
    } else if (kind === "text") {
        text = data[0] === 0xff && data[1] === 0xfe ? data.subarray(2).toString("utf16le") : data.toString("utf8");
        if (text.includes("\0")) throw Error("Binary files are not supported");
        embedded = slackFileIds(text).slice(0, 10);
    } else throw Error("Supported formats: Canvas, PDF, HTML, Markdown and text");
    if (!text.trim()) throw Error("No readable text found. Scanned files require OCR");
    return { text: text.slice(0, 24000), truncated: truncated || text.length > 24000, embedded };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const parts = [];
        let size = 0;
        for await (const part of process.stdin) {
            size += part.length;
            if (size > 5 * 1024 * 1024) throw Error("File too large");
            parts.push(part);
        }
        const result = await extractText(Buffer.concat(parts), process.argv[2]);
        process.stdout.write(JSON.stringify(result) + "\n");
    } catch {
        process.stderr.write("Document extraction failed\n");
        process.exitCode = 1;
    }
}
