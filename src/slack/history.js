import { z } from "zod";
import { createHash } from "node:crypto";

const timestamp = z.string().regex(/^\d{10,16}\.\d{6}$/);
const time = (value) => BigInt(value.replace(".", ""));
const page = {
    thread: timestamp.optional(),
    oldest: timestamp.optional(),
    latest: timestamp.optional(),
    cursor: z.string().min(1).max(2000).optional(),
    limit: z.number().int().min(1).max(30).default(15),
};
const ordered = (args) => !args.oldest || !args.latest ||
    (timestamp.safeParse(args.oldest).success && timestamp.safeParse(args.latest).success &&
        time(args.oldest) < time(args.latest));
export const historyInput = z.object(page).strict().refine(ordered, "oldest must precede latest");
export const searchInput = z.object({ ...page, query: z.string().trim().min(1).max(200) }).strict()
    .refine(ordered, "oldest must precede latest");
export const messageInput = z.object({ ts: timestamp, thread: timestamp.optional(),
    offset: z.number().int().min(0).max(1000000).default(0),
    revision: z.string().max(100).optional() }).strict()
    .refine((args) => !args.offset || args.revision, "Continuation requires the previous revision");

const message = z.object({
    ts: timestamp, text: z.string().max(1000000).default(""),
    user: z.string().optional(), bot_id: z.string().optional(),
    thread_ts: timestamp.optional(), reply_count: z.number().int().nonnegative().optional(),
    edited: z.object({ ts: timestamp }).optional(),
    files: z.array(z.object({ id: z.string(), title: z.string().optional() })).optional(),
    subtype: z.string().optional(),
});
const response = z.object({ messages: z.array(message).max(1000), has_more: z.boolean().optional(),
    response_metadata: z.object({ next_cursor: z.string().optional() }).optional() });

export function createSlackHistory({ token, workspaceUrl, request = fetch }) {
    const origin = new URL(workspaceUrl);
    if (origin.protocol !== "https:" || !origin.hostname.endsWith(".slack.com") ||
        origin.username || origin.password) throw Error("Invalid Slack workspace URL");
    let blockedUntil = 0;

    async function fetchPage(args, context, signal, inclusive = false) {
        signal?.throwIfAborted();
        if (!token) throw Error("Slack bot token is missing");
        if (!/^[CG][A-Z0-9]+$/.test(context.channel)) throw Error("Invalid history channel");
        if (Date.now() < blockedUntil) throw Error("Slack history rate limited. Try again after " +
            new Date(blockedUntil).toISOString());
        const url = new URL("https://slack.com/api/conversations." + (args.thread ? "replies" : "history"));
        url.searchParams.set("channel", context.channel);
        url.searchParams.set("limit", String(args.limit));
        url.searchParams.set("inclusive", String(inclusive));
        if (args.thread) url.searchParams.set("ts", args.thread);
        for (const key of ["oldest", "latest", "cursor"]) {
            if (args[key]) url.searchParams.set(key, args[key]);
        }
        const result = await request(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error",
            signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) });
        if (result.status === 429) {
            const seconds = Number(result.headers.get("retry-after"));
            blockedUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
            throw Error("Slack history rate limited. Try again after " + new Date(blockedUntil).toISOString());
        }
        if (!result.ok) throw Error("Slack history request failed");
        const data = await result.json();
        if (data?.ok !== true) {
            const errors = {
                missing_scope: "Slack history needs channels:history or groups:history. Reinstall the app after changes.",
                not_in_channel: "The bot must join this channel before reading history.",
                not_allowed_token_type: "Slack rejected this token type for history. Thread reading is unavailable.",
                channel_not_found: "This channel is unavailable to the bot.",
                thread_not_found: "This thread is unavailable or was deleted.",
                invalid_cursor: "History cursor expired. Restart the query with the same time bounds.",
            };
            throw Error(Object.hasOwn(errors, data?.error) ? errors[data.error] : "Slack history is unavailable");
        }
        return response.parse(data);
    }

    function format(item, context, offset = 0, size = 1500) {
        const text = item.text.slice(offset, offset + size);
        const threadTs = item.thread_ts || item.ts;
        const url = new URL(`/archives/${context.channel}/p${item.ts.replace(".", "")}`, origin);
        if (threadTs !== item.ts) url.searchParams.set("thread_ts", threadTs);
        return { ts: item.ts, threadTs, user: item.user || null, botId: item.bot_id || null,
            text, offset, url: url.href, replyCount: item.reply_count || 0,
            revision: createHash("sha256").update(JSON.stringify(item)).digest("hex"),
            files: (item.files || []).slice(0, 10).map((file) => ({ id: file.id, title: file.title?.slice(0, 200) })),
            truncated: offset > 0 || offset + text.length < item.text.length,
            nextOffset: offset + text.length < item.text.length ? offset + text.length : null,
            textLength: item.text.length,
            notice: !item.text ? "No plain-text body. File contents and rich blocks have not been read." : null };
    }

    async function readPage(args, context, signal, query) {
        const data = await fetchPage(args, context, signal);
        const visible = data.messages.filter((item) => item.subtype !== "message_deleted" &&
            (!args.latest || time(item.ts) < time(args.latest)) &&
            (!args.oldest || time(item.ts) > time(args.oldest)));
        const matching = query ? visible.filter((item) => item.text.toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())) : visible;
        const cursor = data.response_metadata?.next_cursor || null;
        const nextCursor = cursor !== args.cursor ? cursor : null;
        const hasMore = Boolean(data.has_more || cursor);
        const last = data.messages.at(-1)?.ts;
        const advances = last && (args.thread ? !args.oldest || time(last) > time(args.oldest) :
            !args.latest || time(last) < time(args.latest));
        const next = hasMore ? nextCursor ? { ...args, cursor: nextCursor } : advances ? {
            ...args, cursor: undefined, [args.thread ? "oldest" : "latest"]: last,
        } : null : null;
        return { channel: context.channel, messages: matching.map((item) => format(item, context,
            query ? Math.max(0, item.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 200) : 0)),
            scanned: visible.length, hasMore, nextCursor, next,
            coverage: args.thread ? "One page of this thread only, within the requested exclusive time bounds." :
                "One page of channel history only. Thread replies are not fully searched. Read threads separately.",
            notice: hasMore && !next ? "Slack reported more results without a continuation. Narrow the time range." :
                "Slack retention and permissions may hide older messages. Reads are live, not a historical snapshot." };
    }

    return {
        read: (input, context, signal) => readPage(historyInput.parse(input), context, signal),
        search: (input, context, signal) => {
            const { query, ...args } = searchInput.parse(input);
            return readPage(args, context, signal, query).then((result) => ({ ...result,
                next: result.next ? { ...result.next, query } : null,
                match: "Case-insensitive literal text match on this page, not workspace-wide Slack search." }));
        },
        async message(input, context, signal) {
            const args = messageInput.parse(input);
            const data = await fetchPage({ thread: args.thread, oldest: args.ts, latest: args.ts, limit: 1 },
                context, signal, true);
            const item = data.messages.find((item) => item.ts === args.ts && item.subtype !== "message_deleted");
            if (!item) throw Error("Message is unavailable. For a reply, supply its parent thread timestamp.");
            const result = format(item, context, args.offset, 6000);
            if (args.revision && args.revision !== result.revision) throw Error("Message changed. Read again from offset 0.");
            if (args.offset > item.text.length) throw Error("Message offset is beyond the current text");
            return result;
        },
    };
}
