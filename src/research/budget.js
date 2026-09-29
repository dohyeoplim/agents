const limitError = (reason) => Object.assign(Error("Research execution budget reached"), {
    code: "RESEARCH_BUDGET", reason,
});

export function researchLimits(env = process.env) {
    const maxCycles = Number(env.RESEARCH_MAX_CYCLES ?? 3);
    const maxDurationMs = Number(env.RESEARCH_MAX_DURATION_SECONDS ?? 3600) * 1000;
    if (!Number.isSafeInteger(maxCycles) || maxCycles < 0 ||
        !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1000 || maxDurationMs > 2147483647) {
        throw Error("Invalid research execution limits");
    }
    return { maxCycles, maxDurationMs };
}

export async function startResearchBudget({ state, job, signal, now, limits }) {
    const startedAt = now();
    const saved = await state.update((data) => {
        signal.throwIfAborted();
        const current = data.researchJobs[job.id];
        if (current.runId !== job.runId || current.status !== "running") throw Error("Research run changed");
        const budget = current.executionBudget ??= { ...limits, cycles: 0, elapsedMs: 0 };
        if (budget.activeSince !== undefined && budget.activeSince !== null) {
            budget.elapsedMs += Math.max(0, startedAt - budget.activeSince);
        }
        Object.assign(budget, { activeSince: startedAt, runId: job.runId });
        return budget;
    });
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const remaining = Math.max(0, saved.maxDurationMs - saved.elapsedMs);
    const timer = setTimeout(() => controller.abort(limitError("time")), remaining);
    timer.unref();
    const check = () => {
        signal.throwIfAborted();
        if (now() - startedAt >= remaining) controller.abort(limitError("time"));
        combined.throwIfAborted();
    };
    return {
        signal: combined,
        check,
        exhausted: (error) => !signal.aborted && (controller.signal.aborted || error?.code === "RESEARCH_BUDGET"),
        reason: (error) => controller.signal.aborted ? "time" : error.reason,
        advance(current) {
            check();
            if (current.executionBudget.cycles >= current.executionBudget.maxCycles) throw limitError("cycles");
            current.executionBudget.cycles++;
        },
        async close() {
            clearTimeout(timer);
            await state.update((data) => {
                const budget = data.researchJobs[job.id]?.executionBudget;
                if (budget?.runId !== job.runId) return;
                budget.elapsedMs += Math.max(0, now() - startedAt);
                budget.activeSince = null;
            });
        },
    };
}
