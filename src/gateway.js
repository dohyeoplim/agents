import bolt from "@slack/bolt";
import { loadConfig } from "./channels/config.js";
import { PersistentState } from "./shared/state.js";
import { TaskRuntime } from "./tasks/runtime.js";
import { createTaskExecutor } from "./tasks/executor.js";
import { createMessageSender, createMessageHandler } from "./slack/messages.js";
import { startScheduler } from "./schedules/runner.js";
import { createThreadTitles } from "./slack/titles.js";
import { createSlackResources } from "./resources/slack.js";
import { createSlackStreams } from "./slack/streams.js";
import { loadPersonal } from "./integrations/settings.js";
import { createWeather } from "./integrations/weather.js";
import { createCalendar } from "./integrations/calendar.js";
import { createArxiv } from "./papers/arxiv.js";
import { createLibrary } from "./papers/library.js";
import { createTools } from "./tools/registry.js";
import { createToolServer } from "./tools/server.js";
import { startBriefings } from "./briefings/scheduler.js";
import { createBriefingContext } from "./briefings/context.js";
import { createDelivery } from "./briefings/delivery.js";

const config = await loadConfig();
const state = await new PersistentState("/state/conversations.json", {
    threads: {}, events: {}, tasks: {}, entries: {}, schedules: {},
}).load();
const quietLogger = {
    debug() {},
    info() {},
    warn() { console.warn("Slack warning"); },
    error() { console.error("Slack error"); },
    setLevel() {},
    getLevel() { return "error"; },
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

const post = createMessageSender(app.client);
const titles = createThreadTitles({ state, token: process.env.SLACK_BOT_TOKEN });
const resources = createSlackResources({ token: process.env.SLACK_BOT_TOKEN });
const streams = createSlackStreams({ state, token: process.env.SLACK_BOT_TOKEN, post });
const arxiv = createArxiv();
const library = createLibrary({ arxiv, state });
const tools = createTools({ personal: loadPersonal, weather: createWeather(), calendar: createCalendar(),
    arxiv, library, state });
const toolServer = createToolServer({ tools, state, config: loadConfig, personal: loadPersonal });
const briefingContext = createBriefingContext({ tools, personal: loadPersonal });
const runtime = new TaskRuntime({
    store: state,
    deliver: createDelivery({ state, streams, post, client: app.client, config: loadConfig }),
    execute: createTaskExecutor({ state, token: process.env.SLACK_BOT_TOKEN, resources, streams,
        toolServer, briefingContext }),
});
const messages = createMessageHandler({ state, runtime, bot: identity.user_id, post, titles, resources });

app.event("app_mention", messages.handle);
app.event("message", messages.handle);
app.event("agent_session_title_changed", titles.changed);
app.error(async () => console.error("Slack event failed"));
await runtime.recover();
await new Promise((resolve, reject) => {
    toolServer.server.once("error", reject);
    toolServer.server.listen(8081, "0.0.0.0", resolve);
});
await app.start();
runtime.wake();
console.log("Slack bridge ready");
const stopScheduler = startScheduler({ state, runtime });
const stopBriefings = startBriefings({ state, runtime, config: loadConfig, personal: loadPersonal });

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        stopScheduler();
        stopBriefings();
        await app.stop();
        await messages.idle();
        runtime.closed = true;
        await runtime.idle();
        await new Promise((resolve) => toolServer.server.close(resolve));
        await state.tail;
        process.exit(0);
    });
}
