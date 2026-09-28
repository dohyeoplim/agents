const actions = {
    clarifying: ["status", "pause", "cancel"], awaiting_input: ["reply", "cancel"],
    ready: ["start", "edit", "cancel"], queued: ["status", "pause", "cancel"],
    running: ["status", "pause", "summarize", "finish", "cancel"], paused: ["resume", "edit", "cancel"],
    interrupted: ["resume", "edit", "cancel"], failed: ["resume", "edit", "cancel"],
    completed: ["more", "canvas"], cancelled: [],
};

export function researchActions(job) {
    if (job.mode === "canvas" && ["queued", "running"].includes(job.status)) return ["status", "pause"];
    return (actions[job.status] || []).filter((action) =>
        (action !== "canvas" || !job.canvasBusy) && (action !== "edit" || job.mode !== "canvas") &&
        (action !== "finish" || !job.finishRequested));
}
