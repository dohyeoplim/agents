import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { paperId } from "./arxiv.js";
import { readSource } from "./source.js";
import { readDocument } from "../resources/reader.js";
import { addEntry, visibleEntries } from "../knowledge/memory.js";
import { SerialQueue } from "../shared/queue.js";

export function createLibrary({ root = "/state/library", arxiv, state }) {
    const queue = new SerialQueue();
    const filename = (id) => path.join(root, Buffer.from(paperId(id)).toString("base64url") + ".json");
    async function saved(id) {
        try { return JSON.parse(await readFile(filename(id), "utf8")); }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
    }
    function manifest(document) {
        return { paper: document.paper, format: document.format, notices: document.notices,
            files: document.files.map((file) => ({ name: file.name, characters: file.text.length })),
            figures: document.figures, instruction: "Use papers_read for the contents; this is only a file listing." };
    }
    async function fetch(id, signal) {
        const [paper] = await arxiv.search({ ids: [paperId(id)], limit: 1 }, signal);
        if (!paper) throw Error("Paper not found");
        const existing = await saved(paper.id);
        if (existing) return manifest(existing);
        return queue.run(async () => {
            const repeated = await saved(paper.id);
            if (repeated) return manifest(repeated);
            await mkdir(root, { recursive: true, mode: 0o700 });
            if ((await readdir(root)).filter((name) => name.endsWith(".json")).length >= 100) {
                throw Error("Paper library is full");
            }
            let source;
            let document;
            try {
                source = await arxiv.source(paper.id, signal);
                document = { ...await readSource(source), format: "tex", notices: [] };
            } catch {
                signal?.throwIfAborted();
                const pdf = await arxiv.pdf(paper.id, signal);
                const extracted = await readDocument(pdf, "pdf", signal);
                source = pdf;
                document = { format: "pdf", files: [{ name: "paper.txt", text: extracted.text }], figures: [],
                    notices: ["TeX source unavailable; using PDF text", ...(extracted.truncated ?
                        ["PDF extraction was truncated; do not claim to have read the full paper"] : [])] };
            }
            signal?.throwIfAborted();
            const record = { paper, ...document, downloadedAt: new Date().toISOString() };
            const file = filename(paper.id);
            await writeFile(file + ".source", source, { mode: 0o600 });
            await writeFile(file + ".tmp", JSON.stringify(record), { mode: 0o600 });
            await rename(file + ".tmp", file);
            return manifest(record);
        });
    }
    async function read({ id, file, offset = 0 }) {
        const document = await saved(id);
        if (!document) throw Error("Download the paper with papers_fetch first, then use its versioned ID");
        if (!file) return manifest(document);
        const selected = document.files.find((item) => item.name === file);
        if (!selected) throw Error("File not found in paper manifest");
        if (offset > selected.text.length) throw Error("Offset exceeds file size");
        const end = Math.min(offset + 16000, selected.text.length);
        return { id: document.paper.id, source: document.paper.url, file, offset, total: selected.text.length,
            text: selected.text.slice(offset, end), nextOffset: end < selected.text.length ? end : null };
    }
    async function note(context, { id, text, status }) {
        const document = await saved(id);
        if (!document) throw Error("Download the paper before saving a reading note");
        return state.update((data) => {
            const entry = addEntry(data, context, { kind: "note", scope: "shared",
                title: document.paper.title.slice(0, 200), text: `${document.paper.url}\n${status}\n${text}` });
            data.entries[entry].paperId = document.paper.id;
            data.entries[entry].readingStatus = status;
            return { saved: true, entryId: entry, paperId: document.paper.id, status };
        });
    }
    function search(context, query) {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        return visibleEntries(state.snapshot(), context).filter((entry) => entry.paperId &&
            terms.every((term) => `${entry.title} ${entry.text}`.toLowerCase().includes(term)))
            .slice(-20).reverse().map((entry) => ({ id: entry.id, paperId: entry.paperId, title: entry.title,
                status: entry.readingStatus, text: entry.text.slice(0, 2000) }));
    }
    return { fetch, read, note, search };
}
