import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test, type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { buildSubagentSteer, type ChatRecord, type ChatSummary, type JobRecord, type SteerMessage } from "../src/core/contracts.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-any-job-recovery-"));
process.env.LH_STORAGE_BACKEND = "any";
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
// These tests exercise the Any recovery policy with asynchronous store seams.
// An unexpected unmocked storage access must fail, never start a real service.
delete process.env.LH_ANY_URL;
delete process.env.LH_ANY_ACCOUNT_ID;
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const { stores } = await import("../src/server/stores.ts");
const {
	awaitWakeWrites, discardChatDeliveries, noteSteersDurable, recoverStaleJobs,
	registerLiveAgent, unregisterLiveAgent, setJobRespawn, setTurnRunner,
} = await import("../src/server/jobs.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");

interface Queued {
	steer: SteerMessage;
	deferred?: boolean;
	promise: Promise<void>;
}
interface WakeFixtureState {
	queues: Map<string, Queued[]>;
	lastSweepAt: number;
}
const host = globalThis as typeof globalThis & { __lhWakePipeline?: WakeFixtureState };
const result = { brief: "A completed result restored from Any", sources: [] };
let sequence = 0;
const owners = new Set<string>();

function latch() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

beforeEach(() => { delete host.__lhWakePipeline; });
afterEach(async () => {
	for (const id of owners) { unregisterLiveAgent(id); endTurn(id); discardChatDeliveries(id); }
	await awaitWakeWrites();
	owners.clear();
	delete host.__lhWakePipeline;
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

function fixture(t: TestContext, initial: Partial<JobRecord> = {}, beforeReceipt: () => Promise<void> = async () => {}) {
	const id = ++sequence;
	const now = new Date().toISOString();
	const chat: ChatRecord = { id: `any-recovery-chat-${id}`, title: "Any recovery", messages: [], createdAt: now, updatedAt: now };
	owners.add(chat.id);
	let job: JobRecord = {
		id: `any-recovery-job-${id}`, chatId: chat.id, kind: "research", toolCallId: `call-${id}`,
		status: "running", activity: "researching", input: { question: "Saved original request" },
		createdAt: now, updatedAt: now, ...initial,
	};
	const summary: ChatSummary = { ...chat, kind: "teach", phase: "teach", messageCount: 0, pendingQuestion: false, pendingProblem: false };
	const writes: Array<Parameters<typeof stores.jobStore.updateJob>[1]> = [];
	let spawns = 0, wakes = 0;
	t.mock.method(stores.chatStore, "getChat", async (chatId: string) => chatId === chat.id ? structuredClone(chat) : null);
	t.mock.method(stores.chatStore, "listChats", async () => [summary]);
	t.mock.method(stores.jobStore, "getJob", async (jobId: string) => jobId === job.id ? structuredClone(job) : null);
	t.mock.method(stores.jobStore, "listJobs", async (chatId: string) => chatId === chat.id ? [structuredClone(job)] : []);
	t.mock.method(stores.jobStore, "updateJob", async (jobId: string, patch: Parameters<typeof stores.jobStore.updateJob>[1]) => {
		if (jobId !== job.id) return null;
		if (patch.delivery?.status === "delivered") await beforeReceipt();
		writes.push(structuredClone(patch));
		job = { ...job, ...structuredClone(patch) };
		return structuredClone(job);
	});
	setJobRespawn(() => { spawns++; });
	setTurnRunner(async () => { wakes++; return 500; });
	return { chat, get job() { return job; }, writes, get spawns() { return spawns; }, get wakes() { return wakes; } };
}

async function sweep() {
	if (host.__lhWakePipeline) host.__lhWakePipeline.lastSweepAt = 0;
	await recoverStaleJobs();
}

function liveAgent() {
	const handed: SteerMessage[] = [];
	return { handed, value: { steer: (steer: SteerMessage) => handed.push(steer) } as unknown as Agent };
}

test("Any recovery interrupts an unfinished worker without respawn or automatic model wake", async (t) => {
	const f = fixture(t);
	const input = structuredClone(f.job.input);
	await sweep(); await sweep();
	assert.equal(f.job.status, "error"); assert.equal(f.job.activity, "interrupted");
	assert.match(f.job.error ?? "", /Start it again explicitly/);
	assert.equal(f.job.result, undefined); assert.equal(f.job.delivery, undefined);
	assert.deepEqual(f.job.input, input);
	assert.equal(f.spawns, 0); assert.equal(f.wakes, 0);
	assert.equal(host.__lhWakePipeline?.queues.size, 0);
	assert.equal(f.writes.length, 1, "a subsequent sweep must not rewrite the interrupted outcome");
});

for (const legacy of [false, true]) test(`Any recovery defers ${legacy ? "legacy running result" : "pending completed result"} until an explicit learner run`, async (t) => {
	const f = fixture(t, {
		status: legacy ? "running" : "done", result,
		...(legacy ? {} : { delivery: { kind: "result", status: "pending" } as const }),
	});
	await sweep(); await sweep(); await sweep();
	const queued = host.__lhWakePipeline!.queues.get(f.chat.id)!;
	assert.equal(queued.length, 1); assert.equal(queued[0]!.deferred, true);
	assert.equal(f.job.status, "done"); assert.equal(f.job.delivery?.status, "pending");
	assert.equal(f.spawns, 0); assert.equal(f.wakes, 0);
	let deliveryComplete = false;
	void queued[0]!.promise.then(() => { deliveryComplete = true; });
	await awaitWakeWrites();
	assert.equal(deliveryComplete, false, "draining finite writes must not await learner consumption");

	const automatic = liveAgent();
	await registerLiveAgent(f.chat.id, automatic.value, false);
	assert.equal(automatic.handed.length, 0);
	unregisterLiveAgent(f.chat.id);
	const learner = liveAgent(); assert(beginTurn(f.chat.id));
	await registerLiveAgent(f.chat.id, learner.value, true);
	await registerLiveAgent(f.chat.id, learner.value, true);
	assert.deepEqual(learner.handed.map((steer) => steer.id), [queued[0]!.steer.id]);
	assert.equal(f.job.delivery?.status, "pending", "handing off a marker is not durable acceptance");
	f.chat.messages.push(...structuredClone(learner.handed));
	await noteSteersDurable(f.chat.id, f.chat.messages);
	await queued[0]!.promise;
	assert.equal(f.job.delivery?.status, "delivered"); assert.equal(f.job.status, "done");
	assert.equal(f.wakes, 0); assert.equal(f.spawns, 0);
});

test("Any registration without a prior sweep cannot hand restored results to an automatic run", async (t) => {
	const f = fixture(t, { status: "done", result, delivery: { kind: "result", status: "pending" } });
	const automatic = liveAgent();
	await registerLiveAgent(f.chat.id, automatic.value, false);
	assert.equal(automatic.handed.length, 0);
	assert.equal(host.__lhWakePipeline!.queues.get(f.chat.id)![0]!.deferred, true);
	assert.equal(f.wakes, 0); assert.equal(f.spawns, 0);
});

test("a marker already in the durable transcript repairs only the delivery receipt", async (t) => {
	const f = fixture(t, { status: "done", result, delivery: { kind: "result", status: "pending" } });
	f.chat.messages.push(buildSubagentSteer(f.job, result));
	await sweep(); await sweep();
	const learner = liveAgent(); await registerLiveAgent(f.chat.id, learner.value, true);
	assert.equal(f.job.delivery?.status, "delivered"); assert.equal(f.job.status, "done");
	assert.equal(learner.handed.length, 0); assert.equal(f.chat.messages.length, 1);
	assert.equal(host.__lhWakePipeline!.queues.size, 0);
	assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0], { delivery: { kind: "result", status: "delivered" } });
	assert.equal(f.wakes, 0); assert.equal(f.spawns, 0);
});

test("awaitWakeWrites waits for a delivery receipt save, not the unconsumed deferred queue", { timeout: 5000 }, async (t) => {
	const entered = latch(), release = latch();
	const f = fixture(t, { status: "done", result, delivery: { kind: "result", status: "pending" } }, async () => {
		entered.release(); await release.promise;
	});
	await sweep();
	const entry = host.__lhWakePipeline!.queues.get(f.chat.id)![0]!;
	let consumed = false;
	void entry.promise.then(() => { consumed = true; });
	await awaitWakeWrites(); assert.equal(consumed, false);
	f.chat.messages.push(structuredClone(entry.steer));
	const receipt = noteSteersDurable(f.chat.id, f.chat.messages);
	await entered.promise;
	let drained = false;
	const drain = awaitWakeWrites().then(() => { drained = true; });
	await Promise.resolve();
	assert.equal(drained, false); assert.equal(consumed, false);
	assert.equal(f.job.delivery?.status, "pending");
	release.release(); await receipt; await drain; await entry.promise;
	assert.equal(consumed, true); assert.equal(f.job.delivery?.status, "delivered");
	assert.equal(f.wakes, 0); assert.equal(f.spawns, 0);
});
