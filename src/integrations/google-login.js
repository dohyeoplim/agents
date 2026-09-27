import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchJson } from "./http.js";

export async function googleLogin(file, root) {
    const client = JSON.parse(await readFile(file, "utf8"));
    if (typeof client.installed?.client_id !== "string" || typeof client.installed.client_secret !== "string") {
        throw Error("Use a Google OAuth desktop client JSON file");
    }
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const scope = "https://www.googleapis.com/auth/calendar.events.readonly";
    let resolveLogin;
    let rejectLogin;
    let redirect;
    let consumed = false;
    const done = new Promise((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject; });
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, redirect);
        if (req.method !== "GET" || url.pathname !== "/callback" ||
            url.searchParams.get("state") !== state || consumed) {
            res.writeHead(400).end("Invalid authorization response");
            return;
        }
        consumed = true;
        try {
            const code = url.searchParams.get("code");
            if (!code || url.searchParams.has("error")) throw Error("Google authorization was not completed");
            const token = await fetchJson("https://oauth2.googleapis.com/token", {
                method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ code, client_id: client.installed.client_id,
                    client_secret: client.installed.client_secret, redirect_uri: redirect,
                    grant_type: "authorization_code", code_verifier: verifier }),
            });
            if (typeof token.refresh_token !== "string" || !token.scope?.split(" ").includes(scope)) {
                throw Error("Google did not grant offline calendar access");
            }
            await mkdir(root, { recursive: true, mode: 0o700 });
            await writeFile(path.join(root, "google-client.json"), JSON.stringify({ installed: {
                client_id: client.installed.client_id, client_secret: client.installed.client_secret,
            } }), { mode: 0o600 });
            await writeFile(path.join(root, "google-token.json"), JSON.stringify({
                refresh_token: token.refresh_token, scope, calendarIds: ["primary"],
            }), { mode: 0o600 });
            res.end("Google Calendar connected. You can close this tab.");
            resolveLogin();
        } catch {
            res.writeHead(400).end("Google Calendar authorization failed.");
            rejectLogin(Error("Google Calendar authorization failed"));
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    redirect = `http://127.0.0.1:${server.address().port}/callback`;
    const query = new URLSearchParams({ client_id: client.installed.client_id, redirect_uri: redirect,
        response_type: "code", scope, state, code_challenge: challenge, code_challenge_method: "S256",
        access_type: "offline", prompt: "consent" });
    console.log("Open this URL to connect Google Calendar:\nhttps://accounts.google.com/o/oauth2/v2/auth?" + query);
    const timer = setTimeout(() => rejectLogin(Error("Google login timed out")), 180000);
    try { await done; console.log("Google Calendar connected"); }
    finally {
        clearTimeout(timer);
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}
