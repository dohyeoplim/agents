import messages from "./diagnostics.json" with { type: "json" };

const known = (code) => typeof code === "string" && Object.hasOwn(messages, code);

export function failureCode(error, fallback = "WORKER_FAILED") {
    if (known(error?.code)) return error.code;
    if (error?.name === "AbortError") return "TASK_CANCELLED";
    if (error?.name === "TimeoutError") return "TASK_TIMEOUT";
    return known(fallback) ? fallback : "WORKER_FAILED";
}

export function failureMessage(code) {
    return messages[known(code) ? code : "WORKER_FAILED"];
}

export function providerError(provider, reason, fallback = "PROVIDER_FAILED") {
    let code = failureCode(reason, fallback);
    if (!known(reason?.code)) {
        const value = typeof reason === "string" ? reason : reason?.message;
        const text = typeof value === "string" ? value.slice(-16384) : "";
        const auth = /\b(?:401|unauthorized|authentication|not authenticated|not logged in|login required)\b/i;
        const credential = /(?:invalid|expired|revoked).{0,30}(?:token|credential|api.?key)/i;
        if (auth.test(text) || credential.test(text) || /(?:token|credential).{0,30}expired/i.test(text)) {
            code = "AUTH_REQUIRED";
        }
        else if (/\b429\b|rate.?limit|usage.?limit|quota|overloaded/i.test(text)) code = "RATE_LIMITED";
        else if (/\b(?:502|503|504|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|service unavailable|fetch failed/i
            .test(text)) code = "PROVIDER_UNAVAILABLE";
        else if (/\bETIMEDOUT\b|timed? ?out|timeout/i.test(text)) code = "TASK_TIMEOUT";
        else if (/\bENOENT\b/.test(text) || reason?.code === "ENOENT") code = "PROVIDER_START_FAILED";
    }
    return Object.assign(Error(failureMessage(code)), { code,
        ...(["codex", "claude"].includes(provider) ? { provider } : {}) });
}

export function diagnostic(error, context = {}) {
    const output = { event: "operation_failed", code: failureCode(error) };
    for (const name of ["component", "provider", "stage"]) {
        const value = context[name] ?? error?.[name];
        if (typeof value === "string" && /^[a-z][a-z_-]{0,39}$/.test(value)) output[name] = value;
    }
    if (typeof context.taskId === "string" && /^[0-9a-f-]{36}$/i.test(context.taskId)) {
        output.taskId = context.taskId;
    }
    const version = output.provider === "codex" ? process.env.CODEX_CLI_VERSION :
        output.provider === "claude" ? process.env.CLAUDE_CLI_VERSION : undefined;
    if (typeof version === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)) output.version = version;
    const status = error?.statusCode ?? error?.status ?? error?.data?.status;
    if (Number.isInteger(status) && status >= 400 && status <= 599) output.status = status;
    const slackCode = error?.data?.error ?? error?.code;
    if (["invalid_auth", "token_revoked", "token_expired", "not_authed", "missing_scope", "ratelimited",
        "channel_not_found", "not_in_channel", "message_not_found", "invalid_blocks", "invalid_arguments",
        "slack_webapi_rate_limited_error", "slack_webapi_request_error", "slack_webapi_http_error",
    ].includes(slackCode)) output.reason = slackCode;
    if (["invalid_auth", "token_revoked", "token_expired", "not_authed", "missing_scope"].includes(slackCode)) {
        output.code = "SLACK_AUTH_REQUIRED";
    } else if (["ratelimited", "slack_webapi_rate_limited_error"].includes(slackCode)) {
        output.code = "SLACK_RATE_LIMITED";
    } else if (["slack_webapi_request_error", "slack_webapi_http_error"].includes(slackCode)) {
        output.code = "SLACK_UNAVAILABLE";
    }
    return output;
}

export function logFailure(error, context, sink = console.error) {
    sink(JSON.stringify(diagnostic(error, context)));
}
