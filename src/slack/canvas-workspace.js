import { createHash, randomUUID } from "node:crypto";
import { fileChannels } from "../resources/identifiers.js";
import { isCanvasFile } from "../resources/slack.js";
import { findInput, readInput, bindInput, createInput, updateInput } from "./canvas-input.js";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const owned = (record, context) => record?.team === context.team && record?.channel === context.channel &&
    record?.user === context.user;
const owner = ({ team, channel, user }) => ({ team, channel, user });
const pending = (change) => ["pending", "uncertain"].includes(change.status);
const rejected = new Set(["missing_scope", "no_permission", "access_denied", "canvas_not_found",
    "canvas_editing_failed", "canvas_editing_locked", "canvas_too_large", "invalid_arguments",
    "invalid_section_id", "ratelimited", "free_teams_cannot_edit_standalone_canvases"]);

export function createCanvasWorkspace({ token, state, resources, create, workspaceUrl, request = fetch }) {
    const url = (id, context) => new URL(`/docs/${context.team}/${id}`, workspaceUrl).href;
    const locks = new Map();
    function authorize(context) {
        const task = state.snapshot().tasks[context.id];
        if (!owned(task, context) || task.status !== "running") throw Error("Canvas task is no longer authorized");
    }
    async function call(method, body, signal) {
        const response = await request(`https://slack.com/api/${method}`, {
            method: "POST", redirect: "error",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify(body),
            signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]),
        });
        if (response.status === 429) return { ok: false, error: "ratelimited" };
        if (!response.ok) throw Error("Slack canvas request failed");
        return response.json();
    }
    async function info(id, context, signal) {
        authorize(context);
        const result = await call("files.info", { file: id }, signal);
        if (!result.ok || result.file?.id !== id || !isCanvasFile(result.file) ||
            !fileChannels(result.file).has(context.channel)) {
            throw Error("Canvas is unavailable or not shared with this channel");
        }
        return result.file;
    }
    function receipt(id, context) {
        const value = state.snapshot().canvasReads?.[id];
        if (!owned(value, context)) throw Error("Read this canvas in the current channel first");
        return value;
    }
    async function snapshot(id, context, signal, query) {
        await info(id, context, signal);
        const source = await resources.read(context.channel, id, signal, { fresh: true, canvasOnly: true });
        if (!source.revision) throw Error("Canvas revision is unavailable");
        let sections = [];
        if (query) {
            const found = await call("canvases.sections.lookup", {
                canvas_id: id, criteria: { contains_text: query },
            }, signal);
            if (!found.ok || !Array.isArray(found.sections) || found.sections.some((section) =>
                typeof section.id !== "string" || !section.id || section.id.length > 200)) {
                throw Error("Canvas sections could not be read");
            }
            if (found.sections.length > 100) throw Error("Too many matching sections. Use a more specific query.");
            sections = found.sections.map(({ id }) => ({ id }));
        }
        const readId = randomUUID();
        const record = { ...owner(context), canvasId: id, revision: source.revision, title: source.title,
            text: source.text, truncated: source.truncated, artifacts: source.artifacts || [], sections,
            query: query || null, createdAt: Date.now(), taskId: context.id };
        await state.update((draft) => { (draft.canvasReads ??= {})[readId] = record; });
        return { readId, ...record };
    }
    function present(read, context, offset = 0) {
        const end = Math.min(offset + 12000, read.text.length);
        return { canvasId: read.canvasId, title: read.title, url: url(read.canvasId, context),
            readId: read.readId, revision: read.revision, text: read.text.slice(offset, end),
            nextOffset: end < read.text.length ? end : null, truncated: read.truncated,
            sections: read.sections, query: read.query,
            changes: Object.entries(state.snapshot().canvasChanges || {})
                .filter(([, change]) => owned(change, context) && change.canvasId === read.canvasId && pending(change))
                .map(([changeId, change]) => ({ changeId, status: change.status, operation: change.operation })),
        };
    }
    async function bindDocument(input, context, signal) {
        const args = bindInput.parse(input);
        const file = await info(args.canvasId, context, signal);
        const key = hash([context.team, context.channel, context.user, args.purpose]);
        await state.update((draft) => {
            const bindings = draft.canvasBindings ??= {};
            if (args.creationChangeId) {
                const creation = draft.canvasChanges?.[args.creationChangeId];
                if (!owned(creation, context) || creation.canvasId || !pending(creation) ||
                    creation.operation.operation !== "create" ||
                    (creation.operation.purpose && creation.operation.purpose !== args.purpose)) {
                    throw Error("Matching unresolved canvas creation not found");
                }
                Object.assign(creation, { canvasId: args.canvasId, status: "resolved", resolution: "applied",
                    result: { canvasId: args.canvasId, url: url(args.canvasId, context) } });
                const task = draft.tasks[creation.taskId];
                if (task?.canvasCreations) {
                    task.canvasCreations[hash({ title: creation.operation.title,
                        markdown: creation.operation.markdown })] = { status: "created", result: creation.result };
                }
            }
            const existing = bindings[key];
            if (existing && existing.canvasId !== args.canvasId && args.replaceCanvasId !== existing.canvasId) {
                throw Error("This purpose already has a canvas. Supply replaceCanvasId only to replace that binding.");
            }
            bindings[key] = { ...owner(context), canvasId: args.canvasId, purpose: args.purpose,
                title: file.title, updatedAt: Date.now() };
        });
        return { canvasId: args.canvasId, purpose: args.purpose, url: url(args.canvasId, context) };
    }
    async function bind(input, context, signal) {
        const args = bindInput.parse(input);
        const lock = `create:${hash([owner(context), args.purpose])}`;
        if (locks.has(lock)) throw Error("Another canvas operation is running for this purpose");
        locks.set(lock, true);
        try { return await bindDocument(args, context, signal); }
        finally { locks.delete(lock); }
    }
    async function update(input, context, signal) {
        const args = updateInput.parse(input);
        authorize(context);
        if (args.operation === "resolve" && !args.readId) {
            await state.update((draft) => {
                const change = draft.canvasChanges?.[args.changeId];
                if (!owned(change, context) || change.canvasId || change.operation.operation !== "create" ||
                    !pending(change) || args.outcome !== "not_applied") {
                    throw Error("A current readId is required to resolve this change");
                }
                if (locks.has(`create:${hash([owner(context), change.operation.purpose || null])}`)) {
                    throw Error("Canvas creation is still running");
                }
                Object.assign(change, { status: "resolved", resolution: "not_applied", reason: args.reason });
                const task = draft.tasks[change.taskId];
                if (task?.canvasCreations) {
                    delete task.canvasCreations[hash({ title: change.operation.title,
                        markdown: change.operation.markdown })];
                }
            });
            return { changeId: args.changeId, status: "resolved", outcome: "not_applied" };
        }
        const before = receipt(args.readId, context);
        const lock = `${context.team}:${before.canvasId}`;
        if (locks.has(lock)) throw Error("Another canvas operation is running. Read again when it finishes.");
        locks.set(lock, true);
        try {
            const operation = { ...args };
            delete operation.readId;
            const key = hash([owner(context), context.id, before.canvasId, args.readId, operation]);
            const prior = state.snapshot().canvasChanges?.[key];
            await info(before.canvasId, context, signal);
            if (prior && !pending(prior) && prior.result) return prior.result;
            const current = await snapshot(before.canvasId, context, signal, before.query);
            if (args.operation === "resolve") {
                const change = state.snapshot().canvasChanges?.[args.changeId];
                if (!owned(change, context) || change.canvasId !== before.canvasId || !pending(change)) {
                    throw Error("Unresolved canvas change not found");
                }
                if (args.readId === change.beforeReadId || before.createdAt < change.createdAt ||
                    current.revision !== before.revision) {
                    throw Error("Read the latest canvas before resolving an uncertain change");
                }
                await state.update((draft) => {
                    Object.assign(draft.canvasChanges[args.changeId], { status: "resolved",
                        resolution: args.outcome, reason: args.reason, afterReadId: current.readId });
                });
                return { changeId: args.changeId, status: "resolved", outcome: args.outcome,
                    canvasId: before.canvasId, url: url(before.canvasId, context) };
            }
            const unresolved = Object.entries(state.snapshot().canvasChanges || {}).find(([, change]) =>
                change.team === context.team && change.canvasId === before.canvasId && pending(change));
            if (unresolved) {
                throw Error(`Canvas change ${unresolved[0]} is uncertain. Read and resolve it before editing.`);
            }
            if (current.revision !== before.revision) {
                throw Error("Canvas changed since reading. Read and plan the edit again.");
            }
            if (args.sectionId && (before.sections.length !== 1 || current.sections.length !== 1)) {
                throw Error("Section query is ambiguous. Refine it until exactly one block matches before editing.");
            }
            if (args.sectionId && (!before.sections.some(({ id }) => id === args.sectionId) ||
                !current.sections.some(({ id }) => id === args.sectionId))) {
                throw Error("Section was not returned by the latest canvas read. Refine the query and read again.");
            }
            if (before.truncated && ["replace_document", "replace", "delete"].includes(args.operation)) {
                throw Error("Canvas reading was truncated. Destructive edits require complete source text.");
            }
            const change = { operation: args.operation === "replace_document" ? "replace" : args.operation };
            if (args.sectionId) change.section_id = args.sectionId;
            if (args.markdown) change.document_content = { type: "markdown", markdown: args.markdown };
            if (args.title) change.title_content = { type: "markdown", markdown: args.title };
            authorize(context);
            signal?.throwIfAborted();
            await state.update((draft) => {
                const previous = draft.canvasChanges?.[key];
                (draft.canvasChanges ??= {})[key] = { ...owner(context), canvasId: before.canvasId,
                    history: [...(previous?.history || []), ...(previous ? [{ status: previous.status,
                        resolution: previous.resolution, reason: previous.reason,
                        createdAt: previous.createdAt }] : [])],
                    taskId: context.id, status: "pending", operation,
                    beforeReadId: args.readId, createdAt: Date.now() };
            });
            let response;
            try { response = await call("canvases.edit", { canvas_id: before.canvasId, changes: [change] }, signal); }
            catch {}
            if (response?.ok === false && rejected.has(response.error)) {
                await state.update((draft) => { draft.canvasChanges[key].status = "rejected"; });
                throw Error(`Slack rejected the canvas edit (${response.error}). Read again before retrying.`);
            }
            if (response?.ok !== true) {
                await state.update((draft) => { draft.canvasChanges[key].status = "uncertain"; });
                return { changeId: key, status: "uncertain", canvasId: before.canvasId,
                    url: url(before.canvasId, context),
                    instruction: "Read the canvas to inspect the outcome. Do not retry." };
            }
            let after;
            try { after = await snapshot(before.canvasId, context, signal, before.query); } catch {}
            const result = { changeId: key, status: "applied", canvasId: before.canvasId,
                url: url(before.canvasId, context), verification: after ? "read_back" : "unavailable",
                ...(after ? { after: present(after, context), changed: after.revision !== before.revision } : {}),
                instruction: "Compare the returned content with the intended edit before claiming it is verified." };
            if (result.after) result.after.changes = result.after.changes.filter(({ changeId }) => changeId !== key);
            try {
                await state.update((draft) => Object.assign(draft.canvasChanges[key], {
                    status: "applied", afterReadId: after?.readId || null, result,
                }));
            } catch { result.warning = "Slack accepted the edit, but saving the receipt failed. Do not repeat it."; }
            return result;
        } finally { locks.delete(lock); }
    }
    return {
        async find(input, context, signal) {
            const args = findInput.parse(input);
            authorize(context);
            const bindings = Object.values(state.snapshot().canvasBindings || {})
                .filter((item) => owned(item, context));
            const result = await call("files.list", { channel: context.channel, types: "canvas", count: 50,
                page: args.page }, signal);
            if (!result.ok || !Array.isArray(result.files)) throw Error("Canvas discovery failed");
            const ids = new Set([...bindings.map((item) => item.canvasId), ...result.files.map((file) => file.id)]);
            const items = [];
            let unavailable = 0;
            for (const id of ids) {
                if (typeof id !== "string" || !/^F[A-Z0-9]{6,}$/.test(id)) continue;
                let file;
                try { file = await info(id, context, signal); } catch { unavailable++; continue; }
                const purposes = bindings.filter((item) => item.canvasId === id).map((item) => item.purpose);
                const matches = [file.title || "", ...purposes].join(" ").toLowerCase();
                if (!matches.includes(args.query.toLowerCase())) continue;
                items.push({ canvasId: id, title: file.title, purposes, url: url(id, context) });
            }
            const unresolvedCreations = Object.entries(state.snapshot().canvasChanges || {})
                .filter(([, change]) => owned(change, context) && !change.canvasId && pending(change) &&
                    change.operation.operation === "create")
                .map(([changeId, change]) => ({ changeId, title: change.operation.title,
                    purpose: change.operation.purpose || null }));
            return { items, nextPage: result.paging?.pages > args.page ? args.page + 1 : null,
                unavailable, unresolvedCreations };
        },
        async read(input, context, signal) {
            const args = readInput.parse(input);
            authorize(context);
            const read = await snapshot(args.canvasId, context, signal, args.query);
            if (args.readId) {
                const previous = receipt(args.readId, context);
                if (previous.canvasId !== args.canvasId || previous.revision !== read.revision) {
                    throw Error("Canvas changed while paging. Start reading again.");
                }
            }
            if (args.offset > read.text.length) throw Error("Offset is beyond the canvas text");
            return present(read, context, args.offset);
        },
        bind, update,
        async create(input, context, signal) {
            const args = createInput.parse(input);
            authorize(context);
            const lock = `create:${hash([owner(context), args.purpose || null])}`;
            if (locks.has(lock)) throw Error("Another canvas creation is running for this purpose");
            locks.set(lock, true);
            try {
                const unresolved = Object.entries(state.snapshot().canvasChanges || {}).find(([, change]) =>
                    owned(change, context) && !change.canvasId && pending(change) &&
                    change.operation.operation === "create" &&
                    (args.purpose ? change.operation.purpose === args.purpose :
                        change.operation.title === args.title && change.operation.markdown === args.markdown));
                if (unresolved) {
                    throw Error(`Canvas creation ${unresolved[0]} is uncertain. Find and reconcile it first.`);
                }
                if (args.purpose) {
                    const binding = Object.values(state.snapshot().canvasBindings || {}).find((item) =>
                        owned(item, context) && item.purpose === args.purpose);
                    if (binding) {
                        const file = await info(binding.canvasId, context, signal);
                        return { canvasId: binding.canvasId, title: file.title,
                            url: url(binding.canvasId, context), existing: true, purpose: args.purpose };
                    }
                }
                const changeId = hash(["create", owner(context), context.id, args.title, args.markdown]);
                await state.update((draft) => {
                    const previous = (draft.canvasChanges ??= {})[changeId];
                    if (previous?.status === "applied") return;
                    draft.canvasChanges[changeId] = { ...owner(context), canvasId: null,
                        taskId: context.id, status: "pending", createdAt: Date.now(),
                        history: [...(previous?.history || []), ...(previous ? [{ status: previous.status,
                            resolution: previous.resolution, reason: previous.reason }] : [])],
                        operation: { operation: "create", title: args.title, markdown: args.markdown,
                            purpose: args.purpose || null } };
                });
                let result;
                try { result = await create({ title: args.title, markdown: args.markdown }, context, signal); }
                catch (error) {
                    const taskReceipt = state.snapshot().tasks[context.id]?.canvasCreations?.[
                        hash({ title: args.title, markdown: args.markdown })];
                    await state.update((draft) => {
                        draft.canvasChanges[changeId].status = taskReceipt?.status === "pending"
                            ? "uncertain" : "rejected";
                    });
                    throw error;
                }
                try {
                    await state.update((draft) => Object.assign(draft.canvasChanges[changeId], {
                        canvasId: result.canvasId, status: "applied", result,
                    }));
                } catch {
                    return { ...result,
                        warning: "Canvas created, but saving its durable receipt failed. Do not create again." };
                }
                if (args.purpose) {
                    try { await bindDocument({ canvasId: result.canvasId, purpose: args.purpose }, context, signal); }
                    catch {
                        return { ...result, warning: "Canvas created, but binding failed. Use slack_canvas_bind." };
                    }
                }
                return result;
            } finally { locks.delete(lock); }
        },
    };
}
