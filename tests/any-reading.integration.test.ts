/** Real Any + real reading tools and extraction, with deterministic local model responses. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { readingStateOf, type ReadingArticle, type ReadingNode } from "../src/core/reading.ts";
const require = createRequire(import.meta.url);
const { startAnyRuntime } = require("../electron/any-runtime.cjs");
const binary =
	process.env.LH_ANY_TEST_BINARY ??
	path.resolve(
		`vendor/any/${process.platform}-${process.arch}/${process.platform === "win32" ? "any.exe" : "any"}`,
	);
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const call = (name: string, input: object, id: string) =>
	fauxAssistantMessage([fauxToolCall(name, input as Parameters<typeof fauxToolCall>[1], { id })], {
		stopReason: "toolUse",
	});
function engine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

it(
	"Any preserves web/PDF reading, detours, learner evidence, reasoning chains and interrupted deletion across restart",
	{ skip: !fs.existsSync(binary), timeout: 90_000 },
	async (test) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-any-reading-"));
		let runtime = await startAnyRuntime({ binary, dataDir: path.join(directory, "any") });
		test.after(async () => {
			await runtime.stop();
		});
		const previousEnv = { ...process.env };
		const originalFetch = globalThis.fetch;
		let externalCalls = 0;
		globalThis.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (new URL(url).hostname !== "127.0.0.1") {
				externalCalls++;
				throw new Error(`Unexpected external request: ${new URL(url).origin}`);
			}
			return originalFetch(input, init);
		};
		Object.assign(process.env, {
			LH_DATA_DIR: path.join(directory, "local"),
			LH_STORAGE_BACKEND: "any",
			LH_ANY_URL: runtime.url,
			LH_ANY_ACCOUNT_ID: runtime.accountId,
			LH_ANY_DATA_DIR: path.join(directory, "any"),
			OPENROUTER_API_KEY: "local-faux-test-key",
		});
		const { stores, storageReady, closeStorage } = await import("../src/server/stores.ts");
		const { createReadingSourceLoader } = await import("../src/server/reading-sources.ts");
		const { getReadingSourceDownload } = await import("../src/server/reading-source-download.ts");
		const { createReadingAgent } = await import("../src/agent/teacher-agent.ts");
		const { handleChatInput } = await import("../src/server/chat-handler.ts");
		const { runningTurn } = await import("../src/server/turn-runs.ts");
		const { createExtractionPipeline } = await import("../src/agent/subagents/extraction.ts");
		const { deleteChatSession } = await import("../src/server/chats.ts");
		try {
			await storageReady();
			const old = await stores.chatStore.createChat("以前的学习");
			await stores.graphStore.appendNode({
				id: "n_evidence",
				name: "来源追溯",
				statement: "记录证据能帮助回顾理解。",
				aliases: [],
				provenance: [{ chatId: old.id, messageId: "" }],
				createdAt: new Date().toISOString(),
			});
			const results: {
				id: string;
				state: ReturnType<typeof readingStateOf>;
				sha: string;
				evidenceId: string;
			}[] = [];
			const pdf = fs.readFileSync(new URL("./fixtures/sample-3page.pdf", import.meta.url));
			for (const kind of ["web", "pdf"] as const) {
				const chat = await stores.chatStore.createChat(`${kind} 带读`, "reading");
				await stores.chatStore.saveSettings(chat.id, {
					model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
				});
				const url = `https://article.test/${kind}`;
				let article!: ReadingArticle;
				let nodes!: ReadingNode[];
				let fetches = 0;
				const load = createReadingSourceLoader(stores.readingSourceStore, {
					chatStore: stores.chatStore,
					fetch: async () => {
						fetches++;
						return new Response(
							kind === "pdf" ? pdf : "# 原文资料\n\n保存证据有助于回顾。\n\n## 验证\n\n回到原文确认理解。",
							{ headers: { "Content-Type": kind === "pdf" ? "application/pdf" : "text/markdown" } },
						);
					},
				});
				const loadSource: typeof load = async (...args) => (article = await load(...args));
				const turn = async (text: string, steps: FauxResponseStep[]) => {
					const scripted = engine(steps);
					const response = await handleChatInput(chat.id, { type: "text", text }, (opts) =>
						createReadingAgent(
							{ chatId: chat.id, chatStore: stores.chatStore, graphStore: stores.graphStore, loadSource },
							{ ...opts, engine: scripted },
						),
					);
					assert.equal(response.status, 200, await response.clone().text());
					const handle = runningTurn(chat.id);
					if (handle) await new Response(handle.subscribe()).text();
					assert.ok(
						!(await stores.chatStore.getChat(chat.id))!.messages.some(
							(message) => message.role === "assistant" && message.stopReason === "error",
						),
					);
				};
				await turn(`带我读 ${url}`, [
					call("reading_load", { url }, `${kind}-load`),
					() => {
						nodes = [
							{ id: "opening", title: "原文开头", blockIds: [article.blocks[0]!.id] },
							{
								id: "remaining",
								title: "继续阅读",
								blockIds: article.blocks.slice(1).map((block) => block.id),
							},
						];
						return call("reading_plan", { nodes }, `${kind}-plan`);
					},
					call("reading_focus", { action: "read", nodeId: "opening" }, `${kind}-focus`),
					fauxAssistantMessage("先读开头，随时提出你的疑问。"),
				]);
				let evidenceId = "";
				await turn("我发现记录证据能帮助回顾理解。保存原文让我能重新验证理解。还能展开说说吗？", [
					() =>
						call(
							"reading_plan",
							{
								nodes: [
									...nodes,
									{ id: "detour", title: "展开来源追溯", parentId: "opening", blockIds: nodes[0]!.blockIds },
								],
							},
							`${kind}-branch`,
						),
					call("reading_focus", { action: "discuss", nodeId: "detour" }, `${kind}-discuss`),
					async () => {
						evidenceId = (await stores.chatStore.getChat(chat.id))!.messages
							.filter((message) => message.role === "user")
							.at(-1)!.id;
						return call(
							"reading_note",
							{
								id: "discovery",
								kind: "discovery",
								text: "记录证据能帮助回顾理解。",
								nodeId: "opening",
								blockIds: nodes[0]!.blockIds,
								evidence: [{ messageId: evidenceId, quote: "记录证据能帮助回顾理解" }],
								graphNodeIds: ["n_evidence"],
							},
							`${kind}-note`,
						);
					},
					fauxAssistantMessage("我们展开讨论，原文的位置已经保留。"),
				]);
				const detour = readingStateOf((await stores.chatStore.getChat(chat.id))!.messages);
				assert.equal(detour.readNodeId, "opening");
				assert.equal(detour.discussionNodeId, "detour");
				await turn("回到文章", [
					call("reading_focus", { action: "return" }, `${kind}-return`),
					fauxAssistantMessage("现在回到原文开头。"),
				]);
				const state = readingStateOf((await stores.chatStore.getChat(chat.id))!.messages);
				assert.equal(state.discussionNodeId, "opening");
				assert.equal(state.notes[0]!.evidence[0]!.messageId, evidenceId);
				assert.equal(fetches, 1);
				const pipeline = createExtractionPipeline({
					chatStore: stores.chatStore,
					graphStore: stores.graphStore,
					getChunkTokens: () => 100_000,
					extractor: engine([
						call(
							"submit_findings",
							{
								propositions: [
									{
										id: "p1",
										name: "来源追溯",
										statement: "记录证据能帮助回顾理解。",
										aliases: [],
										messageId: evidenceId,
									},
									{
										id: "p2",
										name: "重新验证",
										statement: "保存原文让我能重新验证理解。",
										aliases: [],
										messageId: evidenceId,
									},
								],
								chains: [{ premises: ["p1"], conclusion: "p2" }],
							},
							`${kind}-findings`,
						),
					]),
					auditor: engine([
						call("submit_review", { links: [{ id: "p1", linkTo: "n_evidence" }] }, `${kind}-review`),
					]),
				});
				await pipeline.runExtraction(chat.id);
				const graph = await stores.graphStore.readSnapshot();
				assert.ok(
					graph.chains.some(
						(chain) =>
							chain.premises.includes("n_evidence") &&
							chain.provenance.some((point) => point.chatId === chat.id),
					),
				);
				assert.ok(graph.coverage.some((entry) => entry.chatId === chat.id));
				const download = await getReadingSourceDownload(chat.id);
				assert.equal(download.status, 200);
				const content = new Uint8Array(await download.arrayBuffer());
				if (kind === "pdf") assert.deepEqual(Buffer.from(content), pdf);
				else assert.match(Buffer.from(content).toString(), /https:\/\/article.test\/web/);
				results.push({ id: chat.id, state, sha: hash(content), evidenceId });
			}
			assert.equal(
				(await stores.graphStore.readSnapshot()).chains.length,
				2,
				"reading-route links never become implication chains",
			);
			const removeSource = stores.readingSourceStore.delete;
			stores.readingSourceStore.delete = async () => {
				throw new Error("Interrupted archive cleanup");
			};
			try {
				await assert.rejects(
					deleteChatSession(results[0]!.id, "delete-nodes"),
					/Interrupted archive cleanup/,
				);
			} finally {
				stores.readingSourceStore.delete = removeSource;
			}
			assert.ok((await stores.chatStore.getChat(results[0]!.id))!.deleting);
			await closeStorage();
			await runtime.stop();
			runtime = await startAnyRuntime({ binary, dataDir: path.join(directory, "any") });
			process.env.LH_ANY_URL = runtime.url;
			await storageReady(); // Includes interrupted deletion recovery.
			assert.equal(await stores.chatStore.getChat(results[0]!.id), null);
			assert.equal((await getReadingSourceDownload(results[0]!.id)).status, 404);
			const retained = results[1]!;
			assert.deepEqual(
				readingStateOf((await stores.chatStore.getChat(retained.id))!.messages),
				retained.state,
			);
			assert.equal(
				hash(new Uint8Array(await (await getReadingSourceDownload(retained.id)).arrayBuffer())),
				retained.sha,
			);
			const graph = await stores.graphStore.readSnapshot();
			assert.ok(
				graph.nodes.some(
					(node) =>
						node.id === "n_evidence" &&
						node.provenance.some(
							(point) => point.chatId === retained.id && point.messageId === retained.evidenceId,
						),
				),
			);
			assert.ok(
				!graph.nodes.some((node) => node.provenance.some((point) => point.chatId === results[0]!.id)),
			);
			assert.equal(graph.chains.length, 1);
			assert.equal(externalCalls, 0);
		} finally {
			await closeStorage();
			await runtime.stop();
			globalThis.fetch = originalFetch;
			for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
			Object.assign(process.env, previousEnv);
			fs.rmSync(directory, { recursive: true, force: true });
		}
	},
);
