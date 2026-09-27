export async function discoverChannels(token, team, request = fetch) {
    if (!token) throw Error("SLACK_BOT_TOKEN is missing");
    async function call(method, params = {}) {
        const response = await request(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error("Slack request failed");
        const result = await response.json();
        if (!result.ok) {
            if (result.error === "missing_scope") {
                throw Error("Add channels:read to Bot Token Scopes and reinstall the Slack app");
            }
            throw Error("Slack request was rejected");
        }
        return result;
    }
    const identity = await call("auth.test");
    if (identity.team_id !== team) throw Error("Slack workspace mismatch");
    const channels = [];
    const cursors = new Set();
    let cursor = "";
    do {
        const page = await call("conversations.list", {
            types: "public_channel",
            exclude_archived: "true",
            limit: "200",
            cursor,
        });
        if (!Array.isArray(page.channels)) throw Error("Invalid Slack channel list");
        for (const channel of page.channels) {
            if (typeof channel.id !== "string" || typeof channel.name !== "string") {
                throw Error("Invalid Slack channel");
            }
            channels.push({ id: channel.id, name: channel.name, member: channel.is_member === true });
        }
        cursor = page.response_metadata?.next_cursor || "";
        if (typeof cursor !== "string" || (cursor && cursors.has(cursor))) {
            throw Error("Invalid Slack pagination");
        }
        cursors.add(cursor);
    } while (cursor);
    return channels;
}
