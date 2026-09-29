import test from "node:test";
import assert from "node:assert/strict";
import { diagnostic, failureCode, failureMessage, logFailure, providerError } from "../../src/shared/diagnostics.js";

test("provider classification", () => {
    for (const [message, code] of [
        ["401 invalid token sk-fake-secret", "AUTH_REQUIRED"],
        ["Rate limit exceeded", "RATE_LIMITED"],
        ["ECONNRESET https://private.example/token", "PROVIDER_UNAVAILABLE"],
        ["Request timed out", "TASK_TIMEOUT"],
        ["Unexpected response", "PROVIDER_FAILED"],
    ]) {
        const error = providerError("claude", Error(message));
        assert.equal(error.code, code);
        assert.equal(error.provider, "claude");
        assert.equal(error.message, failureMessage(code));
        assert.ok(!JSON.stringify(error).includes("secret"));
    }
    assert.equal(providerError("codex", { code: "ENOENT" }).code, "PROVIDER_START_FAILED");
    assert.equal(providerError("codex", { code: "PROVIDER_PROTOCOL", message: "401" }).code, "PROVIDER_PROTOCOL");
    assert.equal(failureCode({ code: "sk-fake-secret" }), "WORKER_FAILED");
});

test("private diagnostics", () => {
    const error = Object.assign(Error("Authorization Bearer sk-fake-secret"), {
        code: "AUTH_REQUIRED", detail: "private payload", stack: "private stack", status: 401,
    });
    const logs = [];
    const context = { component: "worker", provider: "codex", stage: "explore",
        taskId: "12345678-1234-1234-1234-123456789abc", prompt: "private prompt" };
    logFailure(error, context, (line) => logs.push(line));
    assert.deepEqual(JSON.parse(logs[0]), { event: "operation_failed", code: "AUTH_REQUIRED",
        component: "worker", provider: "codex", stage: "explore", taskId: context.taskId, status: 401 });
    assert.equal(diagnostic({ data: { error: "invalid_auth" } }).code, "SLACK_AUTH_REQUIRED");
    assert.equal(diagnostic({ data: { error: "ratelimited" } }).code, "SLACK_RATE_LIMITED");
    assert.equal(diagnostic({ code: "slack_webapi_request_error" }).code, "SLACK_UNAVAILABLE");
});
