export const researchStages = ["clarify", "explore", "counter", "synthesize", "review", "revise", "canvas"];

export const researchTools = ["slack_messages_read", "slack_messages_search", "slack_message_read",
    "slack_canvas_find", "slack_canvas_read", "papers_search", "papers_fetch", "papers_read", "library_search",
    "research_source_save", "research_sources_search", "research_source_read", "research_report_read"];

const canvasWrites = ["slack_canvas_create", "slack_canvas_bind", "slack_canvas_update"];

export function researchToolAllowed(task, name) {
    if (!task.researchId) return !name.startsWith("research_");
    return researchTools.includes(name) || (task.researchStage === "canvas" && canvasWrites.includes(name));
}
