import { z } from "zod";
import { preferenceContext } from "../integrations/settings.js";
import { paperId } from "../papers/arxiv.js";

const empty = z.object({}).strict();
const id = z.string().max(200).transform(paperId);

export function createTools({ personal, weather, calendar, arxiv, library, state }) {
    const tools = {
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
            inputSchema: z.toJSONSchema(tool.schema, { io: "input" }),
            annotations: { readOnlyHint: tool.readOnly !== false, destructiveHint: false,
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
