import { realpath } from "node:fs/promises";
import path from "node:path";

export async function confined(root, relative) {
    const base = await realpath(root);
    const full = await realpath(path.resolve(base, relative));
    if (full !== base && !full.startsWith(base + path.sep))
        throw Error("Workspace escape");
    return full;
}
