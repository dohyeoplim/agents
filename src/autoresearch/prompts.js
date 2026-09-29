import { readFile } from "node:fs/promises";
import { campaignStages } from "../research/policy.js";

const templates = Object.fromEntries(await Promise.all(["context", ...campaignStages].map(async (name) =>
    [name, await readFile(new URL(`../agents/prompts/auto-${name}.txt`, import.meta.url), "utf8")])));

export function buildCampaignPrompt({ profile, route, input }) {
    if (!campaignStages.includes(input.researchStage) || input.autoresearchId !== input.researchId) {
        throw Error("Invalid campaign stage");
    }
    const values = { instructions: templates[input.researchStage], profile: profile.instructions,
        channel: route.instructions || "", memory: input.context || "", sources: input.sourceContext || "",
        request: input.prompt };
    return templates.context.replace(/\{\{([a-z]+)\}\}/g, (_, key) => {
        if (!Object.hasOwn(values, key)) throw Error("Unknown campaign prompt placeholder");
        return values[key];
    });
}
