import { realpath, readFile, writeFile, rename, mkdir } from "node:fs/promises";
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
            (route.model !== undefined && typeof route.model !== "string")
        )
            throw Error("Invalid route");
    }
    return config;
}

export async function confined(root, relative) {
    const base = await realpath(root);
    const full = await realpath(path.resolve(base, relative));
    if (full !== base && !full.startsWith(base + path.sep))
        throw Error("Workspace escape");
    return full;
}

export function routeEvent(config, body, event, bot, known) {
    const route = config.channels[event.channel];
    if (
        body.team_id !== config.team ||
        !route ||
        route.enabled === false ||
        !config.users.includes(event.user) ||
        event.bot_id ||
        event.subtype ||
        typeof event.text !== "string"
    )
        return null;
    const thread = event.thread_ts || event.ts;
    if (!/^\d+\.\d+$/.test(thread ?? "")) return null;
    const key = `${config.team}:${event.channel}:${thread}:${route.agent}`;
    const mentioned = event.text.includes(`<@${bot}>`);
    if (!mentioned && !(event.thread_ts && known(key))) return null;
    const prompt = event.text.replaceAll(`<@${bot}>`, "").trim();
    if (!prompt || prompt.length > 16000) return null;
    return {
        key,
        route,
        prompt,
        thread,
        eventId: `${event.channel}:${event.ts}`,
    };
}

export class SerialQueue {
    pending = 0;
    tail = Promise.resolve();
    run(fn) {
        if (this.pending >= 32) return Promise.reject(Error("Queue full"));
        this.pending++;
        const next = this.tail.then(fn);
        this.tail = next.catch(() => {}).finally(() => this.pending--);
        return next;
    }
}

export class Store {
    constructor(file) {
        this.file = file;
        this.data = { threads: {}, events: {} };
    }
    async load() {
        try {
            this.data = JSON.parse(await readFile(this.file, "utf8"));
        } catch (e) {
            if (e.code !== "ENOENT") throw e;
        }
    }
    async save() {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(this.file + ".tmp", JSON.stringify(this.data), {
            mode: 0o600,
        });
        await rename(this.file + ".tmp", this.file);
    }
}
export function chunks(text, size = 2800) {
    const chars = Array.from(text);
    return Array.from({ length: Math.ceil(chars.length / size) }, (_, i) =>
        chars.slice(i * size, (i + 1) * size).join(""),
    );
}
