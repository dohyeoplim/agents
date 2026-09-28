export async function workerResponse(response, onText, { longRunning = false, onProgress } = {}) {
    if (!response.headers?.get("content-type")?.includes("application/x-ndjson")) return response.json();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;
    let result;
    for await (const part of response.body) {
        bytes += part.length;
        if (!longRunning && bytes > 16 * 1024 * 1024) throw Error("Worker response too large");
        buffer += decoder.decode(part, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            if (newline > 1024 * 1024) throw Error("Worker event too large");
            const event = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (event.type === "error") {
                const stalled = event.code === "RESEARCH_STALLED";
                const message = stalled
                    ? "Research stopped after no provider execution events within the inactivity limit"
                    : "Worker failed";
                throw Object.assign(Error(message), { code: stalled ? "RESEARCH_STALLED" : undefined });
            }
            if (event.type === "text") {
                if (typeof event.text !== "string" || event.text.length > 28000) throw Error("Invalid stream text");
                await onText?.(event.text);
            }
            if (event.type === "progress") {
                if (!Number.isSafeInteger(event.providerEvents) || event.providerEvents <= 0 ||
                    !Number.isSafeInteger(event.lastActivityAt) || event.lastActivityAt <= 0) {
                    throw Error("Invalid worker progress");
                }
                await onProgress?.({ providerEvents: event.providerEvents, lastActivityAt: event.lastActivityAt });
            }
            if (event.type === "result") result = event;
        }
        if (buffer.length > 1024 * 1024) throw Error("Worker event too large");
    }
    if (buffer.trim() || !result) throw Error("Worker response interrupted");
    return result;
}
