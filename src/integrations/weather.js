import { createPrivateKey, sign } from "node:crypto";
import { fetchJson } from "./http.js";
import { loadSecret, readPrivateKey } from "./settings.js";

export function weatherToken(credentials, key, now = Date.now()) {
    const { teamId, keyId, serviceId } = credentials;
    if (![teamId, keyId].every((value) => typeof value === "string" && /^[A-Z0-9]{10}$/.test(value)) ||
        typeof serviceId !== "string" || !/^[a-zA-Z0-9.-]{3,200}$/.test(serviceId)) {
        throw Error("Invalid WeatherKit identifiers");
    }
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const iat = Math.floor(now / 1000);
    const input = encode({ alg: "ES256", kid: keyId, id: `${teamId}.${serviceId}` }) + "." +
        encode({ iss: teamId, sub: serviceId, iat, exp: iat + 300 });
    const signature = sign("sha256", Buffer.from(input), {
        key: createPrivateKey(key), dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    return input + "." + signature;
}

export function createWeather({ secretRoot, request = fetch, now = Date.now } = {}) {
    let cache;
    return async function forecast(personal, signal) {
        const location = personal?.briefing.weather;
        if (!Number.isFinite(location?.latitude) || !Number.isFinite(location?.longitude)) {
            throw Error("Set weather coordinates in private settings");
        }
        const key = JSON.stringify(location);
        if (cache?.key === key && cache.until > now()) return cache.value;
        const credentials = await loadSecret("weatherkit.json", secretRoot);
        const token = weatherToken(credentials, await readPrivateKey(credentials.keyFile, secretRoot), now());
        const language = personal.briefing.language;
        const base = "https://weatherkit.apple.com/api/v1";
        const params = new URLSearchParams({
            dataSets: "currentWeather,forecastDaily,forecastHourly", timezone: personal.briefing.timezone,
        });
        const data = await fetchJson(`${base}/weather/${encodeURIComponent(language)}/` +
            `${location.latitude}/${location.longitude}?${params}`, {
            request, signal, headers: { Authorization: "Bearer " + token },
        });
        if (!data.currentWeather || !Array.isArray(data.forecastDaily?.days)) throw Error("Invalid weather response");
        const branding = await fetchJson("https://weatherkit.apple.com/attribution/" + encodeURIComponent(language),
            { request, signal });
        const mark = branding["logoSquare@2x"];
        if (typeof mark !== "string" || !mark.startsWith("/assets/branding/")) {
            throw Error("Weather attribution unavailable");
        }
        const value = { location: location.location, timezone: personal.briefing.timezone,
            retrievedAt: new Date(now()).toISOString(), current: data.currentWeather,
            days: data.forecastDaily.days.slice(0, 2), hours: data.forecastHourly?.hours?.slice(0, 24) || [],
            attribution: { name: "Apple Weather", legalUrl: "https://weatherkit.apple.com/legal-attribution.html",
                markUrl: "https://weatherkit.apple.com" + mark } };
        cache = { key, value, until: now() + 15 * 60000 };
        return value;
    };
}
