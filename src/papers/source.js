import { gunzipSync } from "node:zlib";
import { Parser } from "tar";

const limit = 25 * 1024 * 1024;

export async function readSource(data) {
    const bytes = data[0] === 31 && data[1] === 139 ? gunzipSync(data, { maxOutputLength: limit }) : data;
    if (bytes.length > limit) throw Error("Expanded source exceeds size limit");
    if (bytes.subarray(0, 5).toString() === "%PDF-") throw Error("Source is PDF-only");
    const prefix = bytes.subarray(0, 4096).toString("utf8");
    if (!prefix.includes("\0") && /\\(?:documentclass|documentstyle|begin|input|def)\b/.test(prefix)) {
        return { files: [{ name: "main.tex", text: bytes.toString("utf8") }], figures: [] };
    }
    const files = [];
    const figures = [];
    let count = 0;
    let total = 0;
    await new Promise((resolve, reject) => {
        const parser = new Parser({ strict: true, onReadEntry(entry) {
            count++;
            if (count > 500 || entry.path.startsWith("/") || entry.path.includes("\\") ||
                entry.path.split("/").includes("..") || ["Link", "SymbolicLink"].includes(entry.type)) {
                parser.abort(Error("Unsafe source archive"));
                return;
            }
            const parts = [];
            const text = /\.(tex|bib|bbl)$/i.test(entry.path) && entry.type === "File";
            if (/\.(png|jpe?g|pdf|eps|svg|webp)$/i.test(entry.path)) figures.push(entry.path);
            entry.on("data", (part) => {
                total += part.length;
                if (total > limit) parser.abort(Error("Expanded source exceeds size limit"));
                if (text) parts.push(part);
            });
            entry.on("end", () => {
                if (text) files.push({ name: entry.path, text: Buffer.concat(parts).toString("utf8") });
            });
            entry.resume();
        } });
        parser.on("error", reject);
        parser.on("end", resolve);
        parser.end(bytes);
    });
    if (!files.some((file) => /\.tex$/i.test(file.name))) throw Error("No TeX source found");
    files.sort((a, b) => Number(/\\documentclass/.test(b.text)) - Number(/\\documentclass/.test(a.text)));
    return { files, figures };
}
