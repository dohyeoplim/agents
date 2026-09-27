export function isFileId(value) {
    return typeof value === "string" && /^F[A-Z0-9]{6,}$/.test(value);
}

export function slackFileIds(text) {
    const ids = new Set();
    for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
        try {
            const url = new URL(match[0].split("|")[0].replace(/[),.;]+$/, ""));
            if (url.hostname !== "slack.com" && !url.hostname.endsWith(".slack.com")) continue;
            for (const part of url.pathname.split("/")) if (isFileId(part)) ids.add(part);
        } catch {}
    }
    return [...ids];
}

export function fileKind(file) {
    if (file.mimetype === "application/pdf" || file.filetype === "pdf") return "pdf";
    if (["quip", "canvas", "html"].includes(file.filetype) ||
        ["text/html", "application/vnd.slack-docs"].includes(file.mimetype)) return "html";
    if (file.mimetype?.startsWith("text/") ||
        ["application/json", "application/xml", "application/javascript"].includes(file.mimetype) ||
        ["text", "markdown", "md", "csv", "json", "yaml", "yml", "xml"].includes(file.filetype)) return "text";
    return null;
}

export function fileChannels(file) {
    return new Set([
        ...(file.channels || []), ...(file.groups || []), ...(file.ims || []), file.linked_channel_id,
        ...Object.keys(file.shares?.public || {}), ...Object.keys(file.shares?.private || {}),
    ].filter(Boolean));
}
