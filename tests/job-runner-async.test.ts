import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ChatRecord, JobRecord, SteerMessage } from "../src/core/contracts.ts";
import type { JobPatch } from "../src/core/ports.ts";
import { withChatWrite } from "../src/core/storage-coordination.ts";
import { createJobRunner } from "../src/agent/subagents/runner.ts";
import { fireJobAbort, isJobLive } from "../src/agent/subagents/aborts.ts";

function latch() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

function fixture(beforeUpdate: (patch: JobPatch) => Promise<void> = async () => {}) {
	const id = randomUUID();
	const now = new Date().toISOString();
	const chat: ChatRecord = { id: `chat_${id}`, title: "Async runner", messages: [], createdAt: now, updatedAt: now };
	const state: { job: JobRecord | null; chat: ChatRecord | null } = {
		chat,
		job: { id: `job_${id}`, chatId: chat.id, toolCallId: `call_${id}`, kind: "research", input: { question: "Explain a locally scripted result" }, status: "running", activity: "starting", createdAt: now, updatedAt: now },
	};
	const jobId = state.job!.id;
	const writes: JobPatch[] = [];
	const chatStore = { getChat: async () => structuredClone(state.chat) };
	const jobStore = {
		getJob: async () => structuredClone(state.job),
		updateJob: async (_id: string, patch: JobPatch) => {
			await beforeUpdate(patch);
			if (!state.job) return null;
			state.job = { ...state.job, ...structuredClone(patch) };
			writes.push(structuredClone(patch));
			return structuredClone(state.job);
		},
	};
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxText("A complete locally scripted research brief.")])]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const delivered: SteerMessage[] = [];
	return { state, jobId, chatId: chat.id, writes, delivered, chatStore, jobStore, engine };
}

test("progress and terminal outcome are durable before delivery; duplicate starts do not rerun a worker", { timeout: 5000 }, async () => {
	const usageEntered = latch(), usageRelease = latch(), terminalEntered = latch(), terminalRelease = latch();
	const f = fixture(async (patch) => {
		if (patch.usage) { usageEntered.release(); await usageRelease.promise; }
		if (patch.result) { terminalEntered.release(); await terminalRelease.promise; }
	});
	let calls = 0;
	const engine = { ...f.engine, streamFn: ((...args: Parameters<typeof f.engine.streamFn>) => { calls++; return f.engine.streamFn(...args); }) as typeof f.engine.streamFn };
	const delivery = latch();
	const runner = createJobRunner({ ...f, engineFor: () => engine, deliver: async (steer) => {
		assert.equal(f.state.job?.status, "done");
		assert.equal(f.state.job?.usage?.steps, 1);
		assert.deepEqual(f.state.job?.delivery, { kind: "result", status: "pending" });
		f.delivered.push(steer);
		await delivery.promise;
	} });
	const running = runner.runJob(f.jobId);
	await usageEntered.promise;
	await runner.runJob(f.jobId);
	assert.equal(f.state.job?.status, "running"); assert.equal(f.delivered.length, 0); assert(isJobLive(f.jobId));
	usageRelease.release(); await terminalEntered.promise;
	assert.equal(f.state.job?.usage?.steps, 1); assert.equal(f.state.job?.status, "running"); assert.equal(f.delivered.length, 0);
	terminalRelease.release(); await running;
	assert.equal(calls, 1); assert.equal(f.delivered.length, 1); assert(!isJobLive(f.jobId));
	assert(f.writes.findIndex((patch) => !!patch.usage) < f.writes.findIndex((patch) => !!patch.result));
	delivery.release();
});

test("progress persistence failure aborts cleanly without reporting completion or leaking a rejection", { timeout: 5000 }, async (t) => {
	const errors = t.mock.method(console, "error", () => {});
	const f = fixture(async (patch) => { if (patch.usage) throw new Error("offline fixture store"); });
	await createJobRunner({ ...f, engineFor: () => f.engine, deliver: async (steer) => { f.delivered.push(steer); } }).runJob(f.jobId);
	assert.equal(f.state.job?.status, "running"); assert.equal(f.state.job?.result, undefined);
	assert.equal(f.delivered.length, 0); assert(!isJobLive(f.jobId)); assert(errors.mock.callCount() > 0);
});

test("a failed terminal save does not replace the completed computation with a fabricated failure result", { timeout: 5000 }, async (t) => {
	t.mock.method(console, "error", () => {});
	let resultAttempts = 0;
	const f = fixture(async (patch) => { if (patch.result) { resultAttempts++; throw new Error("terminal save unavailable"); } });
	await createJobRunner({ ...f, engineFor: () => f.engine, deliver: async (steer) => { f.delivered.push(steer); } }).runJob(f.jobId);
	assert.equal(resultAttempts, 1); assert.equal(f.state.job?.status, "running");
	assert.equal(f.state.job?.result, undefined); assert.equal(f.delivered.length, 0); assert(!isJobLive(f.jobId));
});

test("abort waiting behind a progress write keeps billed usage and owns terminal state", { timeout: 5000 }, async () => {
	const entered = latch(), release = latch();
	const f = fixture(async (patch) => { if (patch.usage) { entered.release(); await release.promise; } });
	const running = createJobRunner({ ...f, engineFor: () => f.engine, deliver: async (steer) => { f.delivered.push(steer); } }).runJob(f.jobId);
	await entered.promise;
	const aborted = withChatWrite(f.chatId, async () => {
		assert(f.state.job);
		f.state.job = { ...f.state.job, status: "error", error: "Aborted by learner", activity: "aborted" };
		fireJobAbort(f.jobId);
	});
	release.release(); await aborted; await running;
	assert.equal(f.state.job?.usage?.steps, 1); assert.equal(f.state.job?.status, "error");
	assert.equal(f.state.job?.activity, "aborted"); assert.equal(f.state.job?.result, undefined); assert.equal(f.delivered.length, 0);
});

test("deletion between queued progress and completion cannot recreate a job or deliver into the deleted chat", { timeout: 5000 }, async () => {
	const entered = latch(), release = latch();
	const f = fixture(async (patch) => { if (patch.usage) { entered.release(); await release.promise; } });
	const running = createJobRunner({ ...f, engineFor: () => f.engine, deliver: async (steer) => { f.delivered.push(steer); } }).runJob(f.jobId);
	await entered.promise;
	const deleted = withChatWrite(f.chatId, async () => { f.state.chat = null; f.state.job = null; });
	release.release(); await deleted; await running;
	assert.equal(f.state.job, null); assert.equal(f.delivered.length, 0);
	assert(!f.writes.some((patch) => !!patch.result)); assert(!isJobLive(f.jobId));
});
