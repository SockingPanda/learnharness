import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { shutdownStorageRuntime, StorageShutdownError, type StorageShutdownDependencies } from "../src/server/storage-shutdown.ts";
import { isStorageStopping, storageOperationsInFlight, trackStorageOperation } from "../src/core/storage-lifecycle.ts";
import { withChatWrite } from "../src/core/storage-coordination.ts";
import { activeTurnIds, beginTurn, endTurn } from "../src/server/turn-liveness.ts";

function resetLifecycle() {
	for (const id of activeTurnIds()) endTurn(id);
	Reflect.deleteProperty(globalThis, Symbol.for("lh.storage.lifecycle"));
	Reflect.deleteProperty(globalThis, Symbol.for("lh.storage.shutdown"));
}
beforeEach(resetLifecycle);
afterEach(resetLifecycle);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function dependencies(overrides: Partial<StorageShutdownDependencies> = {}): StorageShutdownDependencies {
	return {
		turnIds: () => [], abortTurn: () => {}, extractionIds: () => [], abortExtraction: () => {},
		jobIds: () => [], abortJob: () => {}, abortCompactions: () => {},
		awaitJobs: async () => {}, awaitCompactions: async () => {}, awaitWakeWrites: async () => {},
		close: async () => {}, ...overrides,
	};
}

describe("storage shutdown durability", () => {
	it("waits for aborted-turn persistence and refuses a new turn before reporting success", async (t) => {
		const save = deferred(); t.after(save.resolve);
		assert.equal(beginTurn("slow-turn"), true);
		let saving: Promise<void> | undefined;
		let closed = false;
		const options = { dependencies: dependencies({
			turnIds: activeTurnIds,
			abortTurn: () => { saving ??= trackStorageOperation(() => save.promise).then(() => endTurn("slow-turn")); },
			close: async () => { assert.equal(storageOperationsInFlight(), 0); closed = true; },
		}) };
		const shutdown = shutdownStorageRuntime(options);
		assert.equal(shutdownStorageRuntime(options), shutdown, "concurrent shutdown callers share one drain");
		assert.equal(isStorageStopping(), true);
		assert.equal(beginTurn("must-not-request-a-model"), false);
		await tick();
		assert.equal(closed, false, "an aborted model is not a saved reply");
		save.resolve();
		assert.deepEqual(await shutdown, { stopped: true });
		assert.equal(closed, true);
		let requests = 0;
		await assert.rejects(trackStorageOperation(async () => { requests++; }), /shutting down/);
		assert.equal(requests, 0, "closed storage is never reopened by late work");
	});

	it("drains queued service work whose store call has not started yet", async (t) => {
		const release = deferred(); t.after(release.resolve);
		const order: string[] = [];
		const first = withChatWrite("queued-save", async () => { await release.promise; await trackStorageOperation(async () => { order.push("first"); }); });
		const second = withChatWrite("queued-save", async () => { await trackStorageOperation(async () => { order.push("second"); }); });
		const shutdown = shutdownStorageRuntime({ dependencies: dependencies({ close: async () => { order.push("close"); } }) });
		await tick(); assert.deepEqual(order, []);
		release.resolve();
		await Promise.all([first, second, shutdown]);
		assert.deepEqual(order, ["first", "second", "close"]);
	});

	it("a failed settlement write cannot be reported as saved", async (t) => {
		const save = deferred(); t.after(save.resolve);
		const write = trackStorageOperation(() => save.promise);
		const rejectedWrite = assert.rejects(write, /disk unavailable/);
		let closed = false;
		const shutdown = shutdownStorageRuntime({ dependencies: dependencies({ close: async () => { closed = true; } }) });
		const rejectedShutdown = assert.rejects(shutdown, (error) => error instanceof StorageShutdownError && error.code === "storage_shutdown_failed");
		save.reject(new Error("disk unavailable"));
		await Promise.all([rejectedWrite, rejectedShutdown]);
		assert.equal(closed, false);
		assert.equal(isStorageStopping(), true);
	});

	it("times out honestly and does not later run a successful-close path", async (t) => {
		const save = deferred(); t.after(save.resolve);
		const write = trackStorageOperation(() => save.promise);
		let closed = false;
		await assert.rejects(shutdownStorageRuntime({ timeoutMs: 25, dependencies: dependencies({ close: async () => { closed = true; } }) }),
			(error) => error instanceof StorageShutdownError && error.code === "storage_shutdown_timeout");
		save.resolve(); await write; await tick();
		assert.equal(closed, false);
	});

	it("seals operations before the asynchronous backend close", async (t) => {
		const closing = deferred(); t.after(closing.resolve);
		let closeStarted = false;
		const shutdown = shutdownStorageRuntime({ dependencies: dependencies({ close: async () => { closeStarted = true; await closing.promise; } }) });
		while (!closeStarted) await tick();
		let reopened = false;
		await assert.rejects(trackStorageOperation(async () => { reopened = true; }), /shutting down/);
		assert.equal(reopened, false);
		closing.resolve();
		assert.deepEqual(await shutdown, { stopped: true });
	});

	it("rechecks work accepted in the final drain microtask gap before sealing", async () => {
		const write = deferred();
		const accepted = deferred();
		let pendingWrite: Promise<void> | undefined;
		let checks = 0;
		let pendingAtClose: number | undefined;
		const shutdown = shutdownStorageRuntime({ dependencies: dependencies({
			turnIds: () => {
				if (++checks === 3) queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
					pendingWrite = trackStorageOperation(() => write.promise);
					accepted.resolve();
				})));
				return [];
			},
			close: async () => { pendingAtClose = storageOperationsInFlight(); },
		}) });
		try {
			await accepted.promise;
			await tick();
			assert.equal(pendingAtClose, undefined, "a write accepted after the drain must finish before close");
			write.resolve();
			await pendingWrite;
			assert.deepEqual(await shutdown, { stopped: true });
			assert.equal(pendingAtClose, 0);
		} finally {
			write.resolve();
			await Promise.allSettled([pendingWrite, shutdown]);
		}
	});
});
