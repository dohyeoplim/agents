const actions = {
    draft: ["cancel"], ready: ["approve", "cancel"], prepared: ["manifest", "cancel"], cancelled: [],
};

export const autoresearchActions = (job) => actions[job.status] || [];
