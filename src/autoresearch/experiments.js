import { z } from "zod";
import { buildManifest } from "./plan.js";

const commit = z.string().regex(/^[a-f\d]{40}$/iu).transform((value) => value.toLowerCase());
const candidateInput = z.object({
    id: z.string().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/u), commit,
}).strict();
const resultInput = z.object({
    metrics: z.record(z.string().min(1).max(150), z.number().finite()),
    gpuSeconds: z.number().finite().nonnegative(), wallSeconds: z.number().finite().nonnegative(),
    commit, seed: z.number().int(), evaluatorCommit: commit, datasetRevision: z.string(),
    artifacts: z.array(z.string().min(1).max(2000)).max(100).optional(),
}).strict();
const failure = (code) => Object.assign(Error(code), { code });

async function bounded(operation, milliseconds, signal) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(failure("TRIAL_TIMEOUT")), Math.max(1, milliseconds));
    let aborted;
    const stopped = new Promise((resolve, reject) => {
        aborted = () => reject(combined.reason);
        combined.addEventListener("abort", aborted, { once: true });
    });
    try {
        return await Promise.race([Promise.resolve().then(() => operation(combined)), stopped]);
    } finally {
        clearTimeout(timer);
        combined.removeEventListener("abort", aborted);
    }
}

export function createExperimentLoop({ runner, proposeCandidate, record, now = Date.now }) {
    return {
        async run(input, { signal } = {}) {
            signal?.throwIfAborted();
            const status = await bounded((statusSignal) => runner.status(statusSignal), 5000, signal);
            if (!status?.available) throw failure("RUNNER_UNAVAILABLE");
            if (input?.version !== 1) throw failure("INVALID_MANIFEST");
            const { manifest } = buildManifest(input.plan, input.context);
            const { budget, metric, seeds, repository, dataset } = manifest.plan;
            const started = now();
            const history = [];
            let attempts = 0;
            let gpuSeconds = 0;
            let reportedWall = 0;
            let best = null;
            let reason = "complete";
            const wallSeconds = () => Math.max(reportedWall, (now() - started) / 1000);
            const exhausted = () => attempts >= budget.maxExperiments ? "experiments" :
                wallSeconds() >= budget.wallSeconds ? "wall" : gpuSeconds >= budget.gpuSeconds ? "gpu" : null;
            const emit = async (event) => {
                signal?.throwIfAborted();
                await bounded(() => record(structuredClone(event)), 5000, signal);
            };
            let candidate = { id: "baseline", commit: repository.commit.toLowerCase() };
            let baseline = true;
            while (candidate) {
                signal?.throwIfAborted();
                reason = exhausted() ?? "complete";
                if (reason !== "complete") break;
                const trials = [];
                let eligible = true;
                for (const seed of seeds) {
                    reason = exhausted() ?? "complete";
                    if (reason !== "complete") break;
                    const duration = Math.min(budget.trialSeconds, budget.wallSeconds - wallSeconds(),
                        (budget.gpuSeconds - gpuSeconds) / budget.gpusPerExperiment);
                    const limits = { wallSeconds: duration, gpuSeconds: duration * budget.gpusPerExperiment,
                        gpus: budget.gpusPerExperiment };
                    const trialStarted = now();
                    attempts++;
                    await emit({ type: "trial_started", candidate, baseline, seed, attempts, limits });
                    let result;
                    let errorCode;
                    try {
                        if (wallSeconds() >= budget.wallSeconds) throw failure("WALL_BUDGET");
                        const raw = await bounded((trialSignal) => runner.submit({
                            manifest, candidate: structuredClone(candidate), seed, baseline, limits,
                        }, trialSignal), Math.min(duration, budget.wallSeconds - wallSeconds()) * 1000, signal);
                        result = resultInput.parse(raw);
                        if (result.commit !== candidate.commit || result.seed !== seed ||
                            result.evaluatorCommit !== repository.commit.toLowerCase() ||
                            result.datasetRevision !== dataset.revision || result.gpuSeconds > limits.gpuSeconds ||
                            result.wallSeconds > limits.wallSeconds ||
                            !Object.hasOwn(result.metrics, metric.name) ||
                            metric.constraints.some((constraint) => !Object.hasOwn(result.metrics, constraint.name))) {
                            throw failure("INVALID_TRIAL");
                        }
                    } catch (error) {
                        signal?.throwIfAborted();
                        errorCode = error?.code === "TRIAL_TIMEOUT" ? "TRIAL_TIMEOUT" : "TRIAL_FAILED";
                        result = undefined;
                    }
                    gpuSeconds += result?.gpuSeconds ?? limits.gpuSeconds;
                    reportedWall += Math.max((now() - trialStarted) / 1000,
                        result?.wallSeconds ?? (errorCode === "TRIAL_TIMEOUT" ? duration : 0));
                    if (!result) {
                        eligible = false;
                        await emit({ type: "trial_failed", candidate, seed, errorCode, attempts, gpuSeconds });
                        break;
                    }
                    trials.push(result);
                    eligible &&= metric.constraints.every(({ name, operator, value }) =>
                        operator === "gte" ? result.metrics[name] >= value : result.metrics[name] <= value);
                    await emit({ type: "trial_completed", candidate, seed, result, attempts, gpuSeconds });
                }
                eligible &&= trials.length === seeds.length;
                const rawScore = eligible ? trials.reduce((sum, trial) =>
                    sum + trial.metrics[metric.name] / seeds.length, 0) : null;
                const score = Number.isFinite(rawScore) ? rawScore : null;
                eligible &&= score !== null;
                const improved = eligible && (!best ||
                    (metric.direction === "minimize" ? score < best.score : score > best.score));
                const result = { candidate, baseline, trials, eligible, score, improved };
                history.push(result);
                if (improved) best = { candidate: structuredClone(candidate), score };
                await emit({ type: "candidate_completed", ...result, best });
                if (baseline && trials.length !== seeds.length) {
                    reason = exhausted() ?? "baseline_failed";
                    break;
                }
                reason = exhausted() ?? "complete";
                if (reason !== "complete") break;
                let proposed;
                try {
                    proposed = await bounded((proposalSignal) => proposeCandidate({
                        manifest, history: structuredClone(history), best: structuredClone(best),
                    }, proposalSignal), (budget.wallSeconds - wallSeconds()) * 1000, signal);
                } catch (error) {
                    signal?.throwIfAborted();
                    if (error?.code !== "TRIAL_TIMEOUT") throw error;
                    reason = "wall";
                    break;
                }
                candidate = proposed === null ? null : candidateInput.parse(proposed);
                baseline = false;
            }
            const summary = { reason, attempts, gpuSeconds, wallSeconds: wallSeconds(), best, history };
            await emit({ type: "completed", summary });
            return summary;
        },
    };
}
