import bolt from "@slack/bolt";
import { loadConfig } from "./channels/config.js";
import { createAutomaticChannels } from "./channels/automatic.js";
import { PostgresState } from "./storage/postgres.js";
import { createArtifactStore } from "./storage/artifacts.js";
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
import { createCanvases } from "./slack/canvases.js";
import { createCanvasWorkspace } from "./slack/canvas-workspace.js";
import { createSlackHistory } from "./slack/history.js";
import { createHistoryContext } from "./slack/history-context.js";

const config = await loadConfig();
const state = await new PostgresState({ legacyFile: "/state/conversations.json" }).load();
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
const files = createArtifactStore({ directory: "/state/artifacts" });
const artifacts = {
    async put(data, options) {
        const artifact = await files.put(data, options);
        await state.update((draft) => { draft.artifacts[artifact.id] = artifact; });
        return artifact;
    },
};
const resources = createSlackResources({ token: process.env.SLACK_BOT_TOKEN, artifacts });
const streams = createSlackStreams({ state, token: process.env.SLACK_BOT_TOKEN, post });
const arxiv = createArxiv();
const library = createLibrary({ arxiv, state });
const canvasOptions = { token: process.env.SLACK_BOT_TOKEN, state, workspaceUrl: identity.url };
const canvases = createCanvasWorkspace({ ...canvasOptions, resources, create: createCanvases(canvasOptions).create });
const history = createSlackHistory({ token: process.env.SLACK_BOT_TOKEN, workspaceUrl: identity.url });
const historyContext = createHistoryContext({ state, history });
const tools = createTools({ personal: loadPersonal, weather: createWeather(), calendar: createCalendar(),
    arxiv, library, state, canvases, history });
const toolServer = createToolServer({ tools, state, config: loadConfig, personal: loadPersonal,
    healthy: async () => !runtime.closed && !runtime.broken && await state.healthy() });
const briefingContext = createBriefingContext({ tools, personal: loadPersonal });
const runtime = new TaskRuntime({
    store: state,
    deliver: createDelivery({ state, streams, post, client: app.client, config: loadConfig }),
    execute: createTaskExecutor({ state, token: process.env.SLACK_BOT_TOKEN, resources, streams,
        toolServer, briefingContext, historyContext }),
});
const messages = createMessageHandler({ state, runtime, bot: identity.user_id, post, titles, resources });
const channels = createAutomaticChannels({ client: app.client, team: config.team, bot: identity.user_id,
    file: process.env.AUTO_CHANNELS_FILE || "/channels/routes.json" });

app.event("channel_created", channels.handle);
app.event("member_joined_channel", channels.handle);
app.event("app_mention", messages.handle);
app.event("message", messages.handle);
app.event("agent_session_title_changed", titles.changed);
app.error(async () => console.error("Slack event failed"));
await runtime.recover();
runtime.closed = true;
await new Promise((resolve, reject) => {
    toolServer.server.once("error", reject);
    toolServer.server.listen(8081, "0.0.0.0", resolve);
});
await app.start();
await channels.sync().catch(() => {});
const channelTimer = setInterval(() => { channels.sync().catch(() => {}); }, 5 * 60 * 1000);
channelTimer.unref();
await messages.recover();
runtime.closed = false;
runtime.wake();
console.log("Slack bridge ready");
const stopScheduler = startScheduler({ state, runtime });
const stopBriefings = startBriefings({ state, runtime, config: loadConfig, personal: loadPersonal });

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        stopScheduler();
        stopBriefings();
        clearInterval(channelTimer);
        await app.stop();
        await channels.stop();
        await messages.idle();
        runtime.closed = true;
        await runtime.idle();
        await new Promise((resolve) => toolServer.server.close(resolve));
        await state.close();
        process.exit(0);
    });
}
