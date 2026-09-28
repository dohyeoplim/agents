export function researchProgress(job, data) {
    const activeTasks = Object.values(data.tasks || {}).filter((task) => task.researchId === job.id &&
        task.researchRunId === job.runId && task.status === "running")
        .map((task) => ({ provider: task.provider, stage: task.researchStage, startedAt: task.startedAt }));
    return {
        sources: Object.values(data.researchSources || {}).filter((source) => source.researchId === job.id).length,
        reports: job.reports?.length || 0,
        activeTasks,
        phaseStartedAt: job.phaseStartedAt,
    };
}
