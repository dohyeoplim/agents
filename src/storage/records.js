import { z } from "zod";

const text = "text";
const number = "bigint";
const boolean = "boolean";
const field = (name, column, type = text) => ({ name, column, type });
const ownership = [field("team", "team_id"), field("user", "user_id"), field("channel", "channel_id")];

export const records = {
    threads: { table: "conversations", fields: [field("owner", "owner_id"), field("title", "title"),
        field("session", "session_id"), field("profile", "profile")] },
    events: { table: "received_events", scalar: true, fields: [field("value", "received_at_ms", number)] },
    tasks: { table: "executions", archive: true, fields: [...ownership, field("thread", "thread_ts"),
        field("key", "conversation_id"), field("profile", "profile"), field("prompt", "prompt"),
        field("answer", "answer"), field("status", "status"), field("delivery", "delivery"),
        field("createdAt", "created_at_ms", number), field("startedAt", "started_at_ms", number),
        field("finishedAt", "finished_at_ms", number), field("scheduleId", "schedule_id")] },
    entries: { table: "knowledge_entries", fields: [...ownership, field("thread", "thread_ts"),
        field("kind", "kind"), field("scope", "scope"), field("profile", "profile"), field("title", "title"),
        field("text", "body"), field("createdAt", "created_at"), field("paperId", "paper_id")] },
    schedules: { table: "schedules", fields: [...ownership, field("thread", "thread_ts"),
        field("prompt", "prompt"), field("enabled", "enabled", boolean), field("nextRun", "next_run_ms", number),
        field("createdAt", "created_at_ms", number)] },
    inbox: { table: "inbox", archive: true, fields: [...ownership, field("thread", "thread_ts"),
        field("key", "conversation_id"), field("prompt", "prompt"), field("text", "body"),
        field("messageTs", "message_ts"), field("response", "response"), field("taskId", "execution_id"),
        field("delivery", "delivery"), field("status", "status"), field("createdAt", "created_at_ms", number)] },
    artifacts: { table: "artifacts", fields: [field("hash", "content_hash"), field("path", "storage_path"),
        field("mime", "mime_type"), field("size", "size_bytes", number)] },
    canvasBindings: { table: "canvas_bindings", version: 2, fields: [...ownership, field("canvasId", "canvas_id"),
        field("purpose", "purpose"), field("title", "title"), field("updatedAt", "updated_at_ms", number)] },
    canvasReads: { table: "canvas_reads", version: 2, fields: [...ownership, field("canvasId", "canvas_id"),
        field("revision", "revision"), field("createdAt", "created_at_ms", number)] },
    canvasChanges: { table: "canvas_changes", version: 2, fields: [...ownership, field("canvasId", "canvas_id"),
        field("taskId", "execution_id"), field("status", "status"), field("createdAt", "created_at_ms", number)] },
    briefingSeen: { table: "briefing_history", fields: [] },
    researchJobs: { table: "research_jobs", version: 3, fields: [...ownership, field("thread", "thread_ts"),
        field("key", "conversation_id"), field("status", "status"), field("title", "title"),
        field("createdAt", "created_at_ms", number), field("updatedAt", "updated_at_ms", number)] },
    researchSources: { table: "research_sources", version: 3, fields: [...ownership,
        field("researchId", "research_id"), field("title", "title"), field("url", "url"),
        field("updatedAt", "updated_at_ms", number)] },
};

const object = z.record(z.string(), z.unknown());
const maps = Object.fromEntries(Object.keys(records).map((name) => [name,
    z.record(z.string().min(1), name === "events" ? z.number().int().safe() : object).optional()]));
const stateSchema = z.object({ ...maps, briefing: object.optional() }).strict();

export function validateState(data) {
    stateSchema.parse(data);
    for (const [name, record] of Object.entries(records)) {
        if (record.scalar) continue;
        for (const value of Object.values(data[name] || {})) {
            for (const { name: key, type } of record.fields) {
                if (value[key] === undefined || value[key] === null) continue;
                const valid = type === number ? Number.isSafeInteger(value[key]) :
                    typeof value[key] === (type === boolean ? "boolean" : "string");
                if (!valid) throw Error(`Invalid ${name}.${key}`);
            }
        }
    }
    return data;
}

export function encodeRecord(record, value) {
    const extra = record.scalar ? { value } : { ...value };
    const values = record.fields.map(({ name }) => extra[name] ?? null);
    const absent = record.fields.filter(({ name }) => extra[name] === undefined).map(({ name }) => name);
    for (const { name } of record.fields) delete extra[name];
    return [...values, JSON.stringify(extra), absent];
}

export function decodeRecord(record, row) {
    const value = { ...row.extra };
    for (const { name, column, type } of record.fields) {
        if (row.absent.includes(name)) continue;
        value[name] = row[column] !== null && type === number ? Number(row[column]) : row[column];
    }
    return record.scalar ? value.value : value;
}
