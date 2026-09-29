const events = new Set(["task_started", "task_completed", "remote_submitted", "remote_finished",
    "remote_cancel_requested",
    "remote_failed", "remote_checked", "campaign_started", "campaign_stage", "campaign_command", "campaign_completed",
    "campaign_limited", "campaign_blocked", "campaign_paused", "campaign_cancelled", "campaign_interrupted",
    "campaign_failed", "tool_rejected"]);
const values = new Set(["codex", "claude", "remote", "autoresearch", "worker", "tools", "planning", "executing",
    "reviewing", "reporting", "campaign", "campaign-review", "clarify", "explore", "counter", "synthesize", "review",
    "revise", "canvas", "starting", "running", "queued", "completed", "failed", "cancelled", "timed_out",
    "interrupted", "limited", "paused", "awaiting_input", "connected", "disconnected", "invalid_arguments",
    "reserved"]);
const tools = new Set(["remote_status", "remote_exec", "remote_jobs", "remote_job", "remote_cancel", "remote_read",
    "remote_write", "autoresearch_campaign", "autoresearch_control", "autoresearch_propose", "autoresearch_result"]);
const fields = new Set(["id", "command", "cwd", "timeoutSeconds", "offset", "path", "content", "expectedHash",
    "revision", "action", "title", "objective", "deadline", "timezone", "questions"]);
const codes = new Set(["REMOTE_CONNECT", "REMOTE_PROTOCOL", "REMOTE_TIMEOUT", "REMOTE_OUTPUT", "TASK_CANCELLED",
    "REMOTE_OPERATION_FAILED", "REMOTE_ID_CONFLICT", "REMOTE_FILE_CHANGED", "REMOTE_FILE_INVALID"]);

export function logEvent(event, context = {}, sink = console.info) {
    if (!events.has(event)) return;
    const record = { event, at: new Date().toISOString() };
    for (const name of ["taskId", "campaignId", "runId", "jobId"]) {
        if (typeof context[name] === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(context[name])) {
            record[name] = context[name];
        }
    }
    for (const name of ["component", "provider", "stage", "status"]) {
        if (values.has(context[name])) record[name] = context[name];
    }
    for (const name of ["steps", "commands", "reservedGpuSeconds", "durationMs", "exitCode"]) {
        if (Number.isSafeInteger(context[name])) record[name] = context[name];
    }
    if (codes.has(context.code)) record.code = context.code;
    if (tools.has(context.tool)) record.tool = context.tool;
    if (fields.has(context.field)) record.field = context.field;
    try { sink(JSON.stringify(record)); } catch {}
}
