import { z } from "zod";
import { researchText } from "./copy.js";

const clarification = z.object({ ready: z.boolean(), title: z.string().trim().min(1).max(150),
    brief: z.string().trim().min(1).max(6000), questions: z.array(z.string().trim().min(1).max(500)).max(3),
}).strict().refine((value) => value.ready ? !value.questions.length : value.questions.length > 0);
const review = z.object({ verdict: z.enum(["ready", "revise", "needs_research"]),
    feedback: z.array(z.string().max(1500)).max(12), gaps: z.array(z.string().max(1500)).max(12),
    gapIds: z.array(z.string().regex(/^g[1-9]\d{0,8}$/).nullable()).max(12).optional(),
}).strict().refine((value) => value.gapIds === undefined || value.gapIds.length === value.gaps.length);

export function researchOutput(text, kind) {
    const content = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
    try { return (kind === "clarify" ? clarification : review).parse(JSON.parse(content)); }
    catch { throw Error(researchText("RESEARCH_OUTPUT_INVALID", { kind })); }
}
