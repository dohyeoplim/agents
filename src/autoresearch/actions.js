const actions = {
    draft: ["cancel"], ready: ["approve", "cancel"], prepared: ["manifest", "cancel"], cancelled: [],
};

const campaignActions = {
    ready: ["start", "cancel"], awaiting_input: ["cancel"], queued: ["pause", "cancel"],
    running: ["pause", "cancel"], paused: ["resume", "cancel"], interrupted: ["resume", "cancel"],
    failed: ["resume", "cancel"], limited: ["cancel"], completed: [], cancelled: [],
};

export const autoresearchActions = (job) => {
    if (job.mode !== "campaign") return actions[job.status] || [];
    const available = [...(campaignActions[job.status] || [])];
    if (job.campaignState?.cleanupPending && !available.includes("cancel")) available.push("cancel");
    if (job.finalReportId || job.campaignState?.finalReportId) available.push("result");
    return available;
};
