const actions = {
    clarifying: ["status", "pause"], awaiting_input: ["reply"], ready: ["start", "edit"], queued: ["status", "pause"],
    running: ["status", "pause", "summarize", "finish"], paused: ["resume", "edit"],
    interrupted: ["resume", "edit"], failed: ["resume", "edit"], completed: ["more", "canvas"],
};

export function researchActions(job) {
    if (job.canvasBusy && job.status === "running") return ["status", "pause"];
    return (actions[job.status] || []).filter((action) =>
        (action !== "canvas" || !job.canvasBusy) && (action !== "edit" || job.mode !== "canvas"));
}
