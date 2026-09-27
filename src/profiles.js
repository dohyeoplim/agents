import { readFile } from "node:fs/promises";

export function profileFor(route) {
    if (route.profile) return route.profile;
    if (["research", "reading", "coursework", "writing"].includes(route.name)) return "scholar";
    return route.name === "lab" ? "engineer" : "assistant";
}

export function validateProfiles(profiles) {
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) throw Error("Invalid profiles");
    for (const [id, profile] of Object.entries(profiles)) {
        if (!/^[a-z][a-z0-9-]*$/.test(id) || !profile || typeof profile !== "object") {
            throw Error("Invalid profile");
        }
        if (typeof profile.name !== "string" || typeof profile.instructions !== "string" ||
            profile.instructions.length > 8000 || !["read-only", "workspace-write"].includes(profile.sandbox) ||
            typeof profile.networkAccess !== "boolean" ||
            !["disabled", "cached", "live"].includes(profile.webSearch) ||
            !Number.isInteger(profile.timeoutSeconds) || profile.timeoutSeconds < 10 || profile.timeoutSeconds > 600 ||
            (profile.model !== undefined && typeof profile.model !== "string")) {
            throw Error("Invalid profile policy");
        }
        for (const field of ["skills", "delegates"]) {
            if (!Array.isArray(profile[field]) || profile[field].some((item) =>
                typeof item !== "string" || !/^[a-z][a-z0-9-]*$/.test(item))) throw Error("Invalid profile list");
        }
    }
    for (const profile of Object.values(profiles)) {
        if (profile.delegates.some((id) => !Object.hasOwn(profiles, id))) throw Error("Unknown delegate profile");
    }
    return profiles;
}

export async function loadProfiles(file = "/config/profiles.json") {
    return validateProfiles(JSON.parse(await readFile(file, "utf8")));
}

export function resolveProfile(profiles, route, requested) {
    const origin = profileFor(route);
    if (!Object.hasOwn(profiles, origin)) throw Error("Unknown channel profile");
    const id = requested || origin;
    if (!Object.hasOwn(profiles, id) || (id !== origin && !profiles[origin].delegates.includes(id))) {
        throw Error("Profile delegation is not allowed");
    }
    return { id, ...profiles[id] };
}
