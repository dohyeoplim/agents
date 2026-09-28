import { readFile } from "node:fs/promises";
import { z } from "zod";

const description = z.array(z.string().min(1)).min(1).transform((lines) => lines.join(" "));
const descriptions = z.object({
    research_status: description,
    research_propose: description,
    research_control: description,
    research_result: description,
}).strict().parse(JSON.parse(await readFile(new URL("./tools.json", import.meta.url), "utf8")));

const revision = z.number().int().nonnegative();
export const proposalInput = z.object({
    title: z.string().trim().min(1).max(150),
    brief: z.string().trim().min(1).max(6000),
    questions: z.array(z.string().trim().min(1).max(500)).max(3).default([]),
    parentId: z.uuid().optional(),
    id: z.uuid().optional(),
    revision: revision.optional(),
}).strict().refine((args) => Boolean(args.id) === (args.revision !== undefined), {
    message: "An existing plan requires its id and revision",
}).refine((args) => !(args.id && args.parentId), {
    message: "Use parentId only when creating a new round",
});

export const controlInput = z.object({ id: z.uuid(), revision,
    action: z.enum(["start", "resume", "pause", "finish", "canvas"]) }).strict();
export const resultInput = z.object({ id: z.uuid(),
    offset: z.number().int().nonnegative().default(0) }).strict();

export function createResearchControlTools(coordinator) {
    if (!coordinator) return {};
    return {
        research_status: {
            description: descriptions.research_status,
            schema: z.object({}).strict(),
            run: (_args, context) => coordinator.inspect(context),
        },
        research_propose: {
            description: descriptions.research_propose,
            schema: proposalInput,
            readOnly: false,
            run: (args, context) => coordinator.propose(args, context),
        },
        research_control: {
            description: descriptions.research_control,
            schema: controlInput,
            readOnly: false,
            run: (args, context) => coordinator.act(args, context),
        },
        research_result: {
            description: descriptions.research_result,
            schema: resultInput,
            run: (args, context) => coordinator.readResult(args, context),
        },
    };
}
