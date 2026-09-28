import { paperId } from "../papers/arxiv.js";
import { markdownMessages } from "../slack/formatting.js";
import { formatBriefing } from "./formatting.js";

export function createDelivery({ state, streams, post, client, config }) {
    return async (task, answer) => {
        let thread = task.thread;
        if (task.briefingDate) {
            const parts = markdownMessages(formatBriefing(answer));
            const saved = state.snapshot().tasks[task.id];
            thread = saved.postedThread;
            if (!thread) {
                const message = await post({ ...task, deliveryId: task.id }, parts[0]);
                if (!/^\d+\.\d+$/.test(message?.ts || "")) throw Error("Briefing timestamp unavailable");
                thread = message.ts;
                await state.update((data) => {
                    data.tasks[task.id].postedThread = thread;
                    data.tasks[task.id].briefingParts = 1;
                });
            }
            for (let index = state.snapshot().tasks[task.id].briefingParts || 1; index < parts.length; index++) {
                await post({ ...task, thread }, parts[index]);
                await state.update((data) => { data.tasks[task.id].briefingParts = index + 1; });
            }
            const current = await config();
            await state.update((data) => {
                const key = `${task.team}:${task.channel}:${thread}:${current.channels[task.channel].agent}`;
                data.threads[key] = { ...data.threads[task.key], title: task.briefingDate + " briefing" };
                data.tasks[task.id].postedThread = thread;
                data.briefingSeen ??= {};
                const seen = data.briefingSeen[task.team + ":" + task.user] ??= {};
                for (const match of answer.matchAll(/https:\/\/arxiv.org\/abs\/([^\s)<>]+)/g)) {
                    try { seen[paperId(match[1]).replace(/v\d+$/, "")] = Date.now(); } catch {}
                }
                for (const [id, at] of Object.entries(seen)) if (Date.now() - at > 180 * 86400000) delete seen[id];
            });
        } else {
            if (!state.snapshot().tasks[task.id]?.answerPosted) {
                await streams.deliver(task, answer);
                await state.update((data) => { data.tasks[task.id].answerPosted = true; });
            }
        }
        const saved = state.snapshot().tasks[task.id];
        if (saved?.weatherAttribution && !saved.attributionSent) {
            const attribution = saved.weatherAttribution;
            await client.chat.postMessage({ channel: task.channel, thread_ts: thread,
                text: `${attribution.name} · ${attribution.legalUrl}`, unfurl_links: false, unfurl_media: false,
                blocks: [{ type: "context", elements: [
                    { type: "image", image_url: attribution.markUrl, alt_text: attribution.name },
                    { type: "mrkdwn", text: `${attribution.name} · <${attribution.legalUrl}|Data sources>` },
                ] }] });
            await state.update((data) => { data.tasks[task.id].attributionSent = true; });
        }
    };
}
