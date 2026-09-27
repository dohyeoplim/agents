import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class PersistentState {
    constructor(file, initial) {
        this.file = file;
        this.data = structuredClone(initial);
        this.tail = Promise.resolve();
    }

    async load() {
        try {
            const loaded = JSON.parse(await readFile(this.file, "utf8"));
            if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) throw Error("Invalid saved state");
            this.data = { ...this.data, ...loaded };
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        return this;
    }

    snapshot() {
        return structuredClone(this.data);
    }

    update(change) {
        const next = this.tail.then(async () => {
            const draft = this.snapshot();
            const result = change(draft);
            if (result instanceof Promise) throw Error("State changes must be synchronous");
            await mkdir(path.dirname(this.file), { recursive: true });
            await writeFile(this.file + ".tmp", JSON.stringify(draft), { mode: 0o600 });
            await rename(this.file + ".tmp", this.file);
            this.data = draft;
            return structuredClone(result);
        });
        this.tail = next.catch(() => {});
        return next;
    }
}
