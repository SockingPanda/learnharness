/** Process-local coordination for the single-executor workspace.
 * Adapters serialize their own mutations separately; never recursively enter a gate.
 */
const KEY = Symbol.for("lh.storage.coordination");
const root = globalThis as typeof globalThis & { [KEY]?: Map<string, Promise<unknown>> };
const tails = root[KEY] ??= new Map<string, Promise<unknown>>();

function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
	const previous = tails.get(key) ?? Promise.resolve();
	const current = previous.catch(() => {}).then(action);
	tails.set(key, current);
	void current.finally(() => { if (tails.get(key) === current) tails.delete(key); }).catch(() => {});
	return current;
}

/** Protect a read/validate/append sequence, never an entire model call. */
export function withChatWrite<T>(chatId: string, action: () => Promise<T>): Promise<T> {
	return serial(`chat:${chatId}`, action);
}

/** Shared by graph snapshot readers, extraction commits, layout and deletion. */
export function withGraphWrite<T>(action: () => Promise<T>): Promise<T> {
	return serial("graph", action);
}

/** Shutdown waits for service sequences as well as their individual store calls. */
export async function awaitStorageCoordination(): Promise<void> {
	while (tails.size > 0) await Promise.allSettled([...tails.values()]);
}

export function storageCoordinationInFlight(): number { return tails.size; }
