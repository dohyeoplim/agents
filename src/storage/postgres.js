import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { records, encodeRecord, decodeRecord, validateState } from "./records.js";

const lockId = 714238905;
const schemaVersion = 4;

export class PostgresState {
    constructor({ initial = {}, legacyFile, connection = {} } = {}) {
        this.data = validateState(structuredClone(initial));
        this.legacyFile = legacyFile;
        this.client = new pg.Client({ connectionTimeoutMillis: 10000, statement_timeout: 30000, ...connection });
        this.tail = Promise.resolve();
        this.closed = false;
        this.closing = false;
        this.failure = null;
        this.client.on("error", () => { this.failure = Error("Database connection lost; restart the gateway"); });
    }

    async load() {
        try {
            await this.client.connect();
            const lock = await this.client.query("SELECT pg_try_advisory_lock($1) AS acquired", [lockId]);
            if (!lock.rows[0].acquired) throw Error("Another gateway owns this database");
            await this.client.query("BEGIN");
            await this.migrate();
            const imported = await this.client.query("SELECT value FROM storage_meta WHERE key = 'initialized'");
            if (!imported.rowCount) {
                let data = this.snapshot();
                if (this.legacyFile) {
                    try {
                        const legacy = JSON.parse(await readFile(this.legacyFile, "utf8"));
                        data = { ...data, ...validateState(legacy) };
                    } catch (error) {
                        if (error.code !== "ENOENT") throw error;
                    }
                }
                await this.persist({}, validateState(data));
                await this.client.query("INSERT INTO storage_meta(key, value) VALUES ('initialized', $1)",
                    [JSON.stringify({ at: new Date().toISOString(), legacyFile: this.legacyFile || null })]);
            }
            const loaded = {};
            for (const [name, record] of Object.entries(records)) {
                const result = await this.client.query(
                    `SELECT * FROM ${record.table} WHERE NOT archived ORDER BY position`);
                loaded[name] = Object.fromEntries(result.rows.map((row) => [row.id, decodeRecord(record, row)]));
            }
            const briefing = await this.client.query("SELECT value FROM storage_meta WHERE key = 'briefing'");
            if (briefing.rowCount) loaded.briefing = briefing.rows[0].value;
            await this.client.query("COMMIT");
            this.data = validateState(loaded);
            return this;
        } catch (error) {
            await this.client.query("ROLLBACK").catch(() => {});
            await this.client.end().catch(() => {});
            this.closed = true;
            throw error;
        }
    }

    async migrate() {
        await this.client.query("CREATE TABLE IF NOT EXISTS storage_meta (key text PRIMARY KEY, value jsonb NOT NULL)");
        const version = await this.client.query("SELECT value FROM storage_meta WHERE key = 'schema_version'");
        const previous = version.rowCount ? version.rows[0].value : 0;
        if (!Number.isInteger(previous) || previous < 0 || previous > schemaVersion) {
            throw Error("Unsupported database schema");
        }
        if (previous === schemaVersion) return;
        for (const record of Object.values(records)) {
            if ((record.version || 1) <= previous) continue;
            const fields = record.fields.map(({ column, type }) => `${column} ${type}`).join(", ");
            await this.client.query(`CREATE TABLE ${record.table} (
                id text PRIMARY KEY, position bigint GENERATED ALWAYS AS IDENTITY,
                ${fields ? fields + "," : ""} extra jsonb NOT NULL DEFAULT '{}', absent text[] NOT NULL DEFAULT '{}',
                archived boolean NOT NULL DEFAULT false)`);
        }
        if (previous < 1) await this.client.query(`
            CREATE INDEX executions_pending ON executions(status, created_at_ms) WHERE NOT archived;
            CREATE INDEX executions_owner ON executions(team_id, user_id, channel_id);
            CREATE INDEX knowledge_owner ON knowledge_entries(team_id, user_id, scope);
            CREATE INDEX schedules_due ON schedules(next_run_ms) WHERE enabled;
            CREATE INDEX inbox_pending ON inbox(status) WHERE NOT archived;
            CREATE INDEX artifacts_hash ON artifacts(content_hash);
        `);
        await this.client.query(`INSERT INTO storage_meta(key, value) VALUES ('schema_version', $1)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [JSON.stringify(schemaVersion)]);
    }

    snapshot() {
        return structuredClone(this.data);
    }

    async healthy() {
        if (this.closed || this.closing || this.failure) return false;
        try {
            await this.client.query("SELECT 1");
            return !this.failure;
        } catch { return false; }
    }

    async persist(previous, next) {
        for (const [name, record] of Object.entries(records)) {
            const before = previous[name] || {};
            const after = next[name] || {};
            for (const id of Object.keys(before)) {
                if (Object.hasOwn(after, id)) continue;
                await this.client.query(record.archive ? `UPDATE ${record.table} SET archived = true WHERE id = $1` :
                    `DELETE FROM ${record.table} WHERE id = $1`, [id]);
            }
            const columns = ["id", ...record.fields.map(({ column }) => column), "extra", "absent"];
            const placeholders = columns.map((_, index) => "$" + (index + 1));
            const assignments = columns.slice(1).map((column) => `${column} = EXCLUDED.${column}`);
            for (const [id, value] of Object.entries(after)) {
                if (isDeepStrictEqual(before[id], value)) continue;
                await this.client.query(`INSERT INTO ${record.table} (${columns.join(", ")})
                    VALUES (${placeholders.join(", ")}) ON CONFLICT (id) DO UPDATE
                    SET ${assignments.join(", ")}, archived = false`, [id, ...encodeRecord(record, value)]);
            }
        }
        if (!isDeepStrictEqual(previous.briefing, next.briefing)) {
            if (next.briefing === undefined) await this.client.query("DELETE FROM storage_meta WHERE key = 'briefing'");
            else await this.client.query(`INSERT INTO storage_meta(key, value) VALUES ('briefing', $1)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next.briefing)]);
        }
    }

    update(change) {
        if (this.closed || this.closing) return Promise.reject(Error("Database is closed"));
        const next = this.tail.then(async () => {
            if (this.closed || this.failure) throw this.failure || Error("Database is closed");
            const draft = this.snapshot();
            const result = change(draft);
            if (result instanceof Promise) throw Error("State changes must be synchronous");
            const saved = validateState(JSON.parse(JSON.stringify(draft)));
            const output = structuredClone(result);
            try {
                await this.client.query("BEGIN");
                await this.persist(this.data, saved);
                await this.client.query("COMMIT");
            } catch (error) {
                await this.client.query("ROLLBACK").catch(() => {});
                this.failure = Error("Database write failed; restart the gateway");
                throw error;
            }
            this.data = saved;
            return output;
        });
        this.tail = next.catch(() => {});
        return next;
    }

    async close() {
        this.closing = true;
        await this.tail;
        this.closed = true;
        await this.client.end();
    }
}
