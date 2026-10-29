/** Full reading → detour → discovery → return → graph merge, no network/LLM. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { readingStateOf, readingSessionContext, type ReadingNode, type ReadingNavigation } from "../src/core/reading.ts";
import { newUserMessage } from "../src/core/native-messages.ts";
import { coverageOf } from "../src/core/coverage.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-reading-flow-"));
process.env.LH_DATA_DIR = temp;
process.env.OPENROUTER_API_KEY = "test-key-not-used-for-network";
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { readingSourceStore } = await import("../src/store/reading-sources.ts");
const { createReadingSourceLoader } = await import("../src/server/reading-sources.ts");
const { createReadingAgent, composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { createExtractionPipeline } = await import("../src/agent/subagents/extraction.ts");
const { POST: createSession } = await import("../app/api/chats/route.ts");
after(() => fs.rmSync(temp, { recursive: true, force: true }));

function engine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const call = (name: string, input: object, id: string) => fauxAssistantMessage([fauxToolCall(name, input as Parameters<typeof fauxToolCall>[1], { id })], { stopReason: "toolUse" });
const markdown = "# Agentic iteration\n\nEstablish a fixed baseline.\n\n## Quality\n\nCheck output quality after optimizing.";
const nodes: ReadingNode[] = [
	{ id: "baseline", title: "固定基线", blockIds: ["b1", "b2"] },
	{ id: "quality", title: "检查结果质量", blockIds: ["b3", "b4"] },
];

it("persists an independent reading session, resumes a detour, and connects its insight to an existing graph node", async () => {
	const response = await createSession(new Request("http://test/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "读这篇文章", kind: "reading" }) }));
	const { id } = await response.json() as { id: string };
	assert.equal((await chatStore.getChat(id))?.kind, "reading");
	(await chatStore.saveSettings(id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } }));
	let fetches = 0;
	const loadSource = createReadingSourceLoader(readingSourceStore, { chatStore, fetch: async () => {
		fetches++;
		return new Response(markdown, { headers: { "Content-Type": "text/markdown" } });
	} });
	const turn = async (text: string | ReadingNavigation, steps: FauxResponseStep[]) => {
		const scripted = engine(steps);
		const input = typeof text === "string" ? { type: "text" as const, text } : { type: "reading" as const, ...text };
		const ack = await handleChatInput(id, input, (opts) => createReadingAgent({ chatId: id, chatStore, graphStore, loadSource }, { ...opts, engine: scripted }));
		assert.equal(ack.status, 200, await ack.clone().text());
		const handle = runningTurn(id);
		if (handle) await new Response(handle.subscribe()).text();
		assert.ok(!(await chatStore.getChat(id))!.messages.some((m) => m.role === "assistant" && m.stopReason === "error"));
	};
	await turn("带我读 https://example.test/article", [
		call("reading_load", { url: "https://example.test/article" }, "load"),
		call("reading_plan", { nodes }, "plan"),
		call("reading_focus", { action: "read", nodeId: "baseline", blockIds: ["b2"] }, "read"),
		fauxAssistantMessage("我们先读固定基线这一段。固定比较对象有助于比较性能变化。"),
	]);
	assert.equal(fetches, 1);
	assert.equal((await readingSourceStore.get(id))?.archive.kind, "web");
	const prompt = composeInstructions("reading");
	assert.match(prompt, /primarily in Chinese/);
	assert.ok(!prompt.includes("Check that the step landed"));
	const toolNames = createReadingAgent({ chatId: id, chatStore }, { engine: engine([]) }).state.tools.map((t) => t.name);
	assert.ok(!toolNames.some((name) => ["quiz", "explain", "probe_done", "ask_user_question"].includes(name)));

	const branch = { id: "measurement", title: "测量波动", parentId: "baseline", blockIds: ["b2"] };
	await turn("我发现固定比较对象很重要。但测量有波动怎么办？", [
		call("reading_plan", { nodes: [...nodes, branch] }, "branch"),
		call("reading_focus", { action: "discuss", nodeId: "measurement" }, "discuss"),
		async () => {
			const user = (await chatStore.getChat(id))!.messages.filter((m) => m.role === "user").at(-1)!;
			return call("reading_note", { id: "fixed-baseline", kind: "discovery", text: "固定比较对象很重要。", nodeId: "baseline", blockIds: ["b2"], evidence: [{ messageId: user.id, quote: "固定比较对象很重要" }], graphNodeIds: [] }, "note");
		},
		fauxAssistantMessage("我们展开测量波动这个问题，文章先停在这里。"),
	]);
	const during = readingStateOf((await chatStore.getChat(id))!.messages);
	assert.equal(during.readNodeId, "baseline");
	assert.equal(during.discussionNodeId, "measurement");
	assert.deepEqual(during.blockIds, ["b2"]);
	assert.equal(during.notes.length, 1);
	assert.match(readingSessionContext((await chatStore.getChat(id))!.messages), /fixed-baseline/);
	await turn({ action: "return" }, [call("reading_focus", { action: "return" }, "return"), fauxAssistantMessage("回到刚才固定比较对象的原文，这和我们讨论的测量方法接起来了。")]);
	assert.equal(readingStateOf((await chatStore.getChat(id))!.messages).discussionNodeId, "baseline");
	const refused = await handleChatInput(id, { type: "reading", action: "read", nodeId: "unknown" });
	assert.equal(refused.status, 400);
	await turn({ action: "read", nodeId: "quality" }, [
		call("reading_source", { blockIds: ["b3", "b4"] }, "recover-source"),
		call("reading_focus", { action: "read", nodeId: "quality" }, "read-quality"),
		call("reading_focus", { action: "finish" }, "finish"),
		fauxAssistantMessage("我们读完了文章，之前的发现和疑问都保留在阅读记录中。"),
	]);
	assert.equal(readingStateOf((await chatStore.getChat(id))!.messages).finished, true);
	assert.equal(fetches, 1, "reopening and returning use the saved source");

	// Actual extractor/auditor/merger over the real isolated stores. The
	// same proposition from an older session is reused, not copied.
	const old = (await chatStore.createChat("以前的性能笔记"));
	(await graphStore.appendNode({ id: "n_baseline", name: "固定性能基线", statement: "固定比较对象有助于比较性能变化。", aliases: [], provenance: [{ chatId: old.id, messageId: "" }], createdAt: new Date().toISOString() }));
	const evidenceId = during.notes[0]!.evidence[0]!.messageId;
	let extractionPrompt = "";
	const extractor = engine([(context) => {
		extractionPrompt = JSON.stringify(context);
		return call("submit_findings", { propositions: [{ id: "p1", name: "固定比较对象", statement: "固定比较对象有助于比较性能变化。", aliases: [], messageId: evidenceId }], chains: [] }, "findings");
	}]);
	const auditor = engine([call("submit_review", { links: [{ id: "p1", linkTo: "n_baseline" }] }, "links")]);
	const pipeline = createExtractionPipeline({ chatStore, graphStore, extractor, auditor, getChunkTokens: () => 100_000 });
	await pipeline.runExtraction(id);
	assert.match(extractionPrompt, /LEARNER/);
	assert.match(extractionPrompt, /Questions, tentative hypotheses/);
	const merged = (await graphStore.readNodes()).filter((n) => n.id === "n_baseline");
	assert.equal(new Set((await graphStore.readNodes()).map((n) => n.id)).size, 1);
	assert.ok(merged.some((n) => n.provenance.some((p) => p.chatId === id && p.messageId === evidenceId)));
	assert.ok((await graphStore.readCoverage()).length > 0);

	if (process.env.LH_READING_FIXTURE_OUTPUT) fs.writeFileSync(process.env.LH_READING_FIXTURE_OUTPUT, JSON.stringify((await chatStore.getChat(id)), null, "\t"));
});

it("coalesces an exchange arriving during extraction so the last discovery is not stranded", async () => {
	const chat = (await chatStore.createChat("连续追问", "reading"));
	(await chatStore.saveMessages(chat.id, [newUserMessage("第一个发现。")]));
	let release!: () => void;
	let started!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const entered = new Promise<void>((resolve) => { started = resolve; });
	let calls = 0;
	const pipeline = createExtractionPipeline({ chatStore, graphStore, getChunkTokens: () => 100_000,
		extractor: engine([async () => { calls++; started(); await blocked; return call("submit_findings", { propositions: [], chains: [] }, "first"); },
			() => { calls++; return call("submit_findings", { propositions: [], chains: [] }, "second"); }]),
		auditor: engine([call("submit_review", { links: [] }, "first-review"), call("submit_review", { links: [] }, "second-review")]),
	});
	const first = pipeline.runExtraction(chat.id);
	await entered;
	(await chatStore.saveMessages(chat.id, [...(await chatStore.getChat(chat.id))!.messages, newUserMessage("最后一个发现，不能丢。")]));
	await pipeline.runExtraction(chat.id);
	release();
	await first;
	for (let i = 0; i < 100 && coverageOf((await chatStore.getChat(chat.id))!.messages, (await graphStore.readCoverage()), chat.id, true).uncoveredCount; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(calls, 2);
	assert.equal(coverageOf((await chatStore.getChat(chat.id))!.messages, (await graphStore.readCoverage()), chat.id, true).uncoveredCount, 0);
});
