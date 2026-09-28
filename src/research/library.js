import { createHash } from "node:crypto";
import { z } from "zod";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const artifactId = z.string().regex(/^[a-f0-9]{64}$/);
const offset = z.number().int().min(0).max(2000000).default(0);
export const sourceInput = z.object({
    url: z.url().max(4096).refine((value) => {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    }),
    title: z.string().trim().min(1).max(500),
    text: z.string().min(1).max(80000),
    coverage: z.enum(["snippet", "excerpt", "full_text"]),
    locator: z.string().max(1000).optional(),
    claim: z.string().max(2000).optional(),
}).strict();
export const sourcesInput = z.object({ query: z.string().max(300).default(""),
    limit: z.number().int().min(1).max(20).default(10),
    offset: z.number().int().min(0).max(1000000).default(0) }).strict();
export const sourceReadInput = z.object({ id: artifactId, offset }).strict();

function owned(job, context) {
    return job && ["team", "user", "channel"].every((key) => job[key] === context[key]);
}

function visible(record, context) {
    return !["explore", "counter"].includes(context.researchStage) || record.provider === context.provider;
}

function authorize(data, context, writing = false) {
    const job = data.researchJobs?.[context.researchId];
    if (!owned(job, context)) throw Error("Research is unavailable in this task");
    if (writing && (!["clarifying", "running"].includes(job.status) ||
        (job.runId && job.runId !== context.researchRunId))) throw Error("Research run is no longer active");
    return job;
}

function chunk(text, start) {
    if (start > text.length) throw Error("Offset exceeds saved content");
    const end = Math.min(start + 8000, text.length);
    return { text: text.slice(start, end), offset: start, length: text.length,
        nextOffset: end < text.length ? end : null };
}

export function createResearchLibrary({ state, artifacts }) {
    async function save(input, context) {
        const args = sourceInput.parse(input);
        authorize(state.snapshot(), context, true);
        const url = new URL(args.url);
        url.hash = "";
        const provider = context.provider === "claude" ? "claude" : "codex";
        const identity = { researchId: context.researchId, researchRunId: context.researchRunId,
            researchStage: context.researchStage, provider, ...args, url: url.href };
        const id = hash(JSON.stringify(identity));
        const artifact = await artifacts.put(args.text, { mime: "text/plain", source: {
            provider: "research", channel: context.channel, fileId: id, version: hash(args.text),
            kind: "source", title: args.title,
        } });
        return state.update((data) => {
            authorize(data, context, true);
            data.researchSources ||= {};
            if (data.researchSources[id]) return data.researchSources[id];
            const { text, ...metadata } = identity;
            const source = { id, ...metadata, team: context.team, user: context.user, channel: context.channel,
                artifactId: artifact.id, contentHash: artifact.hash, excerpt: text.slice(0, 1000),
                length: text.length, updatedAt: Date.now() };
            data.researchSources[id] = source;
            return source;
        });
    }

    function search(input, context) {
        const { query, limit, offset } = sourcesInput.parse(input);
        const data = state.snapshot();
        const job = authorize(data, context);
        const needle = query.toLowerCase();
        const matches = Object.values(data.researchSources || {}).filter((source) =>
            source.researchId === context.researchId && owned(source, context) && visible(source, context) &&
            [source.title, source.url, source.claim, source.locator, source.excerpt]
                .some((value) => value?.toLowerCase().includes(needle)))
            .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
        const end = offset + limit;
        return { sources: matches.slice(offset, end), offset,
            nextOffset: end < matches.length ? end : null,
            reports: (job.reports || []).filter((item) => visible(item, context)),
            total: matches.length, truncated: end < matches.length,
            coverage: "Current research only. Matches titles, URLs, claims, locators and first 1000 text characters." };
    }

    async function read(input, context) {
        const { id, offset } = sourceReadInput.parse(input);
        const data = state.snapshot();
        authorize(data, context);
        const source = data.researchSources?.[id];
        if (!owned(source, context) || source.researchId !== context.researchId || !visible(source, context)) {
            throw Error("Research source is unavailable");
        }
        const artifact = await artifacts.get(source.artifactId);
        if (artifact.source.provider !== "research" || artifact.source.fileId !== id ||
            artifact.source.channel !== context.channel || artifact.source.kind !== "source") {
            throw Error("Research source integrity check failed");
        }
        return { ...source, ...chunk(artifact.data.toString("utf8"), offset) };
    }

    async function saveReport(job, stage, text, { provider = ["counter", "review"].includes(stage) ?
        "claude" : "codex" } = {}) {
        z.string().min(1).max(100).parse(stage);
        z.string().min(1).max(2000000).parse(text);
        z.enum(["codex", "claude"]).parse(provider);
        const context = { ...job, researchId: job.id, researchRunId: job.runId };
        authorize(state.snapshot(), context, true);
        const artifact = await artifacts.put(text, { mime: "text/plain", source: {
            provider: "research", channel: job.channel, fileId: job.id,
            version: hash(JSON.stringify({ text, runId: job.runId, provider })), kind: stage,
        } });
        return state.update((data) => {
            const current = authorize(data, context, true);
            current.reports ||= [];
            const existing = current.reports.find((report) => report.id === artifact.id);
            if (existing) return existing;
            const report = { id: artifact.id, artifactId: artifact.id, stage, provider, runId: job.runId,
                length: text.length,
                createdAt: Date.now() };
            current.reports.push(report);
            return report;
        });
    }

    async function readReport(job, reportId, start = 0) {
        const { id, offset } = sourceReadInput.parse({ id: reportId, offset: start });
        const current = authorize(state.snapshot(), { ...job, researchId: job.id });
        const report = current.reports?.find((report) => report.id === id);
        if (!report) throw Error("Research report is unavailable");
        const artifact = await artifacts.get(report.artifactId);
        if (artifact.source.provider !== "research" || artifact.source.fileId !== job.id ||
            artifact.source.channel !== job.channel || artifact.source.kind !== report.stage) {
            throw Error("Research report integrity check failed");
        }
        return { ...report, ...chunk(artifact.data.toString("utf8"), offset) };
    }

    async function report(args, context) {
        const job = authorize(state.snapshot(), context);
        if (!job.reports?.some((item) => item.id === args.id && visible(item, context))) {
            throw Error("Research report is unavailable");
        }
        return readReport({ ...job, id: context.researchId }, args.id, args.offset);
    }

    return { save, search, read, saveReport, readReport, report };
}
