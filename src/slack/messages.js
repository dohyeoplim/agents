import { routeEvent } from "./routing.js";
import { SerialQueue } from "../shared/queue.js";
import { parseCommand } from "../shared/text.js";
import { markdownMessages } from "./formatting.js";
import { loadConfig } from "../channels/config.js";
import { loadProfiles, profileFor } from "../agents/profiles.js";
import { loadSkills } from "../agents/skills.js";
import { commandReply, requestedTask } from "./commands.js";
import { appendTask } from "../tasks/runtime.js";

export function createMessageSender(client, profiles = loadProfiles) {
    return async function post(context, text) {
        const available = context.profile ? await profiles() : {};
        const username = Object.hasOwn(available, context.profile) ? available[context.profile].name : undefined;
        let first;
        let thread = context.thread;
        for (const part of markdownMessages(text)) {
            const message = {
                channel: context.channel, thread_ts: thread, markdown_text: part,
                ...(!first && context.deliveryId ? { client_msg_id: context.deliveryId } : {}),
                parse: "none", link_names: false, unfurl_links: false, unfurl_media: false,
            };
            let sent;
            try {
                sent = await client.chat.postMessage({ ...message, ...(username ? { username } : {}) });
            } catch (error) {
                if (!username || error.data?.error !== "missing_scope") throw error;
                sent = await client.chat.postMessage(message);
            }
            first ??= sent;
            thread ??= sent?.ts;
        }
        return first;
    };
}

export function createMessageHandler({
    state, runtime, bot, post, titles, resources, research,
    config = loadConfig, profiles = loadProfiles, skills = loadSkills,
}) {
    const events = new SerialQueue();
    const contextFor = (item) => ({
        team: item.team, user: item.user, channel: item.channel, thread: item.thread,
        key: item.key, profile: item.profile, fileIds: item.fileIds, messageTs: item.messageTs,
    });
    const authorizedRoute = (current, item) => {
        const route = current.channels[item.channel];
        if (current.team !== item.team || !current.users.includes(item.user) || !route || route.enabled === false ||
            profileFor(route) !== item.profile ||
            item.key !== `${current.team}:${item.channel}:${item.thread}:${route.agent}`) return null;
        return route;
    };

    async function reply(id) {
        const current = await config();
        const item = await state.update((data) => {
            const item = data.inbox[id];
            if (item.delivery !== "pending") return null;
            if (!authorizedRoute(current, item)) {
                item.delivery = "suppressed";
                return null;
            }
            item.delivery = "sending";
            return item;
        });
        if (!item) return;
        let delivery = "delivered";
        try { await post(contextFor(item), item.response); }
        catch { delivery = "uncertain"; }
        await state.update((data) => { data.inbox[id].delivery = delivery; });
    }

    async function finish(id, response, status = "processed") {
        await state.update((data) => {
            Object.assign(data.inbox[id], { status, response, delivery: "pending", completedAt: Date.now() });
        });
        await reply(id);
    }

    async function process(id) {
        const item = state.snapshot().inbox[id];
        if (item.status !== "pending") return;
        const current = await config();
        const route = authorizedRoute(current, item);
        if (!route) {
            await state.update((data) => {
                Object.assign(data.inbox[id], { status: "rejected", completedAt: Date.now() });
            });
            return;
        }
        const context = contextFor(item);
        if (research && (!parseCommand(item.prompt) || /^!research(?:\s|$)|^!stop\s*$/i.test(item.prompt))) {
            try {
                if (await research.handle(context, item.prompt, id)) {
                    await state.update((data) => {
                        Object.assign(data.inbox[id], { status: "processed", completedAt: Date.now() });
                    });
                    return;
                }
            } catch (error) {
                await finish(id, error.message, "failed");
                return;
            }
        }
        let availableProfiles;
        let availableSkills;
        let command;
        let task;
        try {
            availableProfiles = await profiles();
            availableSkills = await skills();
            if (!Object.hasOwn(availableProfiles, context.profile)) throw Error("Channel profile is unavailable");
            command = parseCommand(item.prompt);
            if (!command || ["delegate", "skill", "read"].includes(command.name)) {
                task = requestedTask(item.prompt, availableProfiles, route, availableSkills);
            }
        } catch (error) {
            await finish(id, error.message + "\nUse !help for available commands.", "failed");
            return;
        }
        if (!task) {
            await state.update((data) => { data.inbox[id].status = "processing"; });
            let response;
            try {
                response = await commandReply(command, context, {
                    state, runtime, titles, resources, profiles: availableProfiles, skills: availableSkills,
                });
                if (response === null) response = "Unknown command. Use !help";
            } catch (error) {
                response = error.message + "\nUse !help for available commands.";
            }
            await finish(id, response);
            return;
        }
        const busy = runtime.pumping;
        await state.update((data) => {
            const record = data.inbox[id];
            if (record.status !== "pending") return;
            const fileIds = [...new Set([...(task.fileIds || []), ...item.fileIds])].slice(0, 6);
            try {
                record.taskId = appendTask(data, { ...context, ...task, fileIds });
                record.status = "processed";
                data.events[id] = Date.now();
                if (busy) {
                    record.response = "Queued task " + record.taskId.slice(0, 8) + ". Use !tasks to check its status.";
                    record.delivery = "pending";
                }
            } catch (error) {
                Object.assign(record, { status: "failed", response: error.message, delivery: "pending" });
            }
            record.completedAt = Date.now();
        });
        runtime.wake();
        if (titles && state.snapshot().inbox[id].taskId) {
            try { await titles.ensure(context, task.prompt); }
            catch { console.warn("Thread title update unavailable"); }
        }
        if (state.snapshot().inbox[id].delivery === "pending") await reply(id);
    }

    async function handle({ body, event }) {
        await events.run(async () => {
            const current = await config();
            const selected = routeEvent(current, body, event, bot, (key) => !!state.snapshot().threads[key]);
            if (!selected) return;
            const accepted = await state.update((data) => {
                data.inbox ??= {};
                if (data.events[selected.eventId] || data.inbox[selected.eventId]) return false;
                const thread = data.threads[selected.key] ??= { session: null };
                if (selected.fileIds.length) {
                    thread.filesByUser ??= {};
                    thread.filesByUser[event.user] = [...new Set([
                        ...(thread.filesByUser[event.user] || []), ...selected.fileIds,
                    ])].slice(-6);
                }
                data.inbox[selected.eventId] = {
                    id: selected.eventId, team: current.team, user: event.user, channel: event.channel,
                    thread: selected.thread, key: selected.key, profile: profileFor(selected.route),
                    prompt: selected.prompt, text: event.text || "", messageTs: event.ts,
                    fileIds: thread.filesByUser?.[event.user] || [], status: "pending", createdAt: Date.now(),
                };
                for (const [id, at] of Object.entries(data.events)) {
                    if (Date.now() - at > 7 * 86400000) delete data.events[id];
                }
                for (const [id, item] of Object.entries(data.inbox)) {
                    if (item.completedAt && Date.now() - item.completedAt > 7 * 86400000 &&
                        !["pending", "sending"].includes(item.delivery)) delete data.inbox[id];
                }
                return true;
            });
            if (accepted || state.snapshot().inbox[selected.eventId]?.status === "pending") {
                await process(selected.eventId);
            }
        });
    }

    async function recover() {
        await events.run(async () => {
            await state.update((data) => {
                data.inbox ??= {};
                for (const item of Object.values(data.inbox)) {
                    if (item.status === "processing") {
                        Object.assign(item, {
                            status: "uncertain", delivery: "pending", completedAt: Date.now(),
                            response: "Command execution was interrupted and may have completed. " +
                                "Check its result before sending the command again.",
                        });
                    } else if (item.delivery === "sending") item.delivery = "uncertain";
                }
            });
            for (const [id, item] of Object.entries(state.snapshot().inbox)) {
                if (item.status === "pending") await process(id);
                else if (item.delivery === "pending") await reply(id);
            }
        });
    }
    return { handle, recover, idle: () => events.tail };
}
