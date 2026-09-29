export const researchStages = ["clarify", "explore", "counter", "synthesize", "review", "revise", "canvas"];
export const campaignStages = ["campaign", "campaign-review"];
export const campaignTools = ["slack_messages_read", "slack_messages_search", "slack_message_read", "papers_search",
    "papers_fetch", "papers_read", "library_search", "research_result", "remote_status", "remote_read",
    "remote_job", "remote_jobs"];

export const researchTools = ["slack_messages_read", "slack_messages_search", "slack_message_read",
    "slack_canvas_find", "slack_canvas_read", "papers_search", "papers_fetch", "papers_read", "library_search",
    "research_source_save", "research_sources_search", "research_source_read", "research_report_read"];

const canvasWrites = ["slack_canvas_create", "slack_canvas_bind", "slack_canvas_update"];
const controls = ["research_status", "research_propose", "research_control", "research_result"];
const clarificationTools = ["slack_messages_read", "slack_messages_search", "slack_message_read",
    "slack_canvas_find", "slack_canvas_read", "research_sources_search", "research_source_read",
    "research_report_read"];

export function researchToolAllowed(task, name) {
    if (task.autoresearchId) return task.researchId === task.autoresearchId &&
        campaignStages.includes(task.researchStage) && campaignTools.includes(name);
    if (name.startsWith("remote_")) return !task.researchId && !task.scheduleId && !task.briefingDate &&
        ["remote_status", "remote_exec", "remote_jobs", "remote_job", "remote_cancel", "remote_read",
            "remote_write"].includes(name);
    if (name.startsWith("autoresearch_")) return !task.researchId && !task.scheduleId && !task.briefingDate &&
        ["autoresearch_status", "autoresearch_propose", "autoresearch_control", "autoresearch_manifest",
            "autoresearch_campaign", "autoresearch_result"].includes(name);
    if (!task.researchId) return !name.startsWith("research_") ||
        (!task.scheduleId && !task.briefingDate && controls.includes(name));
    if (task.researchStage === "clarify") return clarificationTools.includes(name);
    return researchTools.includes(name) || (task.researchStage === "canvas" && canvasWrites.includes(name));
}
