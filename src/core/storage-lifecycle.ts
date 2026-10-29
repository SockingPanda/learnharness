/** Process-local lifecycle; no database or framework dependency. */
interface StorageLifecycle {
	stopping: boolean;
	sealed: boolean;
	closed: boolean;
	pending: Set<Promise<unknown>>;
	failures: unknown[];
}

const KEY = Symbol.for("lh.storage.lifecycle");
function state(): StorageLifecycle {
	const host = globalThis as typeof globalThis & { [KEY]?: StorageLifecycle };
	return host[KEY] ??= { stopping: false, sealed: false, closed: false, pending: new Set(), failures: [] };
}

export class StorageStoppingError extends Error {
	readonly code = "storage_stopping";
	constructor() { super("LearnHarness is shutting down. Restart the application to continue."); this.name = "StorageStoppingError"; }
}

export function isStorageStopping(): boolean { return state().stopping; }
export function beginStorageShutdown(): void { state().stopping = true; }
export function markStorageClosed(): void { const current = state(); current.stopping = current.sealed = current.closed = true; }

/** Seal only after producers and their persistence have drained. */
export function sealStorageOperations(): void { state().sealed = true; }

/** Track calls before asynchronous initialization/queueing, not just HTTP writes.
 * Stopping still admits settlement writes from existing work. Sealing forbids
 * late readers/writers from reopening the backend during or after close.
 */
export function trackStorageOperation<T>(work: () => Promise<T>): Promise<T> {
	const current = state();
	if (current.sealed || current.closed) return Promise.reject(new StorageStoppingError());
	const operation = Promise.resolve().then(work);
	current.pending.add(operation);
	void operation.then(
		() => current.pending.delete(operation),
		(error: unknown) => { current.pending.delete(operation); if (current.stopping) current.failures.push(error); },
	);
	return operation;
}

export function storageOperationsInFlight(): number { return state().pending.size; }
export function storageShutdownFailures(): readonly unknown[] { return [...state().failures]; }
export async function awaitStorageOperations(): Promise<void> {
	while (state().pending.size > 0) await Promise.allSettled([...state().pending]);
}
