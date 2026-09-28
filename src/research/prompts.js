import { readFile } from "node:fs/promises";
import { researchStages } from "./policy.js";

const templates = Object.fromEntries(await Promise.all(["common", "context", ...researchStages].map(async (stage) =>
    [stage, await readFile(new URL(`../agents/prompts/research-${stage}.txt`, import.meta.url), "utf8")])));

export function buildResearchPrompt({ profile, route, input }) {
    if (!researchStages.includes(input.researchStage)) throw Error("Unknown research stage");
    const values = { common: templates.common, stage: templates[input.researchStage],
        profile: profile.instructions, channel: route.instructions || "", memory: input.context || "",
        messages: input.historyContext || "", sources: input.sourceContext || "", request: input.prompt };
    return templates.context.replace(/\{\{([a-z]+)\}\}/g, (_, key) => {
        if (!Object.hasOwn(values, key)) throw Error("Unknown research prompt placeholder");
        return values[key];
    });
}
