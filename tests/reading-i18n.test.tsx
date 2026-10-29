import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { I18nProvider } from "../components/i18n.tsx";
import { ReadingArtifact, ReadingPanel, ReadingSource, ReadingToolbar } from "../components/reading.tsx";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import { SessionRow } from "../components/sidebar.tsx";
import { readOpeningPrompt } from "../components/opening-prompt.ts";
import { applyReadingEvent, emptyReadingState, readingArticle, type ReadingNote } from "../src/core/reading.ts";
import type { UiLocale } from "../src/core/i18n.ts";
import type { ChatListItem } from "../src/core/contracts/chat.ts";

// Content deliberately matches known interface keys: it must not be translated
// merely because the guide or learner used the same words as a button.
const article = readingArticle("https://example.test/original", "# Settings\n\nContinue reading");
const note: ReadingNote = {
	id: "my-discovery", kind: "discovery", text: "Settings", nodeId: "question",
	blockIds: ["b2"], graphNodeIds: [], evidence: [{ messageId: "learner-word", quote: "My original words" }],
};
const plan = applyReadingEvent(applyReadingEvent(emptyReadingState(), { kind: "source", article }), { kind: "plan", nodes: [
	{ id: "article", title: "Settings", blockIds: ["b1", "b2"] },
	{ id: "question", title: "保留我的追问", summary: "Model-authored summary stays English.", blockIds: ["b2"], parentId: "article" },
] });
const state = applyReadingEvent(applyReadingEvent(plan, { kind: "focus", action: "discuss", nodeId: "question" }), { kind: "note", note });

function render(locale: UiLocale, content: React.ReactNode) {
	return renderToStaticMarkup(<I18nProvider initialLocale={locale} initialPreference={locale}>{content}</I18nProvider>);
}

describe("guided reading with interface localization", () => {
	it("renders the reading draft in both interface languages and keeps the unsent input intact", () => {
		const draft = <DraftShell mode="reading" busy={false} text="Settings" onChange={() => {}} onSend={() => {}} />;
		const english = render("en", draft);
		assert.match(english, /Read an article together/);
		assert.match(english, /Paste an article link and tell me what you want to focus on…/);
		assert.match(english, /start guided reading in Chinese/);
		const chinese = render("zh-CN", draft);
		assert.match(chinese, /一起读一篇文章/);
		assert.match(chinese, /贴上文章链接，也可以说说你想重点读什么……/);
		for (const html of [english, chinese]) {
			assert.equal(parseHTML(html).document.querySelector('[role="textbox"]')?.textContent, "Settings");
		}
	});

	it("labels reading sessions in the sidebar without translating a user-authored session title", () => {
		const chat: ChatListItem = {
			id: "reading-session", kind: "reading", title: "Settings", phase: "teach",
			createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
			messageCount: 2, pendingQuestion: false, pendingProblem: false, busy: false, compacting: false,
		};
		const row = <SessionRow chat={chat} active onOpen={() => {}} />;
		const english = render("en", row);
		assert.match(english, /aria-label="Guided reading session"/);
		const chinese = render("zh-CN", row);
		assert.match(chinese, /aria-label="带读会话"/);
		for (const html of [english, chinese]) {
			assert.equal(parseHTML(html).document.querySelector(".font-prose")?.textContent, "Settings");
		}
	});

	it("creates a reading session with the original prompt and stable reading protocol kind", async () => {
		const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
		const storage = new Map<string, string>();
		Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => { storage.set(key, value); },
			removeItem: (key: string) => { storage.delete(key); },
		} });
		try {
			const calls: unknown[] = [];
			const request = (async (url: string, options: RequestInit) => {
				assert.equal(url, "/api/chats");
				assert.equal(options.method, "POST");
				calls.push(JSON.parse(String(options.body)));
				return Response.json({ id: "reading_i18n" });
			}) as typeof fetch;
			const prompt = "https://example.test/article 带我读这篇文章";
			assert.equal(await startDraftSession(prompt, request, "reading"), "/chat/reading_i18n");
			assert.deepEqual(calls, [{ title: prompt, kind: "reading" }]);
			assert.equal(readOpeningPrompt("reading_i18n"), prompt);
		} finally {
			if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
			else Reflect.deleteProperty(globalThis, "sessionStorage");
		}
	});

	it("localizes the two positions and controls while preserving the article bookmark and active detour", () => {
		const before = JSON.stringify(state);
		const toolbar = <ReadingToolbar state={state} busy={false} onOpen={() => {}} onAction={() => {}} />;
		const english = render("en", toolbar);
		assert.match(english, /Article bookmark: Settings/);
		assert.match(english, /Exploring: 保留我的追问/);
		assert.match(english, /Return to article/);
		assert.match(english, /Continue reading/);
		assert.match(english, /Route and notes · 1/);
		const chinese = render("zh-CN", toolbar);
		assert.match(chinese, /文章书签：Settings/);
		assert.match(chinese, /正在展开：保留我的追问/);
		assert.match(chinese, /回到文章/);
		assert.match(chinese, /继续读/);
		assert.match(chinese, /路线与记录 · 1/);
		assert.equal(JSON.stringify(state), before, "rendering another locale must not change reading progress or evidence");
	});

	it("localizes source disclosure and count grammar without translating or opening the original", () => {
		const english = render("en", <ReadingSource blocks={article.blocks} url={article.url} />);
		assert.match(english, /View original · 2 passages/);
		const single = render("en", <ReadingSource blocks={article.blocks.slice(1)} />);
		assert.match(single, /View original · 1 passage</);
		const chinese = render("zh-CN", <ReadingSource blocks={article.blocks} url={article.url} />);
		const { document } = parseHTML(chinese);
		assert.equal(document.querySelector("summary")?.textContent, "查看对应原文 · 2 段");
		assert.equal(document.querySelector("details")?.hasAttribute("open"), false);
		assert.equal(document.querySelector("#reading-source-b1")?.textContent, "Settings");
		assert.equal(document.querySelector("#reading-source-b2")?.textContent, "Continue reading");
		assert.equal(document.querySelector("a")?.getAttribute("href"), article.url);
	});

	it("localizes panel labels while keeping note text, quoted evidence, source links and model summaries intact", () => {
		const panel = <ReadingPanel state={state} chatId="reading-session" busy={false} onClose={() => {}} onAction={() => {}} />;
		const english = render("en", panel);
		assert.match(english, /aria-label="Reading route and notes"/);
		assert.match(english, /Knowledge connections/);
		assert.match(english, /Explore this question further/);
		const chinese = render("zh-CN", panel);
		const { document } = parseHTML(chinese);
		assert.equal(document.querySelector('[data-testid="reading-panel"]')?.getAttribute("aria-label"), "阅读路线与记录");
		assert.match(chinese, /知识连接/);
		assert.match(chinese, /继续展开这个问题/);
		assert.match(chinese, /Model-authored summary stays English\./);
		assert.equal(document.querySelector('[data-testid="reading-note"] p')?.textContent, note.text);
		const quote = document.querySelector('[data-testid="reading-note"] details a');
		assert.equal(quote?.textContent, "“My original words”");
		assert.match(quote?.getAttribute("href") ?? "", /^\/chat\/reading-session#/);
	});

	it("localizes saved-note labels and completed-reading controls without replacing learner content", () => {
		const saved = <ReadingArtifact part={{ type: "tool-reading_note", state: "output-available", toolCallId: "save-note", resultMessageId: "saved-result", output: { readingEvent: { kind: "note", note } } }} />;
		const english = render("en", saved);
		assert.match(english, /My discovery/);
		const chinese = render("zh-CN", saved);
		assert.match(chinese, /我的发现/);
		const { document } = parseHTML(chinese);
		assert.equal(document.querySelector('[data-testid="reading-saved-note"]')?.textContent, "我的发现Settings");
		const complete = render("en", <ReadingToolbar state={{ ...state, finished: true }} busy onOpen={() => {}} onAction={() => {}} />);
		assert.match(complete, /Review what you learned/);
		assert.match(complete, /Finished reading; keep discussing or revisit the article/);
		assert.doesNotMatch(complete, /Skip this section/);
		assert.match(complete, /data-testid="reading-continue"[^>]*disabled=""|disabled=""[^>]*data-testid="reading-continue"/);
	});
});
