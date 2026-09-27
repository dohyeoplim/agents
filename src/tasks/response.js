export async function workerResponse(response, onText) {
    if (!response.headers?.get("content-type")?.includes("application/x-ndjson")) return response.json();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;
    let result;
    for await (const part of response.body) {
        bytes += part.length;
        if (bytes > 16 * 1024 * 1024) throw Error("Worker response too large");
        buffer += decoder.decode(part, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const event = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (event.type === "error") throw Error("Worker failed");
            if (event.type === "text") {
                if (typeof event.text !== "string" || event.text.length > 28000) throw Error("Invalid stream text");
                await onText?.(event.text);
            }
            if (event.type === "result") result = event;
        }
    }
    if (buffer.trim() || !result) throw Error("Worker response interrupted");
    return result;
}
