import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";

export async function runtimeHome(root) {
    const base = path.resolve(root);
    const home = path.join(base, "bridge-runtime");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(path.join(base, "sessions"), { recursive: true, mode: 0o700 });
    for (const name of ["auth.json", "sessions"]) {
        try { await symlink(path.join(base, name), path.join(home, name)); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    return home;
}
