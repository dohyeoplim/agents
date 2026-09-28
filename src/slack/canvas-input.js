import { z } from "zod";

const canvasId = z.string().regex(/^F[A-Z0-9]{6,}$/);
const purpose = z.string().trim().min(1).max(100);
const readId = z.uuid();
const markdown = z.string().trim().min(1).max(20000);
const sectionId = z.string().min(1).max(200);

export const findInput = z.object({ query: z.string().trim().max(200).default(""),
    page: z.number().int().min(1).max(1000).default(1) }).strict();
export const readInput = z.object({ canvasId, query: z.string().trim().min(1).max(200).optional(),
    offset: z.number().int().min(0).max(300000).default(0), readId: readId.optional() }).strict()
    .refine((args) => args.offset === 0 || args.readId, "Paging requires the previous readId");
export const bindInput = z.object({ canvasId, purpose,
    replaceCanvasId: canvasId.optional(), creationChangeId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const createInput = z.object({ title: z.string().trim().min(1).max(200), markdown,
    purpose: purpose.optional() }).strict();

const edit = (operation, fields = {}) => z.object({ readId, operation: z.literal(operation), ...fields }).strict();
export const updateInput = z.discriminatedUnion("operation", [
    edit("insert_at_start", { markdown }), edit("insert_at_end", { markdown }),
    edit("insert_before", { sectionId, markdown }), edit("insert_after", { sectionId, markdown }),
    edit("replace", { sectionId, markdown }), edit("delete", { sectionId }),
    edit("replace_document", { markdown }), edit("rename", { title: z.string().trim().min(1).max(200) }),
    z.object({ operation: z.literal("resolve"), readId: readId.optional(),
        changeId: z.string().regex(/^[a-f0-9]{64}$/), outcome: z.enum(["applied", "not_applied"]),
        reason: z.string().trim().min(1).max(500) }).strict(),
]);
