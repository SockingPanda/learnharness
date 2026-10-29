import assert from "node:assert/strict";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ChatRecord, JobRecord } from "../src/core/contracts.ts";
import type { JobStore } from "../src/core/ports.ts";
import { beginStorageShutdown, StorageStoppingError } from "../src/core/storage-lifecycle.ts";
import { createJobRunner, activeJobIds, awaitJobRunners } from "../src/agent/subagents/runner.ts";
import { fireJobAbort, isJobLive } from "../src/agent/subagents/aborts.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";

function latch() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

// The process lifecycle deliberately has no reset API. Keep its irreversible
// shutdown scenario in a separate test process from normal runner tests.
test("shutdown gates delayed dispatch and pre-model reads, and drains worker usage after abort registration disappears", { timeout: 5000 }, async () => {
	const readEntered = latch(), readRelease = latch(), usageEntered = latch(), usageRelease = latch();
	const findEntered = latch(), findRelease = latch(), createEntered = latch(), createRelease = latch();
	const now = new Date().toISOString();
	const chat: ChatRecord = { id: "shutdown-chat", title: "Shutdown", messages: [], createdAt: now, updatedAt: now };
	const makeJob = (id: string): JobRecord => ({
		id, chatId: chat.id, kind: "research", toolCallId: `call-${id}`, input: { question: "Local fixture" },
		status: "running", activity: "starting", createdAt: now, updatedAt: now,
	});
	const records = new Map(["delayed-read", "active-usage"].map((id) => [id, makeJob(id)]));
	let reads = 0, creates = 0, spawns = 0, calls = 0, deliveries = 0;
	const jobStore: JobStore = {
		getJob: async (id) => {
			reads++;
			if (id === "delayed-read") { readEntered.release(); await readRelease.promise; }
			return structuredClone(records.get(id) ?? null);
		},
		updateJob: async (id, patch) => {
			if (id === "active-usage" && patch.usage) { usageEntered.release(); await usageRelease.promise; }
			const current = records.get(id);
			if (!current) return null;
			const next = { ...current, ...structuredClone(patch) }; records.set(id, next);
			return structuredClone(next);
		},
		findJobByToolCallId: async (_chatId, callId) => {
			if (callId === "delayed-find") { findEntered.release(); await findRelease.promise; }
			return null;
		},
		createJob: async (init) => {
			creates++; createEntered.release(); await createRelease.promise;
			const record = { ...makeJob("created-during-stop"), ...init };
			records.set(record.id, record); return structuredClone(record);
		},
		listJobs: async () => [...records.values()].map((record) => structuredClone(record)),
		deleteJobsForChat: async () => 0,
	};
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxText("A complete local result.")])]);
	const runner = createJobRunner({
		chatStore: { getChat: async () => structuredClone(chat) }, jobStore,
		engineFor: () => ({ model: faux.getModel(), streamFn: (...args) => { calls++; return faux.streamSimple(...args); } }),
		deliver: async () => { deliveries++; },
	});
	const delayed = runner.runJob("delayed-read"), active = runner.runJob("active-usage");
	const tools = jobTools({ chatId: chat.id, jobStore, spawn: () => { spawns++; } });
	const findDenied = assert.rejects(tools.research!.execute!("delayed-find", { question: "Blocked on lookup" }), StorageStoppingError);
	const createDenied = assert.rejects(tools.research!.execute!("delayed-create", { question: "Blocked on create" }), StorageStoppingError);
	await Promise.all([readEntered.promise, usageEntered.promise, findEntered.promise, createEntered.promise]);
	assert.deepEqual(activeJobIds().sort(), ["active-usage", "delayed-read"]);
	assert.equal(calls, 1); assert.equal(creates, 1); assert.equal(spawns, 0);

	beginStorageShutdown();
	for (const id of activeJobIds()) fireJobAbort(id);
	assert(!isJobLive("active-usage"));
	const readsBefore = reads;
	await runner.runJob("must-not-read");
	await assert.rejects(tools.research!.execute!("must-not-create", { question: "Too late" }), StorageStoppingError);
	assert.equal(reads, readsBefore); assert.equal(creates, 1);
	let drained = false;
	const draining = awaitJobRunners().then(() => { drained = true; });
	await Promise.resolve();
	assert.equal(drained, false, "abort registration removal does not imply durable writes have finished");
	readRelease.release(); findRelease.release(); createRelease.release();
	await delayed; await findDenied; await createDenied;
	assert.equal(drained, false); assert.equal(spawns, 0); assert.equal(calls, 1);
	assert.equal(records.get("created-during-stop")?.status, "error", "an unacknowledged creation cannot become a recoverable running orphan");
	usageRelease.release(); await active; await draining;
	assert.equal(records.get("active-usage")?.usage?.steps, 1);
	assert.equal(deliveries, 0); assert.equal(calls, 1); assert.deepEqual(activeJobIds(), []);
});
