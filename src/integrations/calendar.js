import { fetchJson } from "./http.js";
import { loadSecret } from "./settings.js";

export function createCalendar({ secretRoot, request = fetch, now = Date.now } = {}) {
    let access;
    async function token(signal) {
        if (access?.until > now() + 60000) return access.value;
        const client = await loadSecret("google-client.json", secretRoot);
        const saved = await loadSecret("google-token.json", secretRoot);
        const credentials = client.installed;
        if (typeof credentials?.client_id !== "string" || typeof credentials.client_secret !== "string" ||
            typeof saved.refresh_token !== "string") throw Error("Google Calendar needs authorization");
        const result = await fetchJson("https://oauth2.googleapis.com/token", {
            request, signal, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: credentials.client_id, client_secret: credentials.client_secret,
                refresh_token: saved.refresh_token, grant_type: "refresh_token" }),
        });
        if (typeof result.access_token !== "string" || !Number.isFinite(result.expires_in)) {
            throw Error("Google Calendar authorization failed");
        }
        access = { value: result.access_token, until: now() + result.expires_in * 1000 };
        return access.value;
    }
    return async function events({ from, to }, personal, signal) {
        const settings = await loadSecret("google-token.json", secretRoot);
        const ids = settings.calendarIds || ["primary"];
        if (!Array.isArray(ids) || ids.length > 10 || ids.some((id) => typeof id !== "string" || id.length > 300)) {
            throw Error("Invalid calendar selection");
        }
        const all = [];
        const notices = [];
        for (const id of ids) {
            let pageToken;
            for (let page = 0; page < 5; page++) {
                const query = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: "true",
                    orderBy: "startTime", maxResults: "100", timeZone: personal?.briefing.timezone || "UTC",
                    ...(pageToken ? { pageToken } : {}) });
                const data = await fetchJson("https://www.googleapis.com/calendar/v3/calendars/" +
                    encodeURIComponent(id) + "/events?" + query, {
                    request, signal, headers: { Authorization: "Bearer " + await token(signal) },
                });
                if (!Array.isArray(data.items)) throw Error("Invalid calendar response");
                all.push(...data.items.filter((item) => item.status !== "cancelled").map((item) => ({
                    id: item.id, calendar: id, title: item.summary || "Busy", start: item.start, end: item.end,
                    location: item.location, url: item.htmlLink,
                })));
                pageToken = data.nextPageToken;
                if (!pageToken) break;
                if (page === 4) notices.push("Calendar results were truncated");
            }
        }
        return { events: all, notices, retrievedAt: new Date(now()).toISOString() };
    };
}
