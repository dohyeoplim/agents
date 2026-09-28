import { createHash } from "node:crypto";
import { isFileId, slackFileIds, fileKind, fileChannels } from "./identifiers.js";
import { readDocument } from "./reader.js";
import { imageInput, imageType } from "./images.js";

const maxBytes = 5 * 1024 * 1024;
const fileHosts = new Set(["files.slack.com", "files-origin.slack.com"]);

export function isCanvasFile(file) {
    return ["canvas", "quip"].includes(file.filetype) || file.mimetype === "application/vnd.slack-docs";
}

export function flattenBookmarks(bookmarks, parentId = null) {
    const result = [];
    for (const item of bookmarks) {
        result.push({ ...item, parent_id: item.parent_id || parentId });
        const children = item.children || item.bookmarks;
        if (Array.isArray(children)) result.push(...flattenBookmarks(children, item.id));
    }
    return result;
}

export function createSlackResources({ token, request = fetch, extract = readDocument, artifacts }) {
    const catalogs = new Map();
    const texts = new Map();

    async function call(method, params, signal) {
        const response = await request("https://slack.com/api/" + method + "?" + new URLSearchParams(params), {
            headers: { Authorization: "Bearer " + token },
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]),
        });
        if (!response.ok) throw Error("Slack resource request failed");
        const result = await response.json();
        if (!result.ok) throw Error("Slack resource unavailable: " + String(result.error || "unknown").slice(0, 60));
        return result;
    }

    async function catalog(channel, { refresh = false, signal } = {}) {
        const cached = catalogs.get(channel);
        if (!refresh && cached?.until > Date.now()) return cached.value;
        const items = [];
        const notices = [];
        let folders = [];
        try {
            const result = await call("bookmarks.list", { channel_id: channel }, signal);
            const bookmarks = flattenBookmarks(result.bookmarks || []);
            folders = bookmarks.filter((item) => item.type === "folder").map((item) => ({
                id: item.id, title: item.title || "Folder",
                children: bookmarks.filter((child) => child.parent_id === item.id).length,
            }));
            for (const item of bookmarks) {
                if (item.type === "folder") continue;
                const id = isFileId(item.entity_id) ? item.entity_id : slackFileIds(item.link || "")[0];
                if (id) items.push({ id, title: item.title || id, url: item.link, parentId: item.parent_id });
                else if (item.link) {
                    items.push({ title: item.title || "External link", url: item.link, external: true });
                }
            }
        } catch (error) {
            notices.push(error.message);
        }
        try {
            for (let page = 1; page <= 5; page++) {
                const result = await call("files.list", { channel, count: "20", page }, signal);
                for (const file of result.files || []) {
                    if (isFileId(file.id) && fileKind(file)) {
                        items.push({ id: file.id, title: file.title || file.name, url: file.permalink,
                            kind: fileKind(file) });
                    }
                }
                if (!result.paging?.pages || page >= result.paging.pages) break;
                if (page === 5) notices.push("Channel discovery is limited to the first 100 files");
            }
        } catch (error) {
            notices.push(error.message);
        }
        const merged = new Map();
        for (const item of items) {
            const id = item.id || item.url;
            merged.set(id, { ...merged.get(id), ...item });
        }
        const unique = [...merged.values()];
        const value = { items: unique, folders, notices: [...new Set(notices)] };
        catalogs.set(channel, { value, until: Date.now() + (notices.length ? 0 : 30000) });
        if (catalogs.size > 50) catalogs.delete(catalogs.keys().next().value);
        return value;
    }

    async function download(value, signal) {
        let url = new URL(value);
        for (let attempt = 0; attempt < 4; attempt++) {
            if (url.protocol !== "https:" || !fileHosts.has(url.hostname) || url.username || url.password ||
                (url.port && url.port !== "443")) throw Error("Untrusted file download URL");
            const response = await request(url.href, {
                headers: { Authorization: "Bearer " + token }, redirect: "manual",
                signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
            });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get("location");
                await response.body?.cancel();
                if (!location) throw Error("Invalid file redirect");
                url = new URL(location, url);
                continue;
            }
            if (!response.ok) throw Error("Slack file download failed");
            if (Number(response.headers.get("content-length")) > maxBytes) {
                await response.body?.cancel();
                throw Error("File exceeds the 5 MB limit");
            }
            const parts = [];
            let size = 0;
            for await (const part of response.body) {
                size += part.length;
                if (size > maxBytes) throw Error("File exceeds the 5 MB limit");
                parts.push(part);
            }
            return Buffer.concat(parts);
        }
        throw Error("Too many file redirects");
    }

    async function read(channel, id, signal, { fresh = false, canvasOnly = false } = {}) {
        if (!isFileId(id)) throw Error("Invalid Slack file ID");
        const { file } = await call("files.info", { file: id }, signal);
        if (!file || file.id !== id || !fileChannels(file).has(channel)) {
            throw Error("Share the file with this channel before reading it");
        }
        if (file.is_external) throw Error("External files need access to their original provider");
        if (canvasOnly && !isCanvasFile(file)) throw Error("The selected file is not a Slack Canvas");
        const kind = fileKind(file);
        if (!kind) throw Error("Supported formats: Canvas, PDF, HTML, Markdown, text, PNG, JPEG and WebP");
        if (file.size > maxBytes) throw Error("File exceeds the 5 MB limit");
        const version = JSON.stringify([id, file.updated, file.edit_timestamp, file.size]);
        const source = { provider: "slack", channel, fileId: id, version, kind: "original",
            title: file.title || file.name || id };
        if (kind === "image") {
            const url = file.url_private_download || file.url_private;
            if (!url) throw Error("Slack did not provide a readable file URL");
            const data = await download(url, signal);
            const mime = imageType(data);
            const saved = artifacts ? [await artifacts.put(data, { mime, source })] : [];
            return { id, title: file.title || file.name || id, url: file.permalink,
                text: "Attached image provided to the model.", image: imageInput(data),
                embedded: [], truncated: false, ...(artifacts ? { artifacts: saved } : {}) };
        }
        const title = file.title || file.name || id;
        const cacheKey = JSON.stringify([channel, version, title]);
        let parsed = fresh ? undefined : texts.get(cacheKey);
        if (!parsed || parsed.until <= Date.now()) {
            const url = file.url_private_download || file.url_private;
            if (!url) throw Error("Slack did not provide a readable file URL");
            const data = await download(url, signal);
            const revision = createHash("sha256").update(JSON.stringify(title)).update("\0").update(data).digest("hex");
            const saved = [];
            if (artifacts) {
                const mime = { pdf: "application/pdf", html: "text/html", text: "text/plain" }[kind];
                saved.push(await artifacts.put(data, { mime: mime || "application/octet-stream", source }));
            }
            const result = await extract(data, kind, signal);
            if (artifacts) {
                saved.push(await artifacts.put(result.text, {
                    mime: "text/plain", source: { ...source, kind: "extracted" },
                }));
            }
            parsed = { ...result, revision, artifacts: saved, until: Date.now() + 60000 };
            texts.set(cacheKey, parsed);
            if (texts.size > 50) texts.delete(texts.keys().next().value);
        }
        return {
            id, title, url: file.permalink, revision: parsed.revision,
            text: parsed.text, truncated: parsed.truncated, embedded: parsed.embedded || [],
            ...(artifacts ? { artifacts: parsed.artifacts } : {}),
        };
    }

    async function collect(task, signal) {
        const budget = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
        const available = await catalog(task.channel, { signal: budget });
        const terms = (task.prompt.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).slice(0, 30);
        const ranked = available.items.filter((item) => item.id && item.kind !== "image").map((item) => ({
            ...item,
            score: terms.reduce((sum, term) => sum + Number((item.title || "").toLowerCase().includes(term)), 0),
        })).sort((a, b) => b.score - a.score);
        const queue = [...new Set([
            ...(task.fileIds || []), ...slackFileIds(task.prompt), ...ranked.map((item) => item.id),
        ])];
        const sources = [];
        const notices = [...available.notices];
        if (available.items.some((item) => item.external)) {
            notices.push("External bookmark links were not read. They may require separate provider access.");
        }
        const seen = new Set();
        while (queue.length && seen.size < 4) {
            const id = queue.shift();
            if (seen.has(id)) continue;
            seen.add(id);
            if (signal?.aborted) throw Error("Resource reading cancelled");
            if (budget.aborted) { notices.push("Resource reading timed out"); break; }
            try {
                const source = await read(task.channel, id, budget);
                sources.push(source);
                queue.unshift(...source.embedded.filter((embedded) => !seen.has(embedded)));
            } catch (error) {
                notices.push(id + ": " + error.message);
            }
        }
        if (queue.length) notices.push("Only four source files are read per request. Use !read to choose a file");
        const images = [];
        for (const source of sources) {
            if (!source.image) continue;
            images.push(source.image);
            source.text = `Attached image ${images.length} is provided to the model.`;
        }
        return { sources, notices, images };
    }

    return { catalog, read, collect };
}
