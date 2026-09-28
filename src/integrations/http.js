export async function fetchBytes(url, {
    request = fetch, signal, limit = 5 * 1024 * 1024, hosts = [new URL(url).hostname], ...options
} = {}) {
    let target = new URL(url);
    for (let redirects = 0; redirects < 4; redirects++) {
        if (target.protocol !== "https:" || !hosts.includes(target.hostname) || target.username || target.password ||
            (target.port && target.port !== "443")) throw Error("Untrusted provider URL");
        const response = await request(target, { ...options, redirect: "manual",
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]) });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location) throw Error("Invalid provider redirect");
            target = new URL(location, target);
            continue;
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw Object.assign(Error(response.status === 429 ? "Provider rate limit reached; try again later" :
                `Provider request failed (${response.status})`), { status: response.status });
        }
        if (Number(response.headers.get("content-length")) > limit) {
            await response.body?.cancel();
            throw Error("Provider response exceeds size limit");
        }
        const parts = [];
        let size = 0;
        for await (const part of response.body) {
            size += part.length;
            if (size > limit) throw Error("Provider response exceeds size limit");
            parts.push(part);
        }
        return Buffer.concat(parts);
    }
    throw Error("Too many provider redirects");
}

export async function fetchJson(url, options) {
    return JSON.parse((await fetchBytes(url, options)).toString("utf8"));
}
