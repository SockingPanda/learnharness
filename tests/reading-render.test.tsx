import assert from "node:assert/strict";
import { it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadingDiagram, ReadingSource, ReadingToolbar, ReadingPanel } from "../components/reading.tsx";
import { applyReadingEvent, emptyReadingState, readingArticle } from "../src/core/reading.ts";

const article = readingArticle("https://example.test/article", "# Title\n\nOriginal paragraph.");
const state = applyReadingEvent(applyReadingEvent(emptyReadingState(), { kind: "source", article }), { kind: "plan", nodes: [
	{ id: "main", title: "文章主线", blockIds: ["b1", "b2"] },
	{ id: "branch", title: "当前追问", blockIds: ["b2"], parentId: "main" },
	{ id: "earlier", title: "以前的分支", blockIds: ["b2"], parentId: "main" },
] });
const detour = applyReadingEvent(state, { kind: "focus", action: "discuss", nodeId: "branch" });

it("shows the article bookmark and active discussion together, with collapsed original and persistent chat actions", () => {
	const toolbar = renderToStaticMarkup(<ReadingToolbar state={detour} busy={false} onOpen={() => {}} onAction={() => {}} />);
	assert.match(toolbar, /文章书签：文章主线/);
	assert.match(toolbar, /正在展开：当前追问/);
	assert.match(toolbar, /回到文章/);
	assert.match(toolbar, /继续读/);
	const source = renderToStaticMarkup(<ReadingSource blocks={article.blocks} url={article.url} />);
	assert.match(source, /Original paragraph/);
	assert.ok(!source.includes(" open="));
	const diagram = renderToStaticMarkup(<ReadingDiagram state={detour} showBranches={false} onSelect={() => {}} />);
	assert.match(diagram, /reading-bookmark/);
	assert.match(diagram, /stroke-dasharray="5 4"/);
	assert.match(diagram, /plan-node-branch/);
	assert.ok(!diagram.includes("plan-node-earlier"));
	const expanded = renderToStaticMarkup(<ReadingDiagram state={detour} showBranches onSelect={() => {}} />);
	assert.match(expanded, /plan-node-earlier/);
	const panel = renderToStaticMarkup(<ReadingPanel state={detour} chatId="chat_1" busy={false} onClose={() => {}} onAction={() => {}} />);
	assert.match(panel, /role="dialog"/);
	assert.match(panel, /知识连接/);
	assert.match(panel, /当前追问/);
});
