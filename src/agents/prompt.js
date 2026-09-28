import { readFile } from "node:fs/promises";

const [worker, briefing] = await Promise.all(["worker", "briefing"].map((name) =>
    readFile(new URL(`./prompts/${name}.txt`, import.meta.url), "utf8")));

function render(template, values) {
    return template.replace(/\{\{([a-z]+)\}\}/g, (_, key) => {
        if (!Object.hasOwn(values, key)) throw Error("Unknown prompt placeholder");
        return values[key];
    });
}

export function buildPrompt({ profile, route, skill, input }) {
    const values = {
        profile: profile.instructions,
        channel: route.instructions || "",
        skill: skill || "",
        memory: input.context || "",
        sources: input.sourceContext || "",
        request: input.prompt,
    };
    return render(worker, values);
}

export function buildBriefingPrompt(date, language) {
    return render(briefing, { date, language });
}
