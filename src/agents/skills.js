import { readFile } from "node:fs/promises";

export async function loadSkills(file = "/config/skills.json") {
    const skills = JSON.parse(await readFile(file, "utf8"));
    if (!skills || typeof skills !== "object" || Array.isArray(skills)) throw Error("Invalid skills");
    for (const [id, skill] of Object.entries(skills)) {
        if (!/^[a-z][a-z0-9-]*$/.test(id) || !skill || typeof skill.name !== "string" ||
            typeof skill.instructions !== "string" || skill.instructions.length > 8000) throw Error("Invalid skill");
    }
    return skills;
}

export function resolveSkill(skills, profile, id) {
    if (!id) return "";
    if (!profile.skills.includes(id) || !Object.hasOwn(skills, id)) {
        throw Error("Skill is not allowed for this profile");
    }
    return skills[id].instructions;
}
