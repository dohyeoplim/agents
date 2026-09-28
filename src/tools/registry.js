import { z } from "zod";
import { preferenceContext } from "../integrations/settings.js";
import { paperId } from "../papers/arxiv.js";
import { createInput, findInput, readInput, bindInput, updateInput } from "../slack/canvas-input.js";

const empty = z.object({}).strict();
const id = z.string().max(200).transform(paperId);

export function createTools({ personal, weather, calendar, arxiv, library, state, canvases }) {
    const tools = {
        slack_canvas_create: {
            description: "Create a Slack canvas with a title and Markdown body in the current channel's tabs. " +
                "Use when the user requests a canvas. Channel members receive edit access. Return the URL. " +
                "Find existing canvases first. An optional purpose connects the document across threads.",
            schema: createInput,
            readOnly: false,
            run: (args, context, signal) => canvases.create(args, context, signal),
        },
        slack_canvas_find: {
            description: "Find canvases shared with the current channel, including saved purpose bindings. " +
                "Follow nextPage before concluding a canvas does not exist.",
            schema: findInput,
            run: (args, context, signal) => canvases.find(args, context, signal),
        },
        slack_canvas_read: {
            description: "Read fresh canvas text, a revision receipt, and optionally section IDs matching query. " +
                "Follow nextOffset with readId. Section IDs identify blocks, not all content beneath a heading.",
            schema: readInput,
            run: (args, context, signal) => canvases.read(args, context, signal),
        },
        slack_canvas_bind: {
            description: "Connect an existing channel canvas to a purpose such as study notes across threads. " +
                "Replacing an existing binding requires its current replaceCanvasId. " +
                "Supply creationChangeId to reconcile an uncertain creation with the identified document.",
            schema: bindInput,
            readOnly: false,
            run: (args, context, signal) => canvases.bind(args, context, signal),
        },
        slack_canvas_update: {
            description: "Apply one canvas edit using a recent readId and section IDs from that read. " +
                "Read and compare the returned content to verify. Whole-document replacement requires an explicit " +
                "rewrite request. Resolve uncertain edits only after inspecting the document and obtaining a clear " +
                "outcome; never use resolve merely to bypass an unknown result.",
            schema: updateInput,
            readOnly: false,
            destructive: true,
            run: (args, context, signal) => canvases.update(args, context, signal),
        },
        briefing_preferences: {
            description: "Read private research preferences, briefing timezone and provider configuration status.",
            schema: empty,
            run: async () => {
                const settings = await personal();
                return { ...preferenceContext(settings), briefing: settings?.briefing || null };
            },
        },
        weather_forecast: {
            description: "Get WeatherKit weather for the configured private location, including attribution.",
            schema: empty,
            run: async (args, context, signal) => {
                const result = await weather(await personal(), signal);
                await state.update((data) => {
                    if (data.tasks[context.id]) data.tasks[context.id].weatherAttribution = result.attribution;
                });
                return result;
            },
        },
        calendar_events: {
            description: "Read selected Google calendars for a time interval. Read-only, including recurring events.",
            schema: z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).strict()
                .refine(({ from, to }) => Date.parse(to) > Date.parse(from) &&
                    Date.parse(to) - Date.parse(from) <= 31 * 86400000, "Use a range of up to 31 days"),
            run: async (args, context, signal) => calendar(args, await personal(), signal),
        },
        papers_search: {
            description: "Search recent arXiv papers. Returns abstracts, not full-paper reviews, plus reading history.",
            schema: z.object({ query: z.string().min(1).max(500),
                days: z.number().int().min(1).max(365).default(7),
                limit: z.number().int().min(1).max(30).default(15) }).strict(),
            run: async (args, context, signal) => {
                const papers = await arxiv.search(args, signal);
                const seen = state.snapshot().briefingSeen?.[context.team + ":" + context.user] || {};
                const notes = library.search(context, "");
                return { papers: papers.map((paper) => ({ ...paper,
                    previouslyBriefed: Boolean(seen[paper.id.replace(/v\d+$/, "")]),
                    readingStatus: notes.find((entry) => entry.paperId === paper.id)?.status || null,
                })), coverage: "Abstracts only. Use papers_fetch and papers_read before a full review." };
            },
        },
        papers_fetch: {
            description: "Download and cache an arXiv paper's TeX source, with PDF-text fallback. Returns a manifest.",
            schema: z.object({ id }).strict(),
            run: (args, context, signal) => library.fetch(args.id, signal),
        },
        papers_read: {
            description: "Read a downloaded paper file by versioned ID and manifest filename. Follow nextOffset.",
            schema: z.object({ id, file: z.string().max(500).optional(),
                offset: z.number().int().min(0).max(25 * 1024 * 1024).default(0) }).strict(),
            run: (args) => library.read(args),
        },
        papers_note: {
            description: "Save a private paper note and reading status after reading or at the user's request.",
            schema: z.object({ id, text: z.string().min(1).max(7500),
                status: z.enum(["saved", "reading", "read", "skipped"]) }).strict(),
            readOnly: false,
            run: (args, context) => library.note(context, args),
        },
        library_search: {
            description: "Search the current user's saved paper notes and reading history.",
            schema: z.object({ query: z.string().max(300).default("") }).strict(),
            run: (args, context) => library.search(context, args.query),
        },
    };
    return {
        definitions: Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description,
            inputSchema: { type: "object", ...z.toJSONSchema(tool.schema, { io: "input" }) },
            annotations: { readOnlyHint: tool.readOnly !== false, destructiveHint: tool.destructive === true,
                openWorldHint: true, idempotentHint: tool.readOnly !== false } })),
        async call(name, args, context, signal) {
            if (!Object.hasOwn(tools, name)) throw Error("Unknown tool");
            const tool = tools[name];
            const parsed = tool.schema.safeParse(args);
            if (!parsed.success) throw Error("Invalid tool arguments");
            signal?.throwIfAborted();
            return tool.run(parsed.data, context, signal);
        },
    };
}
