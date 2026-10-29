/** Runtime-only storage composition. A workspace selects one complete backend. */
import type { ChatStore, GraphStore, JobStore, ReadingSourceStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { settingsStore } from "../store/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { syncCustomProvider } from "./custom-provider.ts";
import { PATHS } from "../../config.ts";
import { isStorageStopping, StorageStoppingError, trackStorageOperation } from "../core/storage-lifecycle.ts";

interface LearningStores {
	chatStore: ChatStore;
	graphStore: GraphStore;
	jobStore: JobStore;
	readingSourceStore: ReadingSourceStore;
}
interface Backend extends LearningStores {
	ready?(): Promise<unknown>;
	checkHealth?(): Promise<unknown>;
	close?(): Promise<void> | void;
}
interface RuntimeState { backend?: Promise<Backend>; recovery?: Promise<void> }
const KEY = Symbol.for("lh.storage.backends");
const host = globalThis as typeof globalThis & { [KEY]?: Map<string, RuntimeState> };
const states = host[KEY] ??= new Map<string, RuntimeState>();

export function storageMode(): "fs" | "any" {
	const mode = process.env.LH_STORAGE_BACKEND ?? "fs";
	if (mode !== "fs" && mode !== "any") throw new Error("Unknown LearnHarness storage backend");
	return mode;
}

function state(): RuntimeState {
	const key = JSON.stringify([storageMode(), PATHS.data, process.env.LH_ANY_URL, process.env.LH_ANY_ACCOUNT_ID]);
	let current = states.get(key);
	if (!current) { current = {}; states.set(key, current); }
	return current;
}

function changed(change: { graph?: boolean; chats?: boolean; jobs?: boolean; chatId?: string }) {
	if (change.chatId) emit("record-changed", { chatId: change.chatId });
	if (change.graph) emit("activity-changed", {});
	if (change.chats) emit("chats-changed", {});
	if (change.jobs) emit("jobs-changed", change.chatId ? { chatId: change.chatId } : {});
	if (!change.chatId) emit("storage-resync", {});
}

async function loadBackend(): Promise<Backend> {
	if (storageMode() === "any") {
		const url = process.env.LH_ANY_URL;
		const expectedAccountId = process.env.LH_ANY_ACCOUNT_ID;
		if (!url || !expectedAccountId) throw new Error("Any Preview requires its application-managed database service");
		const { createAnyStores } = await import("../store/any/index.ts");
		const selected = createAnyStores({ url, expectedAccountId, dataDir: process.env.LH_ANY_DATA_DIR, onChange: changed });
		try {
			await selected.ready();
			return selected;
		} catch (error) {
			// Initialization can open its change subscription before recovery
			// fails. Release that client before the cached promise is retried.
			await selected.close().catch(() => undefined);
			throw error;
		}
	}
	const [chats, graph, jobs, sources] = await Promise.all([
		import("../store/chats.ts"), import("../store/graph.ts"),
		import("../store/jobs.ts"), import("../store/reading-sources.ts"),
	]);
	return { chatStore: chats.chatStore, graphStore: graph.graphStore, jobStore: jobs.jobStore, readingSourceStore: sources.readingSourceStore };
}

async function backend(): Promise<Backend> {
	const current = state();
	current.backend ??= loadBackend().catch((error: unknown) => { current.backend = undefined; throw error; });
	return current.backend;
}

/** Importing routes during Next build must never open or initialize the database. */
function facade<K extends keyof LearningStores>(key: K, methods: readonly (keyof LearningStores[K])[]): LearningStores[K] {
	return Object.fromEntries(methods.map((method) => [method, (...args: unknown[]) => trackStorageOperation(async () => {
		const target = (await backend())[key];
		const call = Reflect.get(target, method);
		if (typeof call !== "function") throw new Error(`Missing storage method: ${String(method)}`);
		return Reflect.apply(call, target, args);
	})])) as unknown as LearningStores[K];
}

/** New API mutations stop while already admitted work finishes persisting. */
export function storageMutationResponse(): Response | null {
	return isStorageStopping() ? Response.json({ code: "storage_stopping", error: "The application is shutting down." }, { status: 503 }) : null;
}

export const stores = {
	chatStore: facade("chatStore", ["createChat", "getChat", "listChats", "saveMessages", "appendMessages", "saveTree", "saveSettings", "renameChat", "deleteChat", "appendTurnUsage", "appendExtractionUsage", "beginDeletion", "listDeletingChats", "setMessageInverted", "setPendingTurn"]),
	graphStore: facade("graphStore", ["readSnapshot", "commitBatch", "getRevision", "appendNode", "readNodes", "appendChain", "readChains", "appendCheckpoint", "readCheckpoints", "appendCoverage", "readCoverage", "upsertSource", "readSources", "appendSourceUsage", "readPositions", "writePositions", "rewriteLedgers"]),
	jobStore: facade("jobStore", ["createJob", "getJob", "updateJob", "listJobs", "findJobByToolCallId", "deleteJobsForChat"]),
	readingSourceStore: facade("readingSourceStore", ["save", "get", "delete"]),
	settingsStore,
};
export type Stores = typeof stores;

/** The desktop waits for this barrier before opening the application window. */
export function storageReady(): Promise<{ ready: true; backend: "fs" | "any" }> {
	if (isStorageStopping()) return Promise.reject(new StorageStoppingError());
	return trackStorageOperation(async () => {
		const selected = await backend();
		await selected.checkHealth?.();
		const current = state();
		current.recovery ??= (async () => {
			const { recoverChatDeletions } = await import("./chats.ts");
			await recoverChatDeletions();
			const { restoreInterruptedTurns } = await import("./turn-recovery.ts");
			await restoreInterruptedTurns();
		})()
			.catch((error: unknown) => { current.recovery = undefined; throw error; });
		await current.recovery;
		return { ready: true, backend: storageMode() };
	});
}

export async function closeStorage(): Promise<void> {
	const current = state();
	if (current.backend) await (await current.backend).close?.();
	current.backend = undefined;
	current.recovery = undefined;
}

/** Non-secret machine preferences remain local to the selected application. */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}

syncCustomProvider();
