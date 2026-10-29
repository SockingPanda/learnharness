import {
	awaitStorageOperations, beginStorageShutdown, markStorageClosed, sealStorageOperations,
	storageOperationsInFlight, storageShutdownFailures,
} from "../core/storage-lifecycle.ts";
import { awaitStorageCoordination, storageCoordinationInFlight } from "../core/storage-coordination.ts";
import { activeExtractionIds, abortExtraction } from "../agent/subagents/extraction.ts";
import { activeJobIds, awaitJobRunners } from "../agent/subagents/runner.ts";
import { fireJobAbort } from "../agent/subagents/aborts.ts";
import { activeTurnIds } from "./turn-liveness.ts";
import { abortTurn } from "./turn-runs.ts";
import { abortCompactions, awaitCompactions } from "./compaction.ts";
import { awaitWakeWrites } from "./jobs.ts";
import { closeStorage } from "./stores.ts";

export class StorageShutdownError extends Error {
	constructor(readonly code: "storage_shutdown_timeout" | "storage_shutdown_failed", message: string, options?: ErrorOptions) {
		super(message, options); this.name = "StorageShutdownError";
	}
}

/** Injectable lifetime boundaries keep the shutdown protocol independently testable. */
export interface StorageShutdownDependencies {
	turnIds(): readonly string[];
	abortTurn(id: string): unknown;
	extractionIds(): readonly string[];
	abortExtraction(id: string): unknown;
	jobIds(): readonly string[];
	abortJob(id: string): unknown;
	abortCompactions(): void;
	awaitJobs(): Promise<void>;
	awaitCompactions(): Promise<void>;
	awaitWakeWrites(): Promise<void>;
	close(): Promise<void>;
}

const defaults: StorageShutdownDependencies = {
	turnIds: activeTurnIds, abortTurn,
	extractionIds: activeExtractionIds, abortExtraction,
	jobIds: activeJobIds, abortJob: fireJobAbort,
	abortCompactions, awaitJobs: awaitJobRunners, awaitCompactions, awaitWakeWrites,
	close: closeStorage,
};
const KEY = Symbol.for("lh.storage.shutdown");
type ShutdownResult = { stopped: true };

/** Stop producers first; successful return means every settlement write finished. */
export function shutdownStorageRuntime(options: { timeoutMs?: number; dependencies?: StorageShutdownDependencies } = {}): Promise<ShutdownResult> {
	const host = globalThis as typeof globalThis & { [KEY]?: Promise<ShutdownResult> };
	if (host[KEY]) return host[KEY];
	beginStorageShutdown();
	const deps = options.dependencies ?? defaults;
	const timeoutMs = options.timeoutMs ?? 10_000;
	const abortAll = () => {
		for (const id of deps.turnIds()) deps.abortTurn(id);
		for (const id of deps.extractionIds()) deps.abortExtraction(id);
		for (const id of deps.jobIds()) deps.abortJob(id);
		deps.abortCompactions();
	};
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout>;
	const timeoutError = () => new StorageShutdownError("storage_shutdown_timeout", "Shutdown timed out before all work was saved. The application must not report a clean shutdown.");
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => { timedOut = true; reject(timeoutError()); }, timeoutMs);
	});
	const drain = async (): Promise<ShutdownResult> => {
		abortAll();
		let workersDone = false;
		let workerFailures: unknown[] = [];
		const workers = Promise.allSettled([deps.awaitJobs(), deps.awaitCompactions(), deps.awaitWakeWrites()])
			.then((results) => { workerFailures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []); workersDone = true; });
		const hasWork = () => !workersDone || deps.turnIds().length || deps.extractionIds().length || deps.jobIds().length || storageOperationsInFlight() || storageCoordinationInFlight();
		for (;;) {
			while (hasWork()) {
				if (timedOut) throw timeoutError();
				abortAll(); // Also reaches a controller registered after async preparation.
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
			}
			await workers;
			await awaitStorageCoordination();
			await awaitStorageOperations();
			if (timedOut) throw timeoutError();
			const failures = [...workerFailures, ...storageShutdownFailures()];
			if (failures.length) throw new StorageShutdownError("storage_shutdown_failed", "Some shutdown persistence failed. The application must not report that all work was saved.", { cause: new AggregateError(failures) });
			// Each await above yields to callers that may enqueue settlement work.
			// Check every producer/queue again, then seal in this SAME synchronous
			// turn. No accepted operation can slip between this check and sealing.
			if (hasWork()) continue;
			sealStorageOperations();
			break;
		}
		await deps.close();
		if (timedOut) throw timeoutError();
		markStorageClosed();
		return { stopped: true };
	};
	host[KEY] = Promise.race([drain(), timeout]).finally(() => clearTimeout(timer!));
	return host[KEY];
}
