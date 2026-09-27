function excerpt(text, query) {
    const ignored = new Set(["the", "and", "for", "this", "that", "file", "canvas", "source", "summarize", "please"]);
    const terms = (query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])
        .filter((term) => !ignored.has(term)).slice(0, 20);
    const lower = text.toLowerCase();
    const ranges = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0)
        .map((index) => [Math.max(0, index - 400), Math.min(text.length, index + 1200)])
        .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
        else merged.push(range);
    }
    return (merged.length ? merged.map(([start, end]) => text.slice(start, end)).join("\n...\n") : text).slice(0, 4000);
}

export function resourceContext(result, query = "") {
    const sources = result.sources.map((source) => {
        const text = excerpt(source.text, query);
        return {
            id: source.id, title: source.title, url: source.url,
            text, truncated: source.truncated || text !== source.text,
        };
    });
    while (JSON.stringify(sources).length > 15000 && sources.length) {
        const longest = sources.reduce((a, b) => a.text.length > b.text.length ? a : b);
        longest.text = longest.text.slice(0, Math.max(0, longest.text.length - 1000));
        longest.truncated = true;
        if (!longest.text) sources.splice(sources.indexOf(longest), 1);
    }
    return JSON.stringify({ sources, notices: result.notices.slice(0, 8) });
}

export function sourceList(catalog) {
    const lines = catalog.items.slice(0, 50).map((item) => {
        const title = (item.title || "Untitled").replace(/[\[\]\n]/g, " ");
        return item.id ? `- ${title} - \`${item.id}\`` : `- ${title} (external link)`;
    });
    for (const folder of catalog.folders) {
        lines.unshift(`Folder: ${folder.title} (${folder.children} API-visible items)`);
    }
    if (!lines.length) lines.push("No readable files were found in this channel");
    lines.push(...catalog.notices);
    return lines.join("\n");
}
