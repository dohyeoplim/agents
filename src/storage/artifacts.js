import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const digest = (data) => createHash("sha256").update(data).digest("hex");

async function publish(path, data) {
    const temporary = path + "." + randomUUID() + ".tmp";
    const handle = await open(temporary, "wx", 0o600);
    try {
        try {
            await handle.writeFile(data);
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await link(temporary, path);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            if (!(await readFile(path)).equals(Buffer.from(data))) throw Error("Artifact integrity check failed");
        }
    } finally {
        await unlink(temporary);
    }
}

function normalizeSource(source) {
    if (!source || !["slack", "research"].includes(source.provider)) throw Error("Invalid artifact source");
    const result = { provider: source.provider };
    for (const field of ["channel", "fileId", "version", "kind"]) {
        const value = source[field];
        if (typeof value !== "string" || !value.length || value.length > 1024 || /[\x00-\x1f]/.test(value)) {
            throw Error("Invalid artifact source " + field);
        }
        result[field] = value;
    }
    if (source.title !== undefined) {
        if (typeof source.title !== "string" || source.title.length > 4096) throw Error("Invalid artifact title");
        result.title = source.title;
    }
    return result;
}

export function createArtifactStore({ directory }) {
    if (typeof directory !== "string" || !directory.trim()) throw Error("Artifact directory is required");
    const root = resolve(directory);

    async function put(data, { mime, source }) {
        if (!Buffer.isBuffer(data) && typeof data !== "string") throw Error("Invalid artifact content");
        if (typeof mime !== "string" || !/^[a-z\d][\w.+-]*\/[a-z\d][\w.+-]*$/i.test(mime) || mime.length > 128) {
            throw Error("Invalid artifact MIME type");
        }
        const origin = normalizeSource(source);
        const bytes = Buffer.from(data);
        const hash = digest(bytes);
        const path = join("blobs", hash.slice(0, 2), hash);
        const metadata = { hash, path, mime, size: bytes.length, source: origin };
        const id = digest(JSON.stringify(metadata));
        const result = { id, ...metadata };
        const blobDirectory = join(root, "blobs", hash.slice(0, 2));
        const manifestDirectory = join(root, "manifests");
        await mkdir(blobDirectory, { recursive: true, mode: 0o700 });
        await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
        await publish(join(root, path), bytes);
        await publish(join(manifestDirectory, id + ".json"), JSON.stringify(result) + "\n");
        for (const directory of [blobDirectory, manifestDirectory]) {
            const handle = await open(directory, "r");
            try { await handle.sync(); } finally { await handle.close(); }
        }
        return result;
    }

    async function get(id) {
        if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw Error("Invalid artifact ID");
        const manifest = JSON.parse(await readFile(join(root, "manifests", id + ".json"), "utf8"));
        const { hash, path, mime, size, source } = manifest;
        if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) ||
            path !== join("blobs", hash.slice(0, 2), hash) || !Number.isSafeInteger(size) || size < 0 ||
            typeof mime !== "string" || !/^[a-z\d][\w.+-]*\/[a-z\d][\w.+-]*$/i.test(mime)) {
            throw Error("Artifact integrity check failed");
        }
        const metadata = { hash, path, mime, size, source: normalizeSource(source) };
        if (manifest.id !== id || digest(JSON.stringify(metadata)) !== id) {
            throw Error("Artifact integrity check failed");
        }
        const data = await readFile(join(root, path));
        if (data.length !== size || digest(data) !== hash) throw Error("Artifact integrity check failed");
        return { id, ...metadata, data };
    }

    return { put, get };
}
