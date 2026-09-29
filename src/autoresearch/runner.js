export const offlineRunner = Object.freeze({
    status() {
        return { available: false, reason: "not_configured" };
    },
    async submit() {
        throw Object.assign(Error("Autoresearch runner is not configured"), { code: "RUNNER_UNAVAILABLE" });
    },
});
