import { createHash } from "node:crypto";

function timestamp(value) {
    if (!/^\d+\.\d{1,6}$/.test(value || "")) return null;
    const [seconds, fraction] = value.split(".");
    return BigInt(seconds + fraction.padEnd(6, "0"));
}

function revision(message) {
    return createHash("sha256").update(JSON.stringify({
        text: message.text, user: message.user, botId: message.botId,
        files: message.files, truncated: Boolean(message.truncated), revision: message.revision,
    })).digest("hex");
}

export function createHistoryContext({ state, history }) {
    return {
        async hydrate(task, session, signal) {
            const cutoff = timestamp(task.messageTs);
            if (task.scheduleId || task.briefingDate || cutoff === null || task.thread === task.messageTs) {
                return { text: "" };
            }
            const previous = state.snapshot().threads?.[task.key]?.historyContexts?.[task.profile + ":" + task.user];
            const sameSession = session && previous?.session === session;
            const hashes = sameSession ? { ...previous.hashes } : {};
            let page;
            const pages = [];
            let failed = false;
            try {
                page = await history.read({ thread: task.thread, latest: task.messageTs, limit: 30 }, task, signal);
                pages.push(page);
                let next = sameSession && previous.watermark && timestamp(previous.watermark) < cutoff
                    ? { thread: task.thread, oldest: previous.watermark, latest: task.messageTs, limit: 30 }
                    : page.next;
                while (next && pages.length < 3) {
                    page = await history.read(next, task, signal);
                    pages.push(page);
                    next = page.next;
                }
            } catch {
                if (signal?.aborted) throw Error("Task cancelled");
                failed = true;
            }
            const messages = new Map(pages.flatMap((item) => item.messages).map((message) => [message.ts, message]));
            const candidates = [...messages.values()].filter((message) => {
                const time = timestamp(message.ts);
                return time !== null && time < cutoff;
            }).sort((a, b) => timestamp(a.ts) < timestamp(b.ts) ? -1 : 1);
            const output = { messages: [], notices: [], coverage: page?.coverage,
                nextCursor: page?.nextCursor, next: page?.next };
            for (const notice of new Set(pages.map((item) => item.notice).filter(Boolean))) output.notices.push(notice);
            const openingEnd = pages[0]?.messages.at(-1)?.ts;
            if (sameSession && previous.watermark && openingEnd &&
                timestamp(openingEnd) < timestamp(previous.watermark)) {
                output.notices.push("Only opening and recent thread pages were refreshed. Earlier middle pages may differ.");
            }
            if (failed) output.notices.push(
                "Previous thread messages could not be fully loaded. Do not infer that the thread is empty.",
                "Use the Slack history tools if previous messages are needed for this request.",
            );
            if (page?.hasMore || page?.nextCursor || page?.next) {
                output.notices.push("This is a partial thread. Continue with the next arguments to read omitted messages.");
            }
            let omitted = 0;
            let truncated = 0;
            for (const message of candidates) {
                const hash = revision(message);
                if (hashes[message.ts] === hash) continue;
                const shortened = message.text.length > 1800;
                const entry = {
                    ...message, text: message.text.slice(0, 1800), truncated: shortened || message.truncated === true,
                    changed: Boolean(hashes[message.ts]),
                };
                if (JSON.stringify({ ...output, messages: [...output.messages, entry] }).length > 11000) {
                    omitted += 1;
                    continue;
                }
                output.messages.push(entry);
                hashes[message.ts] = hash;
                if (entry.truncated) truncated += 1;
            }
            if (omitted) output.notices.push(`${omitted} changed messages were omitted by the context budget.`);
            if (truncated) output.notices.push(`${truncated} messages are excerpts. Read them with Slack history tools.`);
            if (omitted || truncated) output.notices.push(`Read thread ${task.thread} for the complete available text.`);
            const ordered = Object.entries(hashes).sort(([a], [b]) => timestamp(a) < timestamp(b) ? -1 : 1);
            const opening = new Set(pages[0]?.messages.map((message) => message.ts));
            const pinned = ordered.filter(([ts]) => opening.has(ts)).slice(0, 30);
            const recent = ordered.filter(([ts]) => !opening.has(ts)).slice(-(120 - pinned.length));
            const retained = [...pinned, ...recent];
            let watermark = sameSession ? previous.watermark : undefined;
            for (const message of candidates) {
                if (watermark && timestamp(message.ts) <= timestamp(watermark)) continue;
                if (hashes[message.ts] !== revision(message)) break;
                watermark = message.ts;
            }
            if (omitted) {
                const missing = candidates.findIndex((message) => hashes[message.ts] !== revision(message));
                output.nextCursor = undefined;
                output.next = { thread: task.thread, oldest: candidates[missing - 1]?.ts,
                    latest: task.messageTs, limit: 30 };
            }
            return {
                text: output.messages.length || output.notices.length ? JSON.stringify(output) : "",
                receipt: pages.length ? { hashes: Object.fromEntries(retained), watermark } : undefined,
            };
        },
    };
}
