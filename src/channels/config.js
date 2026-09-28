import { readFile, writeFile, rename, mkdir, realpath, lstat, unlink } from "node:fs/promises";
import path from "node:path";

export function validate(config) {
    if (
        !config ||
        typeof config !== "object" ||
        typeof config.team !== "string" ||
        !/^T[A-Z0-9]+$/.test(config.team) ||
        !Array.isArray(config.users) ||
        !config.users.length ||
        config.users.some(
            (user) => typeof user !== "string" || !/^[UW][A-Z0-9]+$/.test(user),
        ) ||
        !config.channels ||
        typeof config.channels !== "object" ||
        Array.isArray(config.channels)
    )
        throw Error("Team, users and channels are required");
    for (const [id, route] of Object.entries(config.channels)) {
        if (
            !/^[CG][A-Z0-9]+$/.test(id) ||
            !route ||
            typeof route !== "object" ||
            typeof route.agent !== "string" ||
            !/^[a-z][a-z0-9-]*$/.test(route.agent) ||
            typeof route.cwd !== "string" ||
            !route.cwd ||
            path.isAbsolute(route.cwd) ||
            route.cwd.split("/").some((part) => part === ".." || !part) ||
            (route.name !== undefined &&
                (typeof route.name !== "string" ||
                    !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(route.name))) ||
            (route.enabled !== undefined &&
                typeof route.enabled !== "boolean") ||
            (route.instructions !== undefined &&
                (typeof route.instructions !== "string" ||
                    route.instructions.length > 8000)) ||
            (route.model !== undefined && typeof route.model !== "string") ||
            (route.profile !== undefined &&
                (typeof route.profile !== "string" || !/^[a-z][a-z0-9-]*$/.test(route.profile)))
        )
            throw Error("Invalid route");
    }
    return config;
}

export async function loadConfig(file = "/config/routes.json", automatic = process.env.AUTO_CHANNELS_FILE) {
    const config = validate(JSON.parse(await readFile(file, "utf8")));
    if (!automatic) return config;
    let saved;
    try {
        saved = JSON.parse(await readFile(automatic, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return config;
        throw error;
    }
    if (saved.team !== config.team) throw Error("Automatic channel workspace mismatch");
    validate({ ...config, channels: saved.channels });
    return validate({ ...config, channels: { ...saved.channels, ...config.channels } });
}

async function prepareDirectories(config, root) {
    const base = await realpath(root);
    for (const route of Object.values(config.channels)) {
        let current = base;
        for (const part of ["data", route.agent, "workspace", ...route.cwd.split("/")]) {
            if (part === ".") continue;
            current = path.join(current, part);
            try {
                await mkdir(current);
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
            }
            const info = await lstat(current);
            if (info.isSymbolicLink() || !info.isDirectory()) throw Error("Workspace path must be a directory");
        }
    }
}

export async function saveConfig(config, file, root) {
    validate(config);
    await prepareDirectories(config, root);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(config, null, 4) + "\n", { mode: 0o644, flag: "wx" });
        await rename(temporary, file);
    } finally {
        await unlink(temporary).catch((error) => {
            if (error.code !== "ENOENT") throw error;
        });
    }
}
