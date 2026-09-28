import { readFile } from "node:fs/promises";
import { z } from "zod";

const copy = z.record(z.string(), z.string()).parse(JSON.parse(
    await readFile(new URL("./copy.json", import.meta.url), "utf8")));

export function researchText(key, values = {}) {
    if (!Object.hasOwn(copy, key)) throw Error("Unknown research text key");
    return copy[key].replace(/\{\{([a-zA-Z_][a-zA-Z_0-9]*)\}\}/g, (_, name) => {
        if (!Object.hasOwn(values, name)) throw Error("Unknown research text placeholder");
        return String(values[name]);
    });
}
