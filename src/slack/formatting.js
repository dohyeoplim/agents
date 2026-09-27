export function redactSecrets(text) {
    return text.replace(/\b(?:xox[baprs]-|xapp-|sk-)[A-Za-z0-9_-]+/g, "[REDACTED]");
}

function plainMentions(text) {
    return text.split(/(`+[^`]*`+)/g).map((part) => part.startsWith("`") ? part : part
        .replace(/<(@[UW][A-Z0-9]+|!(?:here|channel|everyone|subteam\^[^>]+))>/g, "&lt;$1&gt;")
        .replace(/@(here|channel|everyone)\b/g, "@\u200b$1")).join("");
}

function take(text, count) {
    if (count < text.length && /[\uD800-\uDBFF]/.test(text[count - 1] || "")) count--;
    return text.slice(0, count);
}

export function markdownMessages(text, limit = 11000) {
    if (!Number.isInteger(limit) || limit < 300 || limit > 12000) throw Error("Invalid message limit");
    const safe = take(redactSecrets(text), 28000);
    if (!safe.trim()) return ["No response text."];
    const messages = [];
    let buffer = "";
    let fence = null;
    const flush = () => {
        if (!buffer) return;
        messages.push(buffer + (fence ? "\n" + fence.marker : ""));
        buffer = fence ? fence.marker + fence.language + "\n" : "";
    };
    for (const raw of safe.match(/[^\n]*\n|[^\n]+$/g) || []) {
        const marker = /^ {0,3}(`{3,32}|~{3,32})([^\n]*)\n?$/.exec(raw);
        let line = fence || marker ? raw : plainMentions(raw);
        while (line.length) {
            const room = limit - 160 - buffer.length;
            if (room < 2) {
                flush();
                continue;
            }
            const prefixLength = fence ? fence.marker.length + fence.language.length + 1 : 0;
            if (line.length > room && buffer.length > prefixLength && line.length < limit - 160) {
                flush();
                continue;
            }
            const piece = take(line, room);
            buffer += piece;
            line = line.slice(piece.length);
            if (line.length) flush();
        }
        if (marker) {
            if (!fence) fence = { marker: marker[1], language: marker[2].trim().slice(0, 80) };
            else if (marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) {
                fence = null;
            }
        }
    }
    flush();
    return messages;
}
