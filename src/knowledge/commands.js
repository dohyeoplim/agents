import { addEntry, forgetEntry, searchEntries, visibleEntries } from "./memory.js";
import { splitFirst } from "../shared/text.js";

export async function knowledgeCommand(command, context, store) {
    const { name, args } = command;
    if (name === "remember" || name === "note") {
        const [scope, body] = splitFirst(args);
        let title = "";
        let text = body;
        if (name === "note") {
            const separator = body.indexOf("|");
            if (separator < 1) throw Error("Use !note <scope> <title> | <text>");
            title = body.slice(0, separator).trim();
            text = body.slice(separator + 1).trim();
        }
        const id = await store.update((data) => addEntry(data, context, {
            kind: name === "note" ? "note" : "memory", scope, title, text,
        }));
        return `Saved ${name === "note" ? "note" : "memory"}: ${id}`;
    }
    if (name === "forget") {
        await store.update((data) => forgetEntry(data, context, args));
        return "Entry removed from saved memory. Existing conversations may still contain it.";
    }
    if (name === "memories" || name === "search") {
        const entries = name === "memories"
            ? visibleEntries(store.snapshot(), context).filter((entry) => entry.kind === "memory")
            : searchEntries(store.snapshot(), context, args, 10);
        return entries.map((entry) => `${entry.id} [${entry.scope}] ${entry.title}\n${entry.text}`).join("\n\n") ||
            "No matching entries";
    }
    return null;
}
