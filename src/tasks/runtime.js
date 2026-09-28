import { createHash, randomUUID } from "node:crypto";

const unfinished = ["queued", "running", "cancelling"];

export function taskSpec(input, now = Date.now()) {
    return {
        id: randomUUID(), team: input.team, user: input.user, channel: input.channel,
        thread: input.thread, key: input.key, profile: input.profile, prompt: input.prompt,
        skill: input.skill, delegated: input.delegated === true, scheduleId: input.scheduleId,
        fileIds: input.fileIds || [], messageTs: input.messageTs,
        briefingDate: input.briefingDate, briefingDue: input.briefingDue,
        status: "queued", delivery: "none", createdAt: now,
    };
}

export function appendTask(data, input, now = Date.now()) {
    data.tasks ??= {};
    const tasks = Object.values(data.tasks);
    if (tasks.filter((task) => unfinished.includes(task.status)).length >= 32) throw Error("Task queue is full");
    const expired = tasks.filter((task) => !unfinished.includes(task.status) && task.delivery !== "pending")
        .sort((a, b) => a.createdAt - b.createdAt).slice(0, Math.max(0, tasks.length - 199));
    for (const task of expired) delete data.tasks[task.id];
    const task = taskSpec(input, now);
    data.tasks[task.id] = task;
    return task.id;
}

export function ownedTasks(data, context) {
    return Object.values(data.tasks || {}).filter((task) => task.team === context.team &&
        task.user === context.user && task.channel === context.channel);
}

export function findTask(data, context, selector) {
    if (!/^[0-9a-f-]{8,36}$/.test(selector || "")) throw Error("Provide a task ID from !tasks");
    const matches = ownedTasks(data, context).filter((task) => task.id.startsWith(selector));
    if (matches.length !== 1) throw Error("Task not found or ID is ambiguous");
    return matches[0];
}

export function sessionFor(data, task) {
    if (task.scheduleId || task.briefingDate) return undefined;
    const thread = data.threads?.[task.key];
    if (thread?.sessions?.[task.profile + ":" + task.user]) return thread.sessions[task.profile + ":" + task.user];
    if (thread?.owner && thread.owner !== task.user) return undefined;
    if (thread?.sessions?.[task.profile]) return thread.sessions[task.profile];
    if (!task.delegated && (!thread?.profile || thread.profile === task.profile)) return thread?.session;
    return undefined;
}

export class TaskRuntime {
    constructor({ store, execute, deliver }) {
        this.store = store;
        this.execute = execute;
        this.deliver = deliver;
        this.active = null;
        this.pumping = false;
        this.closed = false;
        this.broken = false;
    }

    async recover() {
        await this.store.update((data) => {
            data.tasks ??= {};
            for (const task of Object.values(data.tasks)) {
                if (["running", "cancelling"].includes(task.status)) {
                    task.status = "interrupted";
                    task.answer = `Task ${task.id.slice(0, 8)} was interrupted. Use !retry ${task.id.slice(0, 8)}.`;
                    task.delivery = "pending";
                } else if (task.delivery === "sending") task.delivery = "uncertain";
            }
        });
    }

    async enqueue(input) {
        const id = await this.store.update((data) => appendTask(data, input));
        this.wake();
        return id;
    }

    wake() {
        if (this.pumping || this.closed || this.broken) return;
        this.pumping = true;
        this.loop = this.drain().catch(() => {
            this.broken = true;
            console.error("Task runtime stopped after a storage failure");
        }).finally(() => {
            this.pumping = false;
            if (Object.values(this.store.snapshot().tasks || {}).some((task) =>
                task.status === "queued" || task.delivery === "pending")) this.wake();
        });
    }

    async drain() {
        while (!this.closed) {
            const data = this.store.snapshot();
            const pending = Object.values(data.tasks || {}).find((task) => task.delivery === "pending");
            if (pending) {
                await this.send(pending);
                continue;
            }
            const queued = Object.values(data.tasks || {}).find((task) => task.status === "queued");
            if (!queued) return;
            const task = await this.store.update((draft) => {
                const task = draft.tasks[queued.id];
                if (task.status !== "queued") return null;
                task.status = "running";
                task.startedAt = Date.now();
                return task;
            });
            if (!task) continue;
            const controller = new AbortController();
            this.active = { id: task.id, controller };
            if (this.store.snapshot().tasks[task.id].status === "cancelling") controller.abort();
            let result;
            let failure;
            try {
                result = await this.execute(task, controller.signal);
            } catch {
                failure = true;
            }
            const cancelled = controller.signal.aborted;
            await this.store.update((draft) => {
                const current = draft.tasks[task.id];
                current.status = cancelled ? "cancelled" : failure ? "failed" : "completed";
                current.finishedAt = Date.now();
                current.answer = cancelled ? "Task cancelled." : failure
                    ? `Task ${task.id.slice(0, 8)} failed. Use !retry ${task.id.slice(0, 8)} to try again.`
                    : result.answer.slice(0, 28000);
                current.delivery = "pending";
                if (!failure && !cancelled) {
                    draft.threads ??= {};
                    const thread = draft.threads[task.key] ??= {};
                    if (!task.scheduleId) {
                        thread.owner ??= task.user;
                        thread.sessions ??= {};
                        thread.sessions[task.profile + ":" + task.user] = result.session;
                        if (result.historyReceipt) {
                            thread.historyContexts ??= {};
                            thread.historyContexts[task.profile + ":" + task.user] = {
                                ...result.historyReceipt, session: result.session,
                            };
                        }
                        if (!task.delegated && thread.owner === task.user) {
                            thread.session = result.session;
                            thread.profile = task.profile;
                        }
                    }
                    const schedule = draft.schedules?.[task.scheduleId];
                    if (schedule) {
                        const hash = createHash("sha256").update(current.answer.trim()).digest("hex");
                        if (schedule.onChange && schedule.lastHash === hash) current.delivery = "suppressed";
                        schedule.lastHash = hash;
                    }
                }
            });
            this.active = null;
        }
    }

    async send(task) {
        await this.store.update((data) => { data.tasks[task.id].delivery = "sending"; });
        try {
            await this.deliver(task, task.answer);
            await this.store.update((data) => { data.tasks[task.id].delivery = "delivered"; });
        } catch {
            await this.store.update((data) => { data.tasks[task.id].delivery = "uncertain"; });
            console.warn("Task answer delivery failed; use !redeliver");
        }
    }

    async cancel(context, selector) {
        const task = await this.store.update((data) => {
            const selected = selector ? findTask(data, context, selector) : ownedTasks(data, context)
                .find((task) => task.thread === context.thread && unfinished.includes(task.status));
            if (!selected || !unfinished.includes(selected.status)) throw Error("No active task found");
            if (selected.status === "queued") {
                selected.status = "cancelled";
                selected.answer = "Queued task cancelled.";
                selected.delivery = "pending";
            } else selected.status = "cancelling";
            return selected;
        });
        if (this.active?.id === task.id) this.active.controller.abort();
        this.wake();
        return task.id;
    }

    async retry(context, selector) {
        const task = findTask(this.store.snapshot(), context, selector);
        if (!["failed", "interrupted", "cancelled"].includes(task.status)) throw Error("Task cannot be retried");
        return this.enqueue({ ...task, scheduleId: undefined });
    }

    async redeliver(context, selector) {
        await this.store.update((data) => {
            const task = findTask(data, context, selector);
            if (!task.answer || unfinished.includes(task.status) || task.delivery === "sending") {
                throw Error("No saved answer available");
            }
            task.delivery = "pending";
        });
        this.wake();
    }

    async idle() {
        while (this.pumping) await this.loop;
    }
}
