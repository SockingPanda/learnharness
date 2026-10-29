import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { I18nProvider, useI18n } from "../components/i18n.tsx";
import { ReadingArtifact, ReadingPanel, ReadingSource, ReadingToolbar } from "../components/reading.tsx";
import { applyReadingEvent, emptyReadingState, type ReadingArticle } from "../src/core/reading.ts";
import type { UiLocale } from "../src/core/i18n.ts";

const web: ReadingArticle = {
	url: "https://example.test/original?edition=1",
	title: "The author's original title",
	blocks: [{ id: "b1", markdown: "The author's original words.", section: "" }],
	archive: {
		kind: "web", fileName: "source.md", originalUrl: "https://example.test/original?edition=1",
		resolvedUrl: "https://example.test/redirected", sha256: "a".repeat(64), byteLength: 30,
		savedAt: "2026-10-29T00:00:00.000Z",
	},
};
const pdf: ReadingArticle = {
	url: "file:///documents/reading%20source.pdf", title: "Reading source",
	blocks: [{ id: "b1", markdown: "PDF passage stays verbatim.", section: "", page: 3 }],
	archive: {
		kind: "pdf", fileName: "source.pdf", originalPath: "/documents/reading source.pdf",
		sha256: "b".repeat(64), byteLength: 90, savedAt: "2026-10-29T00:00:00.000Z",
	},
};
const stateFor = (article: ReadingArticle) => applyReadingEvent(emptyReadingState(), { kind: "source", article });
const noAction = () => {};
const panel = (article: ReadingArticle) => <ReadingPanel state={stateFor(article)} chatId="chat_reading_source" busy={false} onClose={noAction} onAction={noAction} />;
function render(locale: UiLocale, element: React.ReactNode) {
	return renderToStaticMarkup(<I18nProvider initialLocale={locale} initialPreference={locale}>{element}</I18nProvider>);
}

describe("saved reading originals", () => {
	it("offers the saved Markdown and keeps the learner's original URL rather than the redirect", () => {
		const { document } = parseHTML(render("en", panel(web)));
		const download = document.querySelector('[data-testid="reading-source-download"]')!;
		assert.equal(download.getAttribute("href"), "/api/chats/chat_reading_source/reading-source");
		assert.equal(download.getAttribute("download"), "source.md");
		assert.equal(download.textContent, "Download original (.md)");
		const link = document.querySelector('[data-testid="reading-source-link"]')!;
		assert.equal(link.getAttribute("href"), web.archive!.originalUrl);
		assert.equal(link.textContent, web.archive!.originalUrl);
	});

	it("downloads a local PDF through the session endpoint and displays real page numbers", () => {
		const markup = render("zh-CN", panel(pdf));
		const { document } = parseHTML(markup);
		const download = document.querySelector('[data-testid="reading-source-download"]')!;
		assert.equal(download.getAttribute("download"), "source.pdf");
		assert.equal(download.textContent, "下载原文（.pdf）");
		assert.equal(document.querySelector('[data-testid="reading-source-link"]'), null);
		assert.match(markup, /本地 PDF：reading source.pdf/);
		assert.doesNotMatch(markup, /href="file:/);
		const source = parseHTML(render("zh-CN", <ReadingSource blocks={pdf.blocks} url={pdf.url} />)).document;
		assert.equal(source.querySelector('[data-reading-page="3"]')?.textContent, "第 3 页");
		assert.match(source.querySelector("#reading-source-b1")!.textContent!, /PDF passage stays verbatim\./);
		assert.equal(source.querySelector("a"), null);
	});

	it("keeps old embedded-source sessions downloadable as Markdown", () => {
		const legacy: ReadingArticle = { url: web.url, title: web.title, blocks: web.blocks };
		const { document } = parseHTML(render("zh-CN", panel(legacy)));
		assert.equal(document.querySelector('[data-testid="reading-source-download"]')?.getAttribute("download"), "source.md");
		assert.equal(document.querySelector('[data-testid="reading-source-link"]')?.getAttribute("href"), legacy.url);
		assert.equal(document.querySelector('[data-testid="reading-source-download"]')?.textContent, "下载原文（.md）");
	});

	it("keeps an unreadable PDF available without showing a route or raw parsing error", () => {
		const unreadable = { ...pdf, blocks: [], sourceIssue: "Parser error: no text at /private/internal/file.pdf" };
		const markup = render("zh-CN", panel(unreadable));
		const { document } = parseHTML(markup);
		assert.ok(document.querySelector('[data-testid="reading-source-download"]'));
		assert.equal(document.querySelector('[role="status"]')?.textContent, "原文件已保存，但暂时无法提取完整正文。你仍可以下载原文件。");
		assert.equal(document.querySelector('[data-testid="reading-diagram"]'), null);
		assert.doesNotMatch(markup, /通读文章后|Parser error|private\/internal|展开全部讨论分支/);
		const toolbar = render("en", <ReadingToolbar state={stateFor(unreadable)} busy={false} onOpen={noAction} onAction={noAction} />);
		assert.match(toolbar, /Original saved; full text unavailable/);
		assert.doesNotMatch(toolbar, /reading-continue/);
		const artifact = render("en", <ReadingArtifact part={{ type: "tool-reading_load", state: "output-available", toolCallId: "load", output: { readingEvent: { kind: "source", article: unreadable } } }} />);
		assert.match(artifact, /Original PDF saved/);
		assert.doesNotMatch(artifact, /Parser error/);
	});

	it("does not turn non-web source locations into executable or local-file links", () => {
		for (const url of ["javascript:alert(1)", "file:///tmp/source.pdf", "data:text/html,test", "not a URL"]) {
			const { document } = parseHTML(render("en", <ReadingSource blocks={web.blocks} url={url} />));
			assert.equal(document.querySelector("a"), null, url);
		}
	});
});

const dom = parseHTML("<html lang='en'><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], language: "en-US" } });
let cookie = "";
Object.defineProperty(document, "cookie", { configurable: true, get: () => cookie, set: (value: string) => { cookie = value.split(";")[0]!; } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem() {} } });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined; host?.remove(); host = undefined; cookie = "";
});
function LocaleButtons() {
	const { setPreference } = useI18n();
	return <><button id="switch-chinese" onClick={() => setPreference("zh-CN")}>Chinese</button><button id="switch-english" onClick={() => setPreference("en")}>English</button></>;
}

it("switches source controls in place while keeping the selected reading view and original link", async () => {
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => root!.render(<I18nProvider initialLocale="en" initialPreference="en"><LocaleButtons />{panel(web)}</I18nProvider>));
	const download = host.querySelector('[data-testid="reading-source-download"]')!;
	const original = host.querySelector('[data-testid="reading-source-link"]')!;
	const notesTab = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "My notes · 0")!;
	await act(async () => notesTab.dispatchEvent(new Event("click", { bubbles: true })));
	await act(async () => host!.querySelector("#switch-chinese")!.dispatchEvent(new Event("click", { bubbles: true })));
	assert.equal(host.querySelector('[data-testid="reading-source-download"]'), download);
	assert.equal(download.textContent, "下载原文（.md）");
	assert.equal(notesTab.getAttribute("aria-pressed"), "true");
	assert.equal(notesTab.textContent, "我的记录 · 0");
	assert.equal(original.getAttribute("href"), web.archive!.originalUrl);
	await act(async () => host!.querySelector("#switch-english")!.dispatchEvent(new Event("click", { bubbles: true })));
	assert.equal(download.textContent, "Download original (.md)");
	assert.equal(notesTab.getAttribute("aria-pressed"), "true");
	assert.equal(download.getAttribute("download"), "source.md");
});
