import { randomUUID } from "node:crypto";

export function visibleEntries(data, context) {
    return Object.values(data.entries || {}).filter((entry) =>
        entry.team === context.team && entry.user === context.user &&
        (entry.scope === "shared" ||
            (entry.scope === "profile" && entry.profile === context.profile) ||
            (entry.scope === "channel" && entry.channel === context.channel)));
}

export function addEntry(data, context, { kind, scope, title = "", text }) {
    if (!["memory", "note"].includes(kind) || !["shared", "profile", "channel"].includes(scope) ||
        typeof text !== "string" || !text.trim() || text.length > (kind === "memory" ? 1000 : 8000) ||
        typeof title !== "string" || title.length > 200) throw Error("Invalid knowledge entry");
    data.entries ??= {};
    if (Object.keys(data.entries).length >= 1000) throw Error("Knowledge storage is full");
    const matching = visibleEntries(data, context).filter((entry) => entry.kind === "memory");
    if (kind === "memory" && matching.reduce((sum, entry) => sum + entry.text.length, 0) + text.length > 10000) {
        throw Error("Memory is full. Remove outdated entries before adding more");
    }
    const id = randomUUID();
    data.entries[id] = {
        id, kind, scope, title, text: text.trim(), team: context.team, user: context.user,
        profile: context.profile, channel: context.channel, thread: context.thread,
        createdAt: new Date().toISOString(),
    };
    return id;
}

export function forgetEntry(data, context, id) {
    if (!visibleEntries(data, context).some((entry) => entry.id === id)) throw Error("Entry not found");
    delete data.entries[id];
}

export function searchEntries(data, context, query, limit = 5) {
    const terms = [...new Set(query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])];
    if (!terms.length) return [];
    return visibleEntries(data, context).map((entry) => {
        const text = `${entry.title} ${entry.text}`.normalize("NFKC").toLowerCase();
        return { entry, score: terms.reduce((score, term) => score + Number(text.includes(term)), 0) };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score)
        .slice(0, limit).map((item) => item.entry);
}

export function knowledgeContext(data, context, query) {
    const memory = visibleEntries(data, context).filter((entry) => entry.kind === "memory")
        .map((entry) => ({ id: entry.id, text: entry.text, scope: entry.scope }));
    const notes = searchEntries(data, context, query).filter((entry) => entry.kind === "note")
        .map((entry) => ({
            id: entry.id, title: entry.title, text: entry.text.slice(0, 1600),
            channel: entry.channel, thread: entry.thread, date: entry.createdAt,
        }));
    return JSON.stringify({ memory, notes }).slice(0, 20000);
}
