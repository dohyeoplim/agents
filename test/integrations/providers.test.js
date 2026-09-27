import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { weatherToken, createWeather } from "../../src/integrations/weather.js";
import { createCalendar } from "../../src/integrations/calendar.js";
import { fetchBytes } from "../../src/integrations/http.js";

const credentials = { teamId: "ABCDEFGHIJ", keyId: "KLMNOPQRST", serviceId: "com.example.weather", keyFile: "key.p8" };

test("weather signature", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const token = weatherToken(credentials, privateKey.export({ type: "pkcs8", format: "pem" }), 1000000);
    const [header, payload, signature] = token.split(".");
    assert.equal(JSON.parse(Buffer.from(payload, "base64url")).exp, 1300);
    assert.equal(JSON.parse(Buffer.from(header, "base64url")).id, "ABCDEFGHIJ.com.example.weather");
    assert.ok(verify("sha256", Buffer.from(header + "." + payload),
        { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
});

test("weather cache", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "weather-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await writeFile(path.join(root, "key.p8"), privateKey.export({ type: "pkcs8", format: "pem" }));
    await writeFile(path.join(root, "weatherkit.json"), JSON.stringify(credentials));
    let calls = 0;
    const weather = createWeather({ secretRoot: root, request: async (url) => {
        calls++;
        return Response.json(url.pathname.includes("attribution") ? { "logoSquare@2x": "/assets/branding/logo.png" } :
            { currentWeather: { temperature: 20 }, forecastDaily: { days: [{}] }, forecastHourly: { hours: [] } });
    } });
    const settings = { briefing: { language: "en", timezone: "UTC",
        weather: { location: "Test", latitude: 1, longitude: 2 } } };
    const first = await weather(settings);
    assert.equal(first.current.temperature, 20);
    await weather(settings);
    assert.equal(calls, 2);
});

test("provider redirects", async () => {
    const calls = [];
    await assert.rejects(fetchBytes("https://provider.example/file", { request: async (url) => {
        calls.push(url.hostname);
        return new Response(null, { status: 302, headers: { location: "https://other.example/" } });
    }, headers: { Authorization: "Bearer private" } }), /Untrusted/);
    assert.deepEqual(calls, ["provider.example"]);
});

test("calendar paging", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calendar-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "google-client.json"), JSON.stringify({
        installed: { client_id: "client", client_secret: "secret" },
    }));
    await writeFile(path.join(root, "google-token.json"), JSON.stringify({ refresh_token: "refresh" }));
    const calls = [];
    const calendar = createCalendar({ secretRoot: root, request: async (url, options) => {
        calls.push(url);
        if (url.hostname === "oauth2.googleapis.com") {
            return Response.json({ access_token: "access", expires_in: 3600 });
        }
        assert.equal(options.headers.Authorization, "Bearer access");
        assert.equal(url.searchParams.get("singleEvents"), "true");
        return Response.json(url.searchParams.has("pageToken") ? { items: [{ id: "2", summary: "Second" }] } :
            { items: [{ id: "1", summary: "First", start: { date: "2026-01-01" } }], nextPageToken: "next" });
    } });
    const result = await calendar({ from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" });
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].start.date, "2026-01-01");
    assert.equal(calls.filter((url) => url.hostname === "oauth2.googleapis.com").length, 1);
});
