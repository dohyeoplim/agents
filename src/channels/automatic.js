import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { loadConfig, validate } from "./config.js";
import { channelRoles } from "./registry.js";

export function createAutomaticChannels({ client, team, bot, file, config = loadConfig,
    report = () => console.error("Automatic channel sync failed; check Slack scopes and app installation") }) {
    let tail = Promise.resolve();
    let scanning;
    let stopped = false;
    const enqueue = (work) => {
        if (stopped) return Promise.resolve();
        const next = tail.then(work);
        tail = next.catch(report);
        return next;
    };
    async function register(channel) {
        if (!channel || typeof channel.id !== "string" || !/^[CG][A-Z0-9]+$/.test(channel.id) || channel.is_archived ||
            channel.is_im || channel.is_mpim) return;
        if (!channel.is_member) {
            if (channel.is_private) return;
            const joined = await client.conversations.join({ channel: channel.id });
            if (!joined.ok) throw Error("Channel join failed");
        }
        const current = await config();
        if (current.team !== team) throw Error("Slack workspace mismatch");
        if (current.channels[channel.id]) return;
        let saved = { team, channels: {} };
        try {
            saved = JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        if (saved.team !== team) throw Error("Automatic channel workspace mismatch");
        validate({ ...current, channels: saved.channels });
        const name = typeof channel.name === "string" && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(channel.name)
            ? channel.name : channel.id.toLowerCase();
        saved.channels[channel.id] ||= {
            name, agent: "assistant", cwd: channel.id.toLowerCase(), enabled: true,
            instructions: channelRoles[name] || "Help the user with this channel's work.",
        };
        validate({ ...current, channels: saved.channels });
        const temporary = `${file}.tmp`;
        try {
            await writeFile(temporary, JSON.stringify(saved) + "\n", { mode: 0o600 });
            await rename(temporary, file);
        } finally {
            await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
        }
    }
    function sync() {
        if (scanning) return scanning;
        scanning = enqueue(async () => {
            let cursor;
            const cursors = new Set();
            do {
                const page = await client.conversations.list({
                    types: "public_channel,private_channel", exclude_archived: true, limit: 200, cursor,
                });
                if (!page.ok || !Array.isArray(page.channels)) throw Error("Invalid Slack channel list");
                for (const channel of page.channels) {
                    try { await register(channel); } catch (error) { report(error); }
                }
                cursor = page.response_metadata?.next_cursor;
                if (cursor && (typeof cursor !== "string" || cursors.has(cursor))) {
                    throw Error("Invalid Slack pagination");
                }
                cursors.add(cursor);
            } while (cursor);
        }).finally(() => { scanning = undefined; });
        return scanning;
    }
    return {
        sync,
        handle({ body, event }) {
            if (body.team_id !== team) return Promise.resolve();
            if (event.type === "member_joined_channel" && event.user !== bot) return Promise.resolve();
            const id = event.type === "channel_created" ? event.channel?.id : event.channel;
            if (typeof id !== "string" || !/^[CG][A-Z0-9]+$/.test(id)) return Promise.resolve();
            return enqueue(async () => {
                const result = await client.conversations.info({ channel: id });
                if (!result.ok) throw Error("Channel lookup failed");
                await register(result.channel);
            });
        },
        async stop() { stopped = true; await tail; },
    };
}
