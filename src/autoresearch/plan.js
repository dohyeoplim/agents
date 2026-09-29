import { createHash } from "node:crypto";
import { z } from "zod";

const clean = z.string().refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const text = (maximum) => clean.pipe(z.string().trim().min(1).max(maximum));
const relativePath = text(300).refine((value) =>
    !value.startsWith("/") && !/[\\*?\[\]{}:]/u.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== ".."));
const paths = z.array(relativePath).min(1).max(100).refine((values) => new Set(values).size === values.length);
const command = z.array(clean.pipe(z.string().min(1).max(2000))).min(1).max(100);
const positive = (maximum) => z.number().int().positive().max(maximum);
const budget = z.object({
    maxExperiments: positive(10000).default(24),
    wallSeconds: positive(2592000).default(28800),
    gpuSeconds: positive(10368000).default(115200),
    maxConcurrent: positive(4).default(4),
    gpusPerExperiment: positive(4).default(1),
    trialSeconds: positive(2592000).default(1800),
}).strict().refine((value) => value.maxConcurrent * value.gpusPerExperiment <= 4, {
    message: "Concurrent GPU allocation exceeds four devices",
}).refine((value) => value.trialSeconds <= value.wallSeconds, {
    message: "Trial duration exceeds wall budget",
}).refine((value) => value.trialSeconds * value.gpusPerExperiment <= value.gpuSeconds, {
    message: "Trial allocation exceeds GPU budget",
});
const repositoryUrl = text(2000).refine((value) => {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password &&
            !url.search && !url.hash && !value.includes("?") && !value.includes("#");
    } catch {
        return false;
    }
});
const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

export const planInput = z.object({
    title: text(150),
    objective: z.string().trim().min(1).max(6000),
    repository: z.object({ url: repositoryUrl, commit: z.string().regex(/^[a-f\d]{40}$/iu) }).strict().optional(),
    dataset: z.object({
        id: text(300), revision: text(300), trainSplit: text(150), validationSplit: text(150), testSplit: text(150),
    }).strict().refine((value) => new Set([value.trainSplit, value.validationSplit, value.testSplit]).size === 3, {
        message: "Dataset splits must be distinct",
    }).optional(),
    metric: z.object({
        name: text(150), direction: z.enum(["minimize", "maximize"]),
        constraints: z.array(z.object({
            name: text(150), operator: z.enum(["gte", "lte"]), value: z.number().finite(),
        }).strict()).max(30).default([]),
    }).strict().optional(),
    environment: z.object({
        image: z.string().max(500).regex(/^[a-z\d][a-z\d._:/-]*@sha256:[a-f\d]{64}$/u),
    }).strict().optional(),
    training: z.object({ command }).strict().optional(),
    evaluation: z.object({ command, protectedPaths: paths }).strict().optional(),
    editablePaths: paths.optional(),
    seeds: z.array(z.number().int().min(0).max(2147483647)).min(1).max(100)
        .refine((values) => new Set(values).size === values.length).default([0, 1, 2]),
    budget: budget.prefault({}),
}).strict().superRefine((value, context) => {
    if (JSON.stringify(value).length > 24000) {
        context.addIssue({ code: "custom", message: "Experiment plan exceeds size limit" });
    }
    if (!value.editablePaths || !value.evaluation) return;
    for (const editable of value.editablePaths) {
        if (value.evaluation.protectedPaths.some((protectedPath) => overlaps(editable, protectedPath))) {
            context.addIssue({
                code: "custom", path: ["editablePaths"], message: "Editable and protected paths overlap",
            });
        }
    }
});

const required = ["repository", "dataset", "metric", "environment", "training", "evaluation", "editablePaths"];

export function missingFields(plan) {
    const parsed = planInput.parse(plan);
    return required.filter((key) => parsed[key] === undefined);
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}

function freeze(value) {
    if (value && typeof value === "object") {
        for (const nested of Object.values(value)) freeze(nested);
        Object.freeze(value);
    }
    return value;
}

export function buildManifest(plan, context) {
    const parsed = planInput.parse(plan);
    const fields = missingFields(parsed);
    if (fields.length) {
        throw Object.assign(Error("Autoresearch plan is incomplete"), { code: "INCOMPLETE_PLAN", fields });
    }
    const identity = z.object({
        id: text(100), revision: positive(Number.MAX_SAFE_INTEGER), team: text(100),
        user: text(100), channel: text(100), thread: text(100),
    }).strict().parse(context);
    const manifest = freeze(canonical({
        version: 1,
        context: identity,
        plan: parsed,
        policy: {
            baselineFirst: true,
            evaluation: { immutable: true, isolated: true, finalTestOnly: true },
            execution: { shell: false, network: false, credentials: false },
            artifacts: ["code", "command", "dataset", "seed", "metrics", "logs", "checkpoint"],
        },
    }));
    const hash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    return { manifest, hash };
}
