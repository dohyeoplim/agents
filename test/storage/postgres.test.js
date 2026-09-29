import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { PostgresState } from "../../src/storage/postgres.js";

const connectionString = process.env.TEST_DATABASE_URL;

async function database(t) {
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const schema = "test_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    t.after(async () => {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
    });
    const connection = { connectionString, options: "-c search_path=" + schema };
    const stores = [];
    t.after(async () => {
        for (const store of stores) if (!store.closed) await store.close();
    });
    const store = (options = {}) => {
        const result = new PostgresState({ connection, ...options });
        stores.push(result);
        return result;
    };
    const query = (text, values) => admin.query(text.replaceAll("test_schema", schema), values);
    return { store, query };
}

test("PostgreSQL storage", { skip: !connectionString }, async (t) => {
    await t.test("legacy import", async (t) => {
        const { store, query } = await database(t);
        const directory = await mkdtemp(path.join(os.tmpdir(), "agents-import-"));
        t.after(() => rm(directory, { force: true, recursive: true }));
        const legacyFile = path.join(directory, "conversations.json");
        const legacy = {
            threads: { thread: { session: null, sessions: { assistant: "session" }, owner: "U1" } },
            tasks: { run: { id: "run", team: "T1", user: "U1", status: "running", prompt: "한국어 작업",
                delivery: "none", createdAt: 1000, weatherAttribution: { name: "weather" } } },
            entries: { memory: { id: "memory", text: "선호", kind: "memory", scope: "shared" } },
            events: { message: 1234 }, schedules: { schedule: { enabled: true, nextRun: null } },
            briefing: { nextRun: 4000 }, briefingSeen: { owner: { paper: 5678 } },
        };
        await writeFile(legacyFile, JSON.stringify(legacy));
        const first = await store({ legacyFile }).load();
        assert.deepEqual(first.snapshot(), { ...legacy, inbox: {}, artifacts: {},
            canvasBindings: {}, canvasReads: {}, canvasChanges: {}, researchJobs: {}, researchSources: {},
            autoresearchJobs: {} });
        assert.equal((await query("SELECT prompt FROM test_schema.executions")).rows[0].prompt, "한국어 작업");
        await first.update((data) => { data.entries.memory.text = "수정된 선호"; });
        await first.close();
        const second = await store({ legacyFile }).load();
        assert.equal(second.snapshot().entries.memory.text, "수정된 선호");
        assert.deepEqual(JSON.parse(await readFile(legacyFile, "utf8")), legacy);
    });

    await t.test("import rollback", async (t) => {
        const { store, query } = await database(t);
        const directory = await mkdtemp(path.join(os.tmpdir(), "agents-invalid-"));
        t.after(() => rm(directory, { force: true, recursive: true }));
        const legacyFile = path.join(directory, "state.json");
        await writeFile(legacyFile, JSON.stringify({ entries: [], unexpected: {} }));
        await assert.rejects(store({ legacyFile }).load());
        assert.equal((await query("SELECT to_regclass('test_schema.storage_meta') AS table_name"))
            .rows[0].table_name, null);
        await writeFile(legacyFile, JSON.stringify({ entries: {} }));
        await store({ legacyFile }).load();
    });

    await t.test("Canvas migration", async (t) => {
        const { store, query } = await database(t);
        const first = await store().load();
        await first.update((data) => {
            data.threads.thread = { owner: "U1", title: "Coursework", session: "session" };
            data.tasks.task = { status: "completed", prompt: "Study", answer: "Notes", createdAt: 1000 };
            data.entries.memory = { text: "Explain with examples", scope: "shared" };
        });
        const existing = first.snapshot();
        await first.close();
        await query(`DROP TABLE test_schema.canvas_bindings, test_schema.canvas_reads, test_schema.canvas_changes`);
        await query(`DROP TABLE test_schema.research_jobs, test_schema.research_sources`);
        await query("DROP TABLE test_schema.autoresearch_jobs");
        await query("UPDATE test_schema.storage_meta SET value = '1' WHERE key = 'schema_version'");
        const table = await query("SELECT 'test_schema.executions'::regclass::oid AS oid");
        const migrated = await store().load();
        assert.deepEqual(migrated.snapshot(), existing);
        assert.equal((await query("SELECT 'test_schema.executions'::regclass::oid AS oid")).rows[0].oid,
            table.rows[0].oid);
        assert.equal((await query("SELECT value FROM test_schema.storage_meta WHERE key = 'schema_version'"))
            .rows[0].value, 4);
        const ownership = { team: "T1", user: "U1", channel: "C1", canvasId: "F1" };
        const binding = { ...ownership, purpose: "coursework", title: "Study notes", updatedAt: 2000 };
        const read = { ...ownership, revision: "sha256", createdAt: 2100, title: "Study notes", text: "Notes",
            sections: [{ id: "section:1", text: "Notes" }], artifacts: [{ id: "artifact" }], taskId: "task" };
        const change = { ...ownership, taskId: "task", status: "completed", createdAt: 2200,
            operation: { type: "insert_at_end", text: "Example" }, beforeReadId: "read", result: { ok: true } };
        await migrated.update((data) => {
            data.canvasBindings.binding = binding;
            data.canvasReads.read = read;
            data.canvasChanges.change = change;
        });
        await migrated.close();
        const reopened = await store().load();
        assert.deepEqual(reopened.snapshot(), { ...existing, canvasBindings: { binding },
            canvasReads: { read }, canvasChanges: { change } });
    });

    await t.test("gateway ownership", async (t) => {
        const { store } = await database(t);
        const first = await store().load();
        await assert.rejects(store().load(), /Another gateway/);
        await Promise.all(Array.from({ length: 12 }, (_, index) => first.update((data) => {
            data.events["event-" + index] = index;
        })));
        await first.close();
        const second = await store().load();
        assert.equal(Object.keys(second.snapshot().events).length, 12);
    });

    await t.test("research migration", async (t) => {
        const { store, query } = await database(t);
        const first = await store().load();
        await first.update((data) => { data.canvasBindings.canvas = { title: "Existing", canvasId: "F1" }; });
        await first.close();
        await query("DROP TABLE test_schema.research_jobs, test_schema.research_sources");
        await query("DROP TABLE test_schema.autoresearch_jobs");
        await query("UPDATE test_schema.storage_meta SET value = '2' WHERE key = 'schema_version'");
        const migrated = await store().load();
        assert.equal(migrated.snapshot().canvasBindings.canvas.title, "Existing");
        const job = { team: "T", user: "U", channel: "C", thread: "1.000001", status: "running",
            runId: "run", createdAt: 1000, reports: [{ id: "report" }], finishRequested: true,
            checkpoint: { version: 2, reports: { synthesize: "report" }, sourcesBefore: 3,
                gaps: [], feedback: [] } };
        const source = { team: "T", user: "U", channel: "C", researchId: "job", title: "Evidence",
            url: "https://example.com", coverage: "excerpt", artifactId: "artifact", updatedAt: 2000 };
        await migrated.update((data) => {
            data.researchJobs.job = job;
            data.researchSources.source = source;
        });
        await migrated.close();
        const reopened = await store().load();
        assert.deepEqual(reopened.snapshot().researchJobs.job, job);
        assert.deepEqual(reopened.snapshot().researchSources.source, source);
        assert.equal((await query("SELECT value FROM test_schema.storage_meta WHERE key = 'schema_version'"))
            .rows[0].value, 4);
    });

    await t.test("autoresearch migration", async (t) => {
        const { store, query } = await database(t);
        const first = await store().load();
        const research = { team: "T", user: "U", channel: "C", status: "completed",
            checkpoint: { version: 2, reports: { synthesize: "report" } }, reports: [{ id: "report" }] };
        await first.update((data) => { data.researchJobs.research = research; });
        await first.close();
        await query("DROP TABLE test_schema.autoresearch_jobs");
        await query("UPDATE test_schema.storage_meta SET value = '3' WHERE key = 'schema_version'");
        const table = await query("SELECT 'test_schema.research_jobs'::regclass::oid AS oid");
        const migrated = await store().load();
        assert.deepEqual(migrated.snapshot().researchJobs.research, research);
        assert.deepEqual(migrated.snapshot().autoresearchJobs, {});
        assert.equal((await query("SELECT 'test_schema.research_jobs'::regclass::oid AS oid")).rows[0].oid,
            table.rows[0].oid);
        assert.equal((await query("SELECT value FROM test_schema.storage_meta WHERE key = 'schema_version'"))
            .rows[0].value, 4);
        const job = { id: "experiment", team: "T", user: "U", channel: "C", thread: "1.000001",
            key: "T:C:1.000001", status: "ready", title: "Quantization", createdAt: 1000, updatedAt: 2000,
            revision: 2, plan: { objective: "Reduce memory", metric: "accuracy", gpuHours: 32 },
            manifestId: "artifact", hash: "sha256", mode: "campaign", executionDeadline: 999999,
            campaign: { objective: "Discover ideas", maxSteps: 24 },
            campaignState: { steps: 3, commands: 1, gpuSeconds: 120, history: [],
                pending: { args: { id: randomUUID(), command: "nvidia-smi", timeoutSeconds: 30 }, submitted: true } } };
        await migrated.update((data) => { data.autoresearchJobs[job.id] = job; });
        await migrated.close();
        const reopened = await store().load();
        assert.deepEqual(reopened.snapshot().autoresearchJobs[job.id], job);
        assert.deepEqual(reopened.snapshot().researchJobs.research, research);
        const persisted = (await query("SELECT * FROM test_schema.autoresearch_jobs")).rows[0];
        assert.equal(persisted.status, "ready");
        assert.deepEqual(persisted.extra.plan, job.plan);
        assert.equal(persisted.extra.manifestId, job.manifestId);
        assert.equal(persisted.extra.hash, job.hash);
        assert.equal(persisted.extra.revision, job.revision);
    });

    await t.test("transaction rollback", async (t) => {
        const { store, query } = await database(t);
        const first = await store().load();
        await first.update((data) => { data.inbox.message = { status: "pending" }; });
        await query("ALTER TABLE test_schema.executions ADD CHECK (status <> 'invalid')");
        await assert.rejects(first.update((data) => {
            data.inbox.message.status = "processed";
            data.tasks.task = { status: "invalid", prompt: "do not commit" };
            data.threads.thread = { title: "do not commit" };
        }));
        assert.equal(first.snapshot().inbox.message.status, "pending");
        assert.ok(first.failure);
        await first.close();
        const second = await store().load();
        assert.equal(second.snapshot().inbox.message.status, "pending");
        assert.deepEqual(second.snapshot().tasks, {});
        assert.deepEqual(second.snapshot().threads, {});
    });

    await t.test("archive retention", async (t) => {
        const { store, query } = await database(t);
        const first = await store().load();
        await first.update((data) => {
            data.tasks.task = { status: "completed", answer: "result" };
            data.inbox.message = { status: "processed", text: "original" };
            data.entries.memory = { text: "forget me" };
        });
        await first.update((data) => {
            delete data.tasks.task;
            delete data.inbox.message;
            delete data.entries.memory;
        });
        await first.close();
        const second = await store().load();
        assert.deepEqual(second.snapshot().tasks, {});
        assert.deepEqual(second.snapshot().inbox, {});
        assert.equal((await query("SELECT answer FROM test_schema.executions WHERE archived")).rows[0].answer,
            "result");
        assert.equal((await query("SELECT body FROM test_schema.inbox WHERE archived")).rows[0].body, "original");
        assert.equal((await query("SELECT * FROM test_schema.knowledge_entries")).rowCount, 0);
    });

    await t.test("storage shutdown", async (t) => {
        const { store } = await database(t);
        const first = await store().load();
        await assert.rejects(first.update((data) => { data.events.bad = 1.5; }));
        const writing = first.update((data) => { data.events.valid = 1000; });
        const closing = first.close();
        await assert.rejects(first.update(() => {}), /closed/);
        await writing;
        await closing;
        const second = await store().load();
        assert.deepEqual(second.snapshot().events, { valid: 1000 });
    });
});
