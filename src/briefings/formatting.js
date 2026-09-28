export function formatBriefing(text) {
    const result = [];
    let fence;
    for (const line of text.split("\n")) {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker) {
            if (!fence) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        }
        if (!fence && /^#{1,6}\s+\S/.test(line)) {
            if (result.length && result.at(-1) !== "") result.push("");
            result.push(line, "");
        } else if (line || result.at(-1) !== "") result.push(line);
    }
    return result.join("\n").trim();
}
