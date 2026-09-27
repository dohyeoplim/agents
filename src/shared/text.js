export function chunks(text, size = 2800) {
    const chars = Array.from(text);
    return Array.from({ length: Math.ceil(chars.length / size) }, (_, i) =>
        chars.slice(i * size, (i + 1) * size).join(""),
    );
}

export function parseCommand(prompt) {
    if (!prompt.startsWith("!")) return null;
    const match = /^!([a-z]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
    if (!match) throw Error("Invalid command. Use !help");
    return { name: match[1], args: (match[2] || "").trim() };
}

export function splitFirst(text) {
    const index = text.search(/\s/);
    return index < 0 ? [text, ""] : [text.slice(0, index), text.slice(index).trim()];
}
