import bolt from "@slack/bolt";
import { loadConfig } from "./channels/config.js";
import { PersistentState } from "./shared/state.js";
import { TaskRuntime } from "./tasks/runtime.js";
import { createTaskExecutor } from "./tasks/executor.js";
import { createMessageSender, createMessageHandler } from "./slack/messages.js";
import { startScheduler } from "./schedules/runner.js";

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
const runtime = new TaskRuntime({
    store: state,
    deliver: (task, answer) => post(task, "**" + task.profile + "**\n\n" + answer),
    execute: createTaskExecutor({ state, token: process.env.SLACK_BOT_TOKEN }),
});
const messages = createMessageHandler({ state, runtime, bot: identity.user_id, post });

app.event("app_mention", messages.handle);
app.event("message", messages.handle);
app.error(async () => console.error("Slack event failed"));
await runtime.recover();
await app.start();
runtime.wake();
console.log("Slack bridge ready");
const stopScheduler = startScheduler({ state, runtime });

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        stopScheduler();
        await app.stop();
        await messages.idle();
        runtime.closed = true;
        await runtime.idle();
        await state.tail;
        process.exit(0);
    });
}
