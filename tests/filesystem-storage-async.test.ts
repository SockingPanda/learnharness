import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { GraphCommit } from "../src/core/ports.ts";
import type { GraphNode } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-async-stores-"));
process.env.LH_DATA_DIR = root;
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { createReadingSourceStore } = await import("../src/store/reading-sources.ts");
const graphDir = path.join(root, "graph");
const pendingFile = path.join(graphDir, ".pending-commit.json");

after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
	for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
});

const message = (id: string, content = id): LhMessage => ({ id, role: "user", content, timestamp: 1 });
const node = (chatId: string): GraphNode => ({
	id: "n_shared", name: "Shared concept", statement: "One concept can have several sources.", aliases: [chatId],
	createdAt: "2026-10-29T00:00:00.000Z", provenance: [{ chatId, messageId: `msg_${chatId}` }],
});
const batch = (): GraphCommit => ({
	operationId: "extract:chat_first:0",
	append: {
		nodes: [node("chat_first"), { ...node("chat_first"), id: "n_conclusion" }],
		chains: [{ id: "arg_first", premises: ["n_shared"], conclusion: "n_conclusion", createdAt: "2026-10-29T00:00:00.000Z", provenance: [{ chatId: "chat_first", messageId: "msg_chat_first" }] }],
		coverage: [{ chatId: "chat_first", fp: "fingerprint", tokens: 10, foldedAt: "2026-10-29T00:00:00.000Z" }],
		checkpoints: [{ chatId: "chat_first", foldedAt: "2026-10-29T00:00:00.000Z" }],
	},
});

describe("asynchronous filesystem store contracts", () => {
	it("reading an empty graph neither creates a data directory nor stamps its schema", async () => {
		assert.deepEqual(fs.readdirSync(root), []);
		const snapshot = await graphStore.readSnapshot();
		assert.deepEqual(snapshot.nodes, []);
		assert.equal(typeof snapshot.revision, "string");
		assert.equal(snapshot.revision, await graphStore.getRevision());
		assert.deepEqual(fs.readdirSync(root), []);
	});

	it("serializes concurrent appends, preserves native payloads, and ignores identical replays", async () => {
		const chat = await chatStore.createChat("Concurrent transcript", "reading");
		const messages = Array.from({ length: 32 }, (_, i) => message(`m${i}`));
		await Promise.all(messages.map((entry) => chatStore.appendMessages(chat.id, [entry])));
		await Promise.all(messages.map((entry) => chatStore.appendMessages(chat.id, [{ ...entry }])));
		const tool: LhMessage = { id: "tool_1", role: "toolResult", toolName: "reading_note", toolCallId: "call_1", content: [{ type: "text", text: "Saved" }], details: { kind: "reading", evidence: ["b1"], nested: { value: 3 } }, isError: false, timestamp: 5 };
		await chatStore.appendMessages(chat.id, [tool]);
		assert.deepEqual((await chatStore.getChat(chat.id))!.messages, [...messages, tool]);
	});

	it("rejects a conflicting native ID without committing other messages from that batch", async () => {
		const chat = await chatStore.createChat("Conflict");
		await chatStore.appendMessages(chat.id, [message("m1")]);
		await assert.rejects(chatStore.appendMessages(chat.id, [message("m2"), message("m1", "different")]), /Conflicting message id/);
		assert.deepEqual((await chatStore.getChat(chat.id))!.messages, [message("m1")]);
	});

	it("persists the deletion barrier, hides the session from lists and refuses later writes", async () => {
		const chat = await chatStore.createChat("Deleting");
		const deletion = { mode: "preserve-graph" as const, operationId: "delete-chat-1", startedAt: "2026-10-29T00:00:00.000Z" };
		await chatStore.beginDeletion(chat.id, deletion);
		await chatStore.beginDeletion(chat.id, { ...deletion, operationId: "retried-delete" });
		assert.deepEqual((await chatStore.getChat(chat.id))!.deleting, deletion);
		assert.equal((await chatStore.listChats()).some((entry) => entry.id === chat.id), false);
		assert.equal((await chatStore.listDeletingChats())[0]!.id, chat.id);
		await assert.rejects(chatStore.appendMessages(chat.id, [message("late")]), /being deleted/);
		await assert.rejects(chatStore.saveTree(chat.id, { nodes: [], edges: [], version: 1 }), /being deleted/);
		assert.equal(await chatStore.deleteChat(chat.id), true);
		assert.deepEqual(await chatStore.listDeletingChats(), []);
	});

	it("updates the pending-turn receipt without replacing messages or other session metadata", async () => {
		const chat = await chatStore.createChat("Pending turn");
		await chatStore.appendMessages(chat.id, [message("m1")]);
		const before = (await chatStore.getChat(chat.id))!;
		await Promise.all([
			chatStore.setPendingTurn(chat.id, "turn_1"),
			chatStore.appendMessages(chat.id, [message("m2")]),
		]);
		const pending = (await chatStore.getChat(chat.id))!;
		assert.equal(pending.pendingTurnId, "turn_1");
		assert.deepEqual(pending.messages, [message("m1"), message("m2")]);
		assert.equal(pending.title, before.title);
		await chatStore.setPendingTurn(chat.id, null);
		const cleared = (await chatStore.getChat(chat.id))!;
		assert.equal(Object.hasOwn(cleared, "pendingTurnId"), false);
		assert.deepEqual(cleared.messages, pending.messages);
		await chatStore.beginDeletion(chat.id, { mode: "preserve-graph", operationId: "delete-pending", startedAt: "2026-10-29T00:00:00.000Z" });
		await assert.rejects(chatStore.setPendingTurn(chat.id, "turn_2"), /being deleted/);
	});

	it("failed chat publication preserves the old transcript and permits a retry", async (t) => {
		const chat = await chatStore.createChat("Atomic file");
		await chatStore.appendMessages(chat.id, [message("m1")]);
		const rename = fs.renameSync;
		const fault = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
			if (String(to).endsWith(`${chat.id}.json`)) throw new Error("publication interrupted");
			return rename(from, to);
		});
		await assert.rejects(chatStore.appendMessages(chat.id, [message("m2")]), /publication interrupted/);
		assert.deepEqual((await chatStore.getChat(chat.id))!.messages, [message("m1")]);
		fault.mock.restore();
		await chatStore.appendMessages(chat.id, [message("m2")]);
		assert.equal((await chatStore.getChat(chat.id))!.messages.length, 2);
	});

	it("deduplicates simultaneous job creation by session and tool call", async () => {
		const jobs = await Promise.all(Array.from({ length: 12 }, () => jobStore.createJob({ chatId: "chat_one", toolCallId: "call_one", kind: "research" })));
		assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
		assert.equal((await jobStore.listJobs("chat_one")).length, 1);
		await jobStore.updateJob(jobs[0]!.id, { activity: "Saved" });
		assert.equal((await jobStore.getJob(jobs[0]!.id))!.activity, "Saved");
	});

	it("retains separate assertions for a shared logical node and receipts across retries", async () => {
		await graphStore.commitBatch({ operationId: "first", append: { nodes: [node("chat_first")] } });
		await graphStore.commitBatch({ operationId: "second", append: { nodes: [node("chat_second")] } });
		assert.equal((await graphStore.readNodes()).length, 2);
		await graphStore.commitBatch({ operationId: "delete-first", replace: { nodes: [node("chat_second")] } });
		const revision = await graphStore.getRevision();
		// Recovery recalculates against the already cleaned graph: the receipt
		// makes that second draft a no-op rather than deleting surviving evidence.
		await graphStore.commitBatch({ operationId: "delete-first", replace: { nodes: [] } });
		assert.deepEqual(await graphStore.readNodes(), [node("chat_second")]);
		assert.equal(await graphStore.getRevision(), revision);
	});

	for (const target of ["nodes.jsonl", "chains.jsonl", "coverage.jsonl", ".commits"]) {
		it(`recovers an interrupted graph batch at ${target} without exposing partial coverage`, async (t) => {
			const rename = fs.renameSync;
			const fault = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
				if (target === ".commits" ? String(to).includes(`${path.sep}.commits${path.sep}`) : String(to).endsWith(target)) throw new Error("graph publication interrupted");
				return rename(from, to);
			});
			await assert.rejects(graphStore.commitBatch(batch()), /graph publication interrupted/);
			assert.equal(fs.existsSync(pendingFile), true);
			await assert.rejects(graphStore.readSnapshot(), /graph publication interrupted/);
			fault.mock.restore();
			const restored = await graphStore.readSnapshot();
			assert.equal(restored.nodes.length, 2);
			assert.equal(restored.chains.length, 1);
			assert.equal(restored.coverage.length, 1);
			assert.equal(restored.checkpoints.length, 1);
			assert.equal(fs.existsSync(pendingFile), false);
			await graphStore.commitBatch(batch());
			assert.deepEqual(await graphStore.readSnapshot(), restored);
		});
	}

	it("rejects an invalid recovery journal without reading a partial graph or following file paths", async () => {
		fs.mkdirSync(graphDir, { recursive: true });
		fs.writeFileSync(pendingFile, JSON.stringify({ version: 1, operationId: "bad", fingerprint: "a".repeat(64), writes: { "../outside": "corrupt" } }));
		await assert.rejects(graphStore.readSnapshot(), /recovery journal is invalid/);
		assert.equal(fs.existsSync(path.join(root, "outside")), false);
	});

	it("reopening an archive factory preserves concurrent save idempotence", async () => {
		const first = createReadingSourceStore(path.join(root, "sources"));
		const second = createReadingSourceStore(path.join(root, "sources"));
		const input = { kind: "web" as const, originalUrl: "https://example.test/article", content: Buffer.from("# Original\n") };
		const [a, b] = await Promise.all([first.save("chat_source", input), second.save("chat_source", input)]);
		assert.deepEqual(a, b);
		assert.deepEqual((await second.get("chat_source"))!.content, input.content);
		assert.deepEqual(fs.readdirSync(path.join(root, "sources")), ["chat_source"]);
	});
});
