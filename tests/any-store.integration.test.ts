import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, after, describe, it } from "node:test";
import { createRequire } from "node:module";
import { createAnyStores, type AnyOptions } from "../src/store/any/index.ts";
import { AnyClient } from "../src/store/any/client.ts";
import type { GraphNode } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
const require = createRequire(import.meta.url);
const { startAnyRuntime } = require("../electron/any-runtime.cjs");
const binary =
	process.env.LH_ANY_TEST_BINARY ??
	path.resolve(
		`vendor/any/${process.platform}-${process.arch}/${process.platform === "win32" ? "any.exe" : "any"}`,
	);
const message = (id: string, content = id): LhMessage => ({ id, role: "user", content, timestamp: 1 });

describe("Any v0.3.5 real local storage", { skip: !fs.existsSync(binary), concurrency: false }, () => {
	let directory: string;
	let runtime: { url: string; accountId: string; stop(): Promise<void> };
	let stores: ReturnType<typeof createAnyStores>;
	let options: AnyOptions;
	before(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-any-store-test-"));
		runtime = await startAnyRuntime({ binary, dataDir: directory });
		options = {
			url: runtime.url,
			expectedAccountId: runtime.accountId,
			dataDir: directory,
			subscribe: false,
		};
		stores = createAnyStores(options);
		await stores.ready();
	});
	after(async () => {
		await stores?.close();
		await runtime?.stop();
		fs.rmSync(directory, { recursive: true, force: true });
	});
	it("stores every native message, serializes concurrent append, and rejects conflicting IDs", async () => {
		const chat = await stores.chatStore.createChat("并发", "reading");
		await Promise.all(
			Array.from({ length: 12 }, (_, i) => stores.chatStore.appendMessages(chat.id, [message(`m${i}`)])),
		);
		await stores.chatStore.appendMessages(chat.id, [message("m0")]);
		assert.equal((await stores.chatStore.getChat(chat.id))!.messages.length, 12);
		await assert.rejects(stores.chatStore.appendMessages(chat.id, [message("m0", "changed")]), /Conflicting/);
	});
	it("reads complete paginated history and preserves large native payloads through Files", async () => {
		const chat = await stores.chatStore.createChat("Long native history");
		const messages = Array.from({ length: 510 }, (_, i) => message(`page${i}`));
		messages.push(message("large", "中文".repeat(100_000)));
		await stores.chatStore.appendMessages(chat.id, messages);
		assert.deepEqual((await stores.chatStore.getChat(chat.id))!.messages, messages);
	});
	it("archives Markdown and PDF bytes with source metadata, including a lost upload response", async () => {
		const chat = await stores.chatStore.createChat("Source", "reading");
		const source = {
			kind: "web" as const,
			originalUrl: "https://example.test/original",
			content: Buffer.from("# 原文\n" + "文章内容\n".repeat(2000)),
		};
		let failed = false;
		const interrupted = createAnyStores({
			...options,
			fetch: async (input, init) => {
				const response = await fetch(input, init);
				if (!failed && init?.method === "POST" && String(input).includes("/files?name=")) {
					failed = true;
					throw new Error("lost upload response");
				}
				return response;
			},
		});
		try {
			await assert.rejects(interrupted.readingSourceStore.save(chat.id, source), /lost upload/);
		} finally {
			await interrupted.close();
		}
		const archive = await stores.readingSourceStore.save(chat.id, source);
		assert.equal(archive.originalUrl, source.originalUrl);
		assert.deepEqual(Buffer.from((await stores.readingSourceStore.get(chat.id))!.content), source.content);
		const location = await stores.ready();
		const listing = await fetch(
			`${runtime.url}/v1/spaces/${location.spaceId}/files?objectId=${location.objectId}`,
		).then((r) => r.json());
		assert.equal(listing.files.filter((file: { name: string }) => file.name.endsWith(".md")).length, 1);
		const pdfChat = await stores.chatStore.createChat("PDF", "reading");
		const pdf = fs.readFileSync(new URL("./fixtures/sample-3page.pdf", import.meta.url));
		await stores.readingSourceStore.save(pdfChat.id, {
			kind: "pdf",
			originalPath: "/original.pdf",
			content: pdf,
		});
		assert.deepEqual(Buffer.from((await stores.readingSourceStore.get(pdfChat.id))!.content), pdf);
	});
	it("keeps two assertions of one logical node and atomically retries graph commits", async () => {
		const point = (chatId: string) => ({ chatId, messageId: "m" });
		const a = {
			id: "n_shared",
			name: "Concept",
			statement: "A concept",
			aliases: [],
			provenance: [point("chat_a")],
			createdAt: "2026-01-01T00:00:00Z",
		} as GraphNode;
		const b = { ...a, provenance: [point("chat_b")] };
		await stores.graphStore.commitBatch({ operationId: "append-a", append: { nodes: [a] } });
		let failed = false;
		const interrupted = createAnyStores({
			...options,
			fetch: async (input, init) => {
				const response = await fetch(input, init);
				if (!failed && String(input).endsWith("/modify") && String(init?.body).includes("append-b")) {
					failed = true;
					throw new Error("lost graph response");
				}
				return response;
			},
		});
		try {
			await assert.rejects(
				interrupted.graphStore.commitBatch({ operationId: "append-b", append: { nodes: [b] } }),
				/lost graph response/,
			);
		} finally {
			await interrupted.close();
		}
		await stores.graphStore.commitBatch({ operationId: "append-b", append: { nodes: [b] } });
		assert.equal((await stores.graphStore.readSnapshot()).nodes.length, 2);
		await stores.graphStore.commitBatch({ operationId: "delete-a", replace: { nodes: [b] } });
		await stores.graphStore.commitBatch({ operationId: "delete-a", replace: { nodes: [] } });
		assert.deepEqual((await stores.graphStore.readSnapshot()).nodes, [b]);
		assert.equal(await stores.graphStore.getRevision(), "delete-a");
	});
	it("does not report partial HTTP 200 graph writes as covered and repairs them on reopen", async () => {
		const node = {
			id: "n_partial",
			name: "Partial",
			statement: "Must be whole",
			aliases: [],
			provenance: [],
			createdAt: "2026-01-01T00:00:00Z",
		} as GraphNode;
		let rejected = false;
		const partial = createAnyStores({
			...options,
			fetch: async (input, init) => {
				if (!rejected && String(input).endsWith("/modify") && typeof init?.body === "string") {
					const body = JSON.parse(init.body);
					const missing = body.records.findIndex(
						(record: { ops: { value: { kind: string; json: string } }[] }) =>
							record.ops[0]?.value.kind === "nodes" && record.ops[0].value.json.includes("n_partial"),
					);
					if (missing >= 0) {
						rejected = true;
						body.records.splice(missing, 1);
						const result = await fetch(input, { ...init, body: JSON.stringify(body) }).then((response) =>
							response.json(),
						);
						return Response.json({
							...result,
							rejections: [{ recordIndex: missing, reason: "injected partial rejection" }],
						});
					}
				}
				return fetch(input, init);
			},
		});
		try {
			await assert.rejects(
				partial.graphStore.commitBatch({
					operationId: "partial-graph",
					append: {
						nodes: [node],
						coverage: [
							{ chatId: "partial-chat", fp: "partial-fp", tokens: 2, foldedAt: "2026-01-01T00:00:00Z" },
						],
					},
				}),
				/rejected/,
			);
			await assert.rejects(partial.graphStore.readCoverage(), /incomplete graph commit/);
		} finally {
			await partial.close();
		}
		await stores.ready();
		const recovered = await stores.graphStore.readSnapshot();
		assert.ok(recovered.nodes.some((value) => value.id === "n_partial"));
		assert.equal(recovered.coverage.filter((value) => value.chatId === "partial-chat").length, 1);
		await stores.graphStore.commitBatch({ operationId: "partial-graph" });
		assert.equal((await stores.graphStore.readNodes()).filter((value) => value.id === "n_partial").length, 1);
	});
	it("replaces a large graph by preserving unchanged assertions and refuses oversized new batches before journaling", async () => {
		const before = (await stores.graphStore.readSnapshot()).nodes;
		const nodes = Array.from(
			{ length: 600 },
			(_, index) =>
				({
					id: `n_scale_${index}`,
					name: `Scale ${index}`,
					statement: "Evidence details. ".repeat(130),
					aliases: [],
					provenance: [],
					createdAt: "2026-01-01T00:00:00Z",
				}) as GraphNode,
		);
		for (let offset = 0; offset < nodes.length; offset += 100)
			await stores.graphStore.commitBatch({
				operationId: `scale-${offset}`,
				append: { nodes: nodes.slice(offset, offset + 100) },
			});
		const retained = [...before, ...nodes.slice(1)];
		await stores.graphStore.commitBatch({ operationId: "scale-delete-one", replace: { nodes: retained } });
		assert.deepEqual((await stores.graphStore.readSnapshot()).nodes, retained);
		await assert.rejects(
			stores.graphStore.commitBatch({ operationId: "scale-too-large", append: { nodes } }),
			/batch exceeds/,
		);
		assert.deepEqual((await stores.graphStore.readSnapshot()).nodes, retained);
	});
	it("persists deletion barriers and refuses fresh messages/jobs until cleanup", async () => {
		const chat = await stores.chatStore.createChat("Delete", "reading");
		await stores.chatStore.appendMessages(chat.id, [message("delete-m")]);
		await stores.chatStore.beginDeletion(chat.id, {
			mode: "preserve-graph",
			operationId: "delete-chat",
			startedAt: new Date().toISOString(),
		});
		await assert.rejects(stores.chatStore.appendMessages(chat.id, [message("late")]), /deleted/);
		assert.ok((await stores.chatStore.listDeletingChats()).some((record) => record.id === chat.id));
		assert.ok(!(await stores.chatStore.listChats()).some((record) => record.id === chat.id));
		await stores.chatStore.deleteChat(chat.id);
		assert.equal(await stores.chatStore.getChat(chat.id), null);
	});
	it("resubscribes after an interrupted change stream and invalidates cached views", async () => {
		let connections = 0;
		let invalidations = 0;
		const watched = createAnyStores({
			...options,
			subscribe: true,
			onChange: () => {
				invalidations++;
			},
			fetch: async (input, init) => {
				if (String(input).endsWith("/query/subscribe") && ++connections === 1) {
					return new Response('event: snapshot\ndata: {"records":[]}\n\n', {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				return fetch(input, init);
			},
		});
		try {
			await watched.ready();
			const deadline = Date.now() + 5000;
			while (connections < 2 && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 25));
			assert.ok(connections >= 2);
			assert.ok(invalidations >= 2);
		} finally {
			await watched.close();
		}
	});
	it("refuses corrupted original bytes instead of silently reimporting", async () => {
		const chat = await stores.chatStore.createChat("Integrity", "reading");
		await stores.readingSourceStore.save(chat.id, {
			kind: "web",
			originalUrl: "https://example.test/integrity",
			content: Buffer.from("original"),
		});
		const corrupt = createAnyStores({
			...options,
			fetch: async (input, init) =>
				String(input).endsWith("/content") ? new Response("corrupted") : fetch(input, init),
		});
		try {
			await assert.rejects(corrupt.readingSourceStore.get(chat.id), /damaged/);
		} finally {
			await corrupt.close();
		}
	});
	it("checks the persisted application schema before serving data", async () => {
		const client = new AnyClient(options);
		await client.ready();
		await client.write([await client.row("schema", "schema", "", 0, { version: 999 })]);
		const newer = createAnyStores(options);
		try {
			await assert.rejects(newer.ready(), /schema/);
		} finally {
			await newer.close();
			await client.write([await client.row("schema", "schema", "", 0, { version: 1 })]);
			await client.close();
		}
	});
	it("survives a real process restart and refuses another account", async () => {
		const chat = await stores.chatStore.createChat("Reopen", "reading");
		await stores.chatStore.appendMessages(chat.id, [message("restart")]);
		await stores.close();
		await runtime.stop();
		runtime = await startAnyRuntime({ binary, dataDir: directory });
		options = { ...options, url: runtime.url };
		stores = createAnyStores(options);
		await stores.ready();
		assert.equal((await stores.chatStore.getChat(chat.id))!.messages[0]!.id, "restart");
		const other = createAnyStores({ ...options, expectedAccountId: "wrong-account" });
		await assert.rejects(other.ready(), /account/);
		await other.close();
	});
});

describe("Any HTTP contract guards", () => {
	it("rejects non-owned endpoints and detects per-record failure despite HTTP 200", async () => {
		assert.throws(
			() => new AnyClient({ url: "https://remote.test", expectedAccountId: "account" }),
			/loopback/,
		);
		const client = new AnyClient({
			url: "http://127.0.0.1:1234",
			expectedAccountId: "account",
			fetch: async () => Response.json({ rejections: [{ recordId: "e1", reason: "invalid" }] }),
		});
		await assert.rejects(client.request("/test", {}), /rejected/);
		await client.close();
	});
});
