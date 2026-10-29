import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyReadingEvent, emptyReadingState, readingArticle, readingPlanProblems,
	readingFocusProblems, readingNoteProblems, readingStateOf, readingSessionContext, readingNodeHistory,
	type ReadingEvent, type ReadingNote, type ReadingNode,
} from "../src/core/reading.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import { coverageOf } from "../src/core/coverage.ts";
import { buildCompactionPrompt } from "../src/core/compaction.ts";
import { inputAppends, parseChatInput } from "../src/core/input-events.ts";
import { nativeInputCause } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { readFileSync } from "node:fs";
import { CURRENT_CHAT_VERSION, type ChatRecord } from "../src/core/contracts/chat.ts";

const article = readingArticle("https://example.test/article", "# Iteration\n\nEstablish a baseline.\n\n## Quality\n\nValidate the output.");
const nodes: ReadingNode[] = [
	{ id: "baseline", title: "固定基线", blockIds: ["b1", "b2"] },
	{ id: "quality", title: "结果质量", blockIds: ["b3", "b4"] },
];
const branch = { id: "noise", title: "测量波动", parentId: "baseline", blockIds: ["b2"] };
const seeded = () => applyReadingEvent(applyReadingEvent(emptyReadingState(), { kind: "source", article }), { kind: "plan", nodes });

function eventMessage(event: ReadingEvent, id: string): LhMessage {
	return { id, role: "toolResult", toolCallId: `call_${id}`, toolName: `reading_${event.kind === "source" ? "load" : event.kind}`, content: [{ type: "text", text: "Saved" }], details: { readingEvent: event }, isError: false, timestamp: 1 } as LhMessage;
}

describe("article-grounded reading state", () => {
	it("reopens the production-written v2 fixture with its route, personal evidence and navigation intact", () => {
		const record = JSON.parse(readFileSync(new URL("./fixtures/reading-session.json", import.meta.url), "utf8")) as ChatRecord;
		assert.equal(record.version, CURRENT_CHAT_VERSION);
		const state = readingStateOf(record.messages);
		assert.equal(state.finished, true);
		assert.ok(state.nodes.some((n) => n.parentId));
		assert.equal(state.notes.length, 1);
		const branch = state.nodes.find((n) => n.parentId)!;
		assert.ok(readingNodeHistory(record.messages, branch.id).some((m) => m.role === "user" && m.text.includes("测量有波动")));
		assert.deepEqual(readingNoteProblems(state, state.notes[0]!, record.messages, new Set()), []);
		assert.ok(projectView(record.messages).some((m) => m.parts.some((p) => p.type === "data-reading-navigation")));
	});
	it("keeps blank lines and heading-like text inside code in one exact source block", () => {
		const code = "````md\n# Not a section\n\n```\ncontent\n```\n````";
		const source = readingArticle(article.url, `# Title\n\n${code}\n\nAfterwards.`);
		assert.equal(source.blocks[1]!.markdown, code);
		assert.equal(source.blocks[2]!.section, "Title");
		assert.deepEqual(source.blocks.map((b) => b.id), ["b1", "b2", "b3"]);
	});

	it("rejects omitted/reordered source blocks and discussion cycles without changing the route", () => {
		const state = seeded();
		assert.deepEqual(readingPlanProblems(state, [...nodes, branch]), []);
		assert.match(readingPlanProblems(state, [nodes[0]!]).join(" "), /every source block/);
		assert.match(readingPlanProblems(state, [...nodes].reverse()).join(" "), /source order/);
		assert.match(readingPlanProblems(state, [...nodes, { ...branch, parentId: "noise" }]).join(" "), /cycle/);
		assert.deepEqual(state.nodes, nodes);
	});

	it("preserves the exact article bookmark across nested discussions, return, reload and a compaction marker", () => {
		const nested = { id: "project", title: "用到自己的项目", parentId: "noise", blockIds: ["b2"] };
		const log = [
			eventMessage({ kind: "source", article }, "source"),
			eventMessage({ kind: "plan", nodes: [...nodes, branch, nested] }, "route"),
			eventMessage({ kind: "focus", action: "read", nodeId: "baseline", blockIds: ["b2"] }, "position"),
			eventMessage({ kind: "focus", action: "discuss", nodeId: "noise" }, "detour"),
			eventMessage({ kind: "focus", action: "discuss", nodeId: "project" }, "nested"),
		];
		const before = readingStateOf(log);
		assert.equal(before.readNodeId, "baseline");
		assert.equal(before.discussionNodeId, "project");
		assert.deepEqual(before.blockIds, ["b2"]);
		assert.ok(!before.visited.includes("quality"));
		const compacted = { role: "custom", id: "summary", customType: "compaction", content: "Earlier discussion summarized", details: {}, timestamp: 1 } as LhMessage;
		const returned = readingStateOf(JSON.parse(JSON.stringify([...log, compacted, eventMessage({ kind: "focus", action: "return" }, "return")])));
		assert.equal(returned.discussionNodeId, "baseline");
		assert.deepEqual(returned.blockIds, ["b2"]);
		assert.equal(returned.nodes.length, 4);
		assert.match(readingSessionContext(log), /project/);
		assert.match(readingPlanProblems(before, nodes).join(" "), /Keep.*noise/);
	});

	it("records skips separately and prevents finishing at an earlier node", () => {
		const state = seeded();
		assert.match(readingFocusProblems(state, { kind: "focus", action: "finish" }).join(" "), /last reading node/);
		const skipped = applyReadingEvent(state, { kind: "focus", action: "skip", nodeId: "quality" });
		assert.deepEqual(skipped.skipped, ["baseline"]);
		assert.equal(skipped.readNodeId, "quality");
		assert.equal(skipped.finished, false);
		assert.ok(readingFocusProblems(state, { kind: "focus", action: "read", nodeId: "unknown" }).length);
	});

	it("personal records require the learner's actual words, valid source anchors and real knowledge ids", () => {
		const user = newUserMessage("我发现固定比较对象很重要。");
		const note: ReadingNote = { id: "baseline-insight", kind: "discovery", text: "固定比较对象很重要。", nodeId: "baseline", blockIds: ["b2"], evidence: [{ messageId: user.id, quote: "固定比较对象很重要" }], graphNodeIds: ["n_old"] };
		assert.deepEqual(readingNoteProblems(seeded(), note, [user], new Set(["n_old"])), []);
		assert.match(readingNoteProblems(seeded(), { ...note, evidence: [{ messageId: user.id, quote: "我已经掌握了" }] }, [user], new Set(["n_old"])).join(" "), /verbatim/);
		assert.match(readingNoteProblems(seeded(), { ...note, evidence: [] }, [user], new Set(["n_old"])).join(" "), /own words/);
		assert.match(readingNoteProblems(seeded(), note, [user], new Set()).join(" "), /must exist/);
		assert.match(readingNoteProblems(seeded(), { ...note, blockIds: ["missing"] }, [user], new Set(["n_old"])).join(" "), /Anchor/);
		const once = applyReadingEvent(seeded(), { kind: "note", note });
		const revised = applyReadingEvent(once, { kind: "note", note: { ...note, text: "修订后的理解" } });
		assert.equal(revised.notes.length, 1);
		assert.equal(once.notes[0]!.text, note.text);
	});

	it("reading coverage includes learner discoveries but does not ingest the unread source or change teaching coverage", () => {
		const user = newUserMessage("固定比较对象有助于比较性能。");
		const log = [eventMessage({ kind: "source", article }, "source"), user];
		assert.equal(coverageOf(log, [], "reading", true).uncoveredCount, 1);
		assert.equal(coverageOf(log, [], "teaching").uncoveredCount, 0);
		const prompt = buildCompactionPrompt({ kind: "reading", spanText: "learner's insight", planTreeText: null });
		assert.match(prompt, /bookmark/);
		assert.match(prompt, /Never infer mastery/);
	});

	it("navigation validates exact targets, remains explicit learner input and renders a human label", () => {
		const log = [eventMessage({ kind: "source", article }, "source"), eventMessage({ kind: "plan", nodes }, "plan")];
		const navigation = parseChatInput({ type: "reading", action: "read", nodeId: "quality" });
		const [marker] = inputAppends({ kind: "reading", messages: log }, navigation);
		assert.ok(marker);
		assert.equal(nativeInputCause(marker, []), "learner");
		const part = projectView([marker])[0]!.parts[0]!;
		assert.equal((part.data as { label: string }).label, "从「结果质量」开始读");
		assert.throws(() => inputAppends({ kind: "teach", messages: log }, navigation), /requires a reading session/);
		assert.throws(() => inputAppends({ kind: "reading", messages: log }, { type: "reading", action: "read", nodeId: "missing" }), /no matching/);
		assert.throws(() => parseChatInput({ type: "reading", action: "read" }), /nodeId/);
	});
});
