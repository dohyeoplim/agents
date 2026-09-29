import { readFile } from "node:fs/promises";
import { z } from "zod";
import { planInput } from "./plan.js";
import { campaignInput } from "./campaign-schema.js";

const description = z.array(z.string().min(1)).min(1).transform((lines) => lines.join(" "));
const descriptions = z.object({
    autoresearch_status: description,
    autoresearch_propose: description,
    autoresearch_control: description,
    autoresearch_manifest: description,
    autoresearch_campaign: description,
    autoresearch_result: description,
}).strict().parse(JSON.parse(await readFile(new URL("./tools.json", import.meta.url), "utf8")));

const revision = z.number().int().nonnegative();
export const statusInput = z.object({ offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(10).default(10) }).strict();
export const proposalInput = z.object({ plan: planInput, id: z.uuid().optional(),
    revision: revision.optional() }).strict().refine((args) => Boolean(args.id) === (args.revision !== undefined), {
    message: "An existing plan requires its id and revision",
});
export const controlInput = z.object({ id: z.uuid(), revision,
    action: z.enum(["approve", "cancel", "refresh", "start", "pause", "resume"]) }).strict();
export const manifestInput = z.object({ id: z.uuid(),
    offset: z.number().int().nonnegative().default(0) }).strict();

export function createAutoresearchTools(service) {
    if (!service) return {};
    return {
        autoresearch_status: { description: descriptions.autoresearch_status, schema: statusInput,
            run: (args, context) => service.inspect(context, args) },
        autoresearch_propose: { description: descriptions.autoresearch_propose, schema: proposalInput,
            readOnly: false, run: (args, context, signal) => service.propose(args, context, signal) },
        autoresearch_control: { description: descriptions.autoresearch_control, schema: controlInput,
            readOnly: false, run: (args, context, signal) => service.act(args, context, signal) },
        autoresearch_manifest: { description: descriptions.autoresearch_manifest, schema: manifestInput,
            run: (args, context) => service.readManifest(args, context) },
        autoresearch_campaign: { description: descriptions.autoresearch_campaign, schema: campaignInput,
            readOnly: false, run: (args, context, signal) => service.campaign(args, context, signal) },
        autoresearch_result: { description: descriptions.autoresearch_result, schema: manifestInput,
            run: (args, context) => service.readResult(args, context) },
    };
}
