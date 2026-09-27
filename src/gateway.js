import bolt from "@slack/bolt";
import { routeEvent, Store, SerialQueue, chunks } from "./core.js";
import { loadConfig } from "./channels.js";

const config = await loadConfig();

const store = new Store("/state/conversations.json");
await store.load();

const queue = new SerialQueue();
const quietLogger = {
    debug() {},
    info() {},
    warn() {
        console.warn("Slack warning");
    },
    error() {
        console.error("Slack error");
    },
    setLevel() {},
    getLevel() {
        return "error";
    },
    setName() {},
};
const app = new bolt.App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logger: quietLogger,
});
const identity = await app.client.auth.test();

if (identity.team_id !== config.team) throw Error("Slack workspace mismatch");
async function handle({ body, event }) {
    const config = await loadConfig();
    const selected = routeEvent(
        config,
        body,
        event,
        identity.user_id,
        (key) => !!store.data.threads[key],
    );
    if (!selected) return;
    try {
        await queue.run(async () => {
            const current = await loadConfig();
            if (
                !routeEvent(
                    current,
                    body,
                    event,
                    identity.user_id,
                    (key) => !!store.data.threads[key],
                )
            )
                return;
            const { key, route, prompt, thread, eventId } = selected;
            if (store.data.events[eventId]) return;
            store.data.events[eventId] = Date.now();
            store.data.threads[key] ??= { session: null };
            for (const [id, at] of Object.entries(store.data.events))
                if (Date.now() - at > 7 * 86400000)
                    delete store.data.events[id];
            await store.save();
            const post = (text) =>
                app.client.chat.postMessage({
                    channel: event.channel,
                    thread_ts: thread,
                    text,
                    mrkdwn: false,
                    unfurl_links: false,
                    unfurl_media: false,
                });
            try {
                const response = await fetch(`http://${route.agent}:8080/run`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        channel: event.channel,
                        prompt,
                        session: store.data.threads[key].session,
                    }),
                    signal: AbortSignal.timeout(620000),
                });
                if (!response.ok) throw Error("Worker failed");
                const result = await response.json();
                if (
                    typeof result.answer !== "string" ||
                    !/^[0-9a-f-]{36}$/i.test(result.session ?? "")
                )
                    throw Error("Invalid response");
                store.data.threads[key].session = result.session;
                await store.save();
                const safe = result.answer.replace(
                    /xox[baprs]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]+/g,
                    "[REDACTED]",
                );
                for (const part of chunks(safe.slice(0, 28000)))
                    await post(part);
            } catch {
                await post(
                    "작업을 완료하지 못했습니다. " +
                    "서버의 로그인 상태와 실행 환경을 확인한 뒤 " +
                    "새 메시지로 요청해 주세요.",
                );
            }
        });
    } catch {
        console.error("Event processing failed");
    }
}

app.event("app_mention", handle);
app.event("message", handle);
app.error(async () => console.error("Slack event failed"));

await app.start();
console.log("Slack bridge ready");

for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
        await app.stop();
        await queue.tail;
        process.exit(0);
    });
