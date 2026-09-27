export async function withSlackActivity({ token, channel, thread, request = fetch }, task) {
    let method = "agents.sessions.setStatus";
    let legacy = false;
    let enabled = true;
    async function update(status) {
        const response = await request(`https://slack.com/api/${method}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                channel_id: channel,
                thread_ts: thread,
                status: legacy ? (status === "processing" ? "is working on your request..." : "") : status,
            }),
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw Error("Status request failed");
        const result = await response.json();
        if (!result.ok) {
            const fallbackErrors = ["unknown_method", "feature_disabled", "deprecated_endpoint", "not_authorized"];
            if (!legacy && fallbackErrors.includes(result.error)) {
                legacy = true;
                method = "assistant.threads.setStatus";
                return update(status);
            }
            throw Error("Status update failed");
        }
    }
    async function safelyUpdate(status) {
        try {
            await update(status);
        } catch {
            enabled = false;
            console.warn("Slack activity status unavailable");
        }
    }
    await safelyUpdate("processing");
    let pending = null;
    const timer = setInterval(() => {
        if (!enabled || pending) return;
        pending = safelyUpdate("processing").finally(() => { pending = null; });
    }, 60000);
    timer.unref();
    try {
        return await task();
    } finally {
        clearInterval(timer);
        if (pending) await pending;
        await safelyUpdate("active");
    }
}
