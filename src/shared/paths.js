import { realpath, mkdir, lstat } from "node:fs/promises";
import path from "node:path";

export async function confined(root, relative, create = false) {
    const base = await realpath(root);
    if (create) {
        if (path.isAbsolute(relative) || relative.split("/").some((part) => part === ".." || !part)) {
            throw Error("Workspace escape");
        }
        let current = base;
        for (const part of relative.split("/")) {
            current = path.join(current, part);
            try { await mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
            const info = await lstat(current);
            if (info.isSymbolicLink() || !info.isDirectory()) throw Error("Workspace escape");
        }
    }
    const full = await realpath(path.resolve(base, relative));
    if (full !== base && !full.startsWith(base + path.sep))
        throw Error("Workspace escape");
    return full;
}
