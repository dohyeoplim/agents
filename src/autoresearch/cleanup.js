import { setTimeout as delay } from "node:timers/promises";

export async function cleanupCampaign({ job, remote, state }) {
    const pending = job.campaignState?.pending;
    if (!pending) return true;
    const signal = AbortSignal.timeout(10000);
    let confirmed = false;
    let abort;
    const cancelled = new Promise((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
    });
    try {
        await Promise.race([cancelled, (async () => {
            let result = await remote.run("cancel", { id: pending.args.id }, job, signal);
            while (!signal.aborted) {
                if (["completed", "failed", "cancelled", "timed_out"].includes(result.status) ||
                    result.orphanStopped === true) { confirmed = true; return; }
                if (!["starting", "running"].includes(result.status)) return;
                await delay(250, undefined, { signal });
                result = await remote.run("job", { id: pending.args.id, offset: 0 }, job, signal);
            }
        })()]);
    } catch {} finally { signal.removeEventListener("abort", abort); }
    await state.update((data) => {
        const current = data.autoresearchJobs[job.id];
        if (current?.runId !== job.runId || current.campaignState?.pending?.args.id !== pending.args.id) return;
        current.campaignState.cleanupPending = !confirmed;
        current.campaignState.pending.stoppedConfirmed = confirmed;
        current.campaignState.pending.cancelConfirmed = confirmed;
    });
    return confirmed;
}
