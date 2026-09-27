import { XMLParser } from "fast-xml-parser";
import { setTimeout as delay } from "node:timers/promises";
import { fetchBytes } from "../integrations/http.js";
import { SerialQueue } from "../shared/queue.js";

export function paperId(value) {
    if (typeof value !== "string") throw Error("Invalid arXiv ID");
    const id = value.replace(/^https:\/\/(?:www\.)?arxiv.org\/(?:abs|pdf|src)\//, "").replace(/\.pdf$/, "");
    if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v[1-9]\d*)?$/.test(id)) {
        throw Error("Use an arXiv ID or arxiv.org paper link");
    }
    return id;
}

export function parseFeed(xml) {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error("Unsupported XML declaration");
    const data = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(xml);
    if (!data.feed || typeof data.feed !== "object") throw Error("Invalid arXiv feed");
    const entries = data.feed?.entry || [];
    return (Array.isArray(entries) ? entries : [entries]).map((entry) => {
        const id = paperId(String(entry.id).replace(/^http:/, "https:"));
        const authors = Array.isArray(entry.author) ? entry.author : [entry.author];
        const categories = Array.isArray(entry.category) ? entry.category : [entry.category];
        return { id, title: String(entry.title || "").replace(/\s+/g, " ").trim(),
            abstract: String(entry.summary || "").replace(/\s+/g, " ").trim(),
            authors: authors.filter(Boolean).map((author) => author.name),
            categories: categories.filter(Boolean).map((category) => category["@_term"]),
            published: entry.published, updated: entry.updated, url: "https://arxiv.org/abs/" + id };
    });
}

export function createArxiv({ request = fetch, now = Date.now, interval = 3100 } = {}) {
    const queue = new SerialQueue();
    const cache = new Map();
    let last = -Infinity;
    const get = (url, signal, limit) => queue.run(async () => {
        const wait = interval - (now() - last);
        if (wait > 0) await delay(wait, undefined, { signal });
        signal?.throwIfAborted();
        last = now();
        return fetchBytes(url, { request, signal, limit, hosts: ["arxiv.org", "www.arxiv.org", "export.arxiv.org"] });
    });
    async function search({ query, days = 7, limit = 15, ids }, signal) {
        if (!ids && (typeof query !== "string" || !query.trim())) throw Error("Provide an arXiv search query");
        const params = new URLSearchParams({ max_results: String(limit), sortBy: "submittedDate",
            sortOrder: "descending" });
        if (ids) params.set("id_list", ids.map(paperId).join(","));
        else {
            const from = new Date(now() - days * 86400000).toISOString().slice(0, 10).replaceAll("-", "") + "0000";
            const to = new Date(now()).toISOString().slice(0, 10).replaceAll("-", "") + "2359";
            params.set("search_query", `(${query}) AND submittedDate:[${from} TO ${to}]`);
        }
        const url = "https://export.arxiv.org/api/query?" + params;
        const cached = cache.get(url);
        if (cached?.until > now()) return cached.items;
        const items = parseFeed((await get(url, signal, 2 * 1024 * 1024)).toString("utf8"));
        cache.set(url, { items, until: now() + 3600000 });
        if (cache.size > 100) cache.delete(cache.keys().next().value);
        return items;
    }
    return { search, source: (id, signal) => get("https://arxiv.org/src/" + paperId(id), signal, 12 * 1024 * 1024),
        pdf: (id, signal) => get("https://arxiv.org/pdf/" + paperId(id), signal, 5 * 1024 * 1024) };
}
