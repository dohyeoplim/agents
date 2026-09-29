import { readFile } from "node:fs/promises";
import { z } from "zod";

const operations = ["status", "exec", "jobs", "job", "cancel", "read", "write"];
const description = z.array(z.string().min(1)).min(1).transform((lines) => lines.join(" "));
const descriptions = z.object(Object.fromEntries(operations.map((operation) =>
    [`remote_${operation}`, description]))).strict()
    .parse(JSON.parse(await readFile(new URL("./tools.json", import.meta.url), "utf8")));
const path = z.string().min(1).max(4096).startsWith("/").regex(/^[^\u0000-\u001f\u007f]+$/);
const offset = z.number().int().nonnegative().default(0);
const empty = z.object({}).strict();
export const execInput = z.object({
    id: z.uuid(),
    command: z.string().min(1).max(16000).refine((value) => !value.includes("\0")),
    cwd: path.default("/workspace"),
    timeoutSeconds: z.number().int().min(1).max(604800).default(86400),
}).strict();
export const jobInput = z.object({ id: z.uuid(), offset }).strict();
export const cancelInput = z.object({ id: z.uuid() }).strict();
export const readInput = z.object({ path, offset }).strict();
export const writeInput = z.object({
    path,
    content: z.string().max(64000),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict().refine((args) => Buffer.byteLength(JSON.stringify(args)) <= 240000, "File payload exceeds limit");
const schemas = { status: empty, exec: execInput, jobs: empty, job: jobInput,
    cancel: cancelInput, read: readInput, write: writeInput };

export function createRemoteTools(service) {
    if (!service) return {};
    return Object.fromEntries(operations.map((operation) => [`remote_${operation}`, {
        description: descriptions[`remote_${operation}`],
        schema: schemas[operation],
        readOnly: !["exec", "cancel", "write"].includes(operation),
        run: (args, context, signal) => service.run(operation, args, context, signal),
    }]));
}
