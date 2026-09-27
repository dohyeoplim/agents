import { routeEvent } from "./routing.js";
import { SerialQueue } from "../shared/queue.js";
import { chunks, parseCommand } from "../shared/text.js";
import { loadConfig } from "../channels/config.js";
import { loadProfiles, profileFor } from "../agents/profiles.js";
import { loadSkills } from "../agents/skills.js";
import { commandReply, requestedTask } from "./commands.js";

export function createMessageSender(client) {
    return async function post(context, text) {
        const safe = text.replace(/xox[baprs]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
        for (const part of chunks(safe.slice(0, 28000))) {
            await client.chat.postMessage({
                channel: context.channel, thread_ts: context.thread, text: part,
                mrkdwn: false, unfurl_links: false, unfurl_media: false,
            });
        }
    };
}

export function createMessageHandler({
    state, runtime, bot, post, config = loadConfig, profiles = loadProfiles, skills = loadSkills,
}) {
    const events = new SerialQueue();
    async function handle({ body, event }) {
        await events.run(async () => {
            const current = await config();
            const selected = routeEvent(current, body, event, bot, (key) => !!state.snapshot().threads[key]);
            if (!selected) return;
            const claimed = await state.update((data) => {
                if (data.events[selected.eventId]) return false;
                data.events[selected.eventId] = Date.now();
                data.threads[selected.key] ??= { session: null };
                for (const [id, at] of Object.entries(data.events)) {
                    if (Date.now() - at > 7 * 86400000) delete data.events[id];
                }
                return true;
            });
            if (!claimed) return;
            const context = {
                team: current.team, user: event.user, channel: event.channel, thread: selected.thread,
                key: selected.key, profile: profileFor(selected.route),
            };
            try {
                const availableProfiles = await profiles();
                const availableSkills = await skills();
                if (!Object.hasOwn(availableProfiles, context.profile)) throw Error("Channel profile is unavailable");
                const command = parseCommand(selected.prompt);
                if (command) {
                    const response = await commandReply(command, context, {
                        state, runtime, profiles: availableProfiles, skills: availableSkills,
                    });
                    if (response !== null) return post(context, response);
                }
                const task = requestedTask(selected.prompt, availableProfiles, selected.route, availableSkills);
                const busy = runtime.pumping;
                const id = await runtime.enqueue({ ...context, ...task });
                if (busy) await post(context, "Queued task " + id.slice(0, 8) + ". Use !tasks to check its status.");
            } catch (error) {
                await post(context, error.message + "\nUse !help for available commands.");
            }
        });
    }
    return { handle, idle: () => events.tail };
}
