import assert from "node:assert/strict";
import { test } from "node:test";
import { chatStore } from "../src/store/chats.ts";
import { newUserMessage } from "../src/core/native-messages.ts";
import { beginStorageShutdown } from "../src/core/storage-lifecycle.ts";
import { abortCompactions, awaitCompactions, ensureCompacted, kickCompaction, type CompactionDeps } from "../src/server/compaction.ts";

function latch() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
async function fixture(): Promise<{ id: string; deps: CompactionDeps }> {
	const chat = await chatStore.createChat("Shutdown compaction");
	await chatStore.appendMessages(chat.id, [newUserMessage("A".repeat(100_000)), newUserMessage("B".repeat(100_000)), newUserMessage("C".repeat(100_000)), newUserMessage("Recent")]);
	return { id: chat.id, deps: { chatStore, engine: { model: { provider: "faux", id: "test" } } as never, modelId: "faux:test", kind: "teach", thresholdTokens: 10_000, systemPromptTokens: 0, summarize: async () => ({ summary: "Saved summary", usage }) } };
}

test("shutdown aborts summaries, prevents delayed preparation from dispatching, and drains final usage writes", { timeout: 5000 }, async () => {
	const active = await fixture(), writing = await fixture(), preparing = await fixture();
	const modelEntered = latch(), aborted = latch(), usageEntered = latch(), usageRelease = latch(), prepareRelease = latch();
	let modelCalls = 0;
	const activeRun = ensureCompacted({ ...active.deps, summarize: async (_prompt, _engine, signal) => {
		modelCalls++; modelEntered.release();
		assert.ok(signal);
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted.release(); resolve(); }, { once: true }));
		return { summary: "Must not persist an aborted summary", usage };
	} }, active.id);
	const writingRun = ensureCompacted({ ...writing.deps, chatStore: { ...chatStore, appendTurnUsage: async (id, value) => {
		usageEntered.release(); await usageRelease.promise; await chatStore.appendTurnUsage(id, value);
	} } }, writing.id);
	kickCompaction(async () => {
		await prepareRelease.promise;
		return { ...preparing.deps, summarize: async () => { modelCalls++; return { summary: "Too late", usage }; } };
	}, preparing.id);
	await Promise.all([modelEntered.promise, usageEntered.promise]);
	beginStorageShutdown(); abortCompactions(); await aborted.promise;
	let drained = false;
	const drain = awaitCompactions().then(() => { drained = true; });
	await activeRun;
	assert.equal(drained, false);
	prepareRelease.release(); await Promise.resolve();
	assert.equal(drained, false, "the model has stopped but its final usage write is pending");
	usageRelease.release(); await writingRun; await drain;
	assert.equal(modelCalls, 1, "asynchronous preparation never crosses shutdown into a model call");
	assert.equal((await chatStore.getChat(active.id))!.messages.length, 4);
	assert.equal((await chatStore.getChat(writing.id))!.turns?.length, 1);
	await ensureCompacted(preparing.deps, preparing.id);
	assert.equal((await chatStore.getChat(preparing.id))!.messages.length, 4);
});
