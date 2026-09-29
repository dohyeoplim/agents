import { z } from "zod";

export const campaignInput = z.object({
    id: z.uuid().optional(),
    revision: z.number().int().nonnegative().optional(),
    title: z.string().trim().min(1).max(150),
    objective: z.string().trim().min(1).max(6000),
    questions: z.array(z.string().trim().min(1).max(1000)).max(10).default([]),
    timezone: z.string().max(100).refine((value) => {
        try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
    }).optional(),
    deadline: z.iso.datetime({ offset: true }).optional(),
    maxSteps: z.number().int().min(3).max(80).default(24),
    maxCommands: z.number().int().min(1).max(100).default(24),
    wallSeconds: z.number().int().min(60).max(86400).default(28800),
    gpuSeconds: z.number().int().min(60).max(345600).default(115200),
    trialSeconds: z.number().int().min(60).max(86400).default(1800),
    gpus: z.number().int().min(1).max(4).default(4),
}).strict().refine((args) => Boolean(args.id) === (args.revision !== undefined), {
    message: "An existing campaign requires its id and revision",
});
