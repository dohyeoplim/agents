export function argumentError(error, schema) {
    const known = new Set(Object.keys(schema.properties ?? {}));
    const issues = error.issues.slice(0, 4).map((issue) => {
        const field = known.has(issue.path[0]) ? issue.path[0] : "arguments";
        const rule = schema.properties?.[field] ?? {};
        if (issue.code === "too_small" || issue.code === "too_big") {
            const bound = issue.code === "too_small" ? issue.minimum : issue.maximum;
            const unit = issue.origin === "string" ? " characters" : "";
            return `${field}: must be ${issue.code === "too_small" ? "at least" : "at most"} ${bound}${unit}`;
        }
        if (issue.code === "invalid_type") return `${field}: expected ${issue.expected}`;
        if (issue.code === "invalid_format" && rule.format === "uuid") return `${field}: must be a valid UUID`;
        if (issue.code === "unrecognized_keys") return "arguments: remove fields not listed in the tool schema";
        return `${field}: does not match the tool schema`;
    });
    return Error(`Invalid tool arguments. ${issues.join("; ")}. Correct the input and retry; nothing was executed.`);
}
