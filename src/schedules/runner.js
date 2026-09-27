import { loadConfig } from "../channels/config.js";
import { dispatchDue } from "./schedules.js";

export function startScheduler({ state, runtime, config = loadConfig }) {
    let ticking = false;
    const scheduler = setInterval(async () => {
        if (ticking) return;
        const due = Object.values(state.snapshot().schedules).some((job) => job.enabled && job.nextRun <= Date.now());
        if (!due) return;
        ticking = true;
        try {
            const current = await config();
            await state.update((data) => dispatchDue(data, current));
            runtime.wake();
        } catch {
            console.error("Schedule dispatch failed");
        } finally {
            ticking = false;
        }
    }, 10000);
    scheduler.unref();
    return () => clearInterval(scheduler);
}
