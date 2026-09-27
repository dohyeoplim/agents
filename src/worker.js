import { loadConfig } from "./channels/config.js";
import { loadProfiles } from "./agents/profiles.js";
import { loadSkills } from "./agents/skills.js";
import { createWorker } from "./agents/worker.js";

await loadConfig();
await loadProfiles();
await loadSkills();
createWorker().listen(8080, "0.0.0.0");
