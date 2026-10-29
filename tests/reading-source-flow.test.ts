/** Original-source persistence through the real loader, filesystem and route.
 * All web responses are local fixtures; no network or model calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { readingArticle, type ReadingArticle } from "../src/core/reading.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-reading-source-flow-"));
process.env.LH_DATA_DIR = temp;
const { stores } = await import("../src/server/stores.ts");
const { createReadingSourceLoader } = await import("../src/server/reading-sources.ts");
const { getReadingSourceDownload } = await import("../src/server/reading-source-download.ts");
const { GET } = await import("../app/api/chats/[id]/reading-source/route.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const { createReadingSourceStore } = await import("../src/store/reading-sources.ts");
const { chatStore, readingSourceStore } = stores;
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const pdfBytes = fs.readFileSync(new URL("./fixtures/sample-3page.pdf", import.meta.url));
const markdown = "# Archived source\n\nThe complete original explanation remains readable after the website changes.\n\n```ts\nconst original = true;\n```\n";
const noFetch: typeof fetch = async () => { throw new Error("Unexpected network access"); };
const create = () => chatStore.createChat("Article source", "reading");
const loader = (fetch: typeof globalThis.fetch) => createReadingSourceLoader(readingSourceStore, { chatStore, fetch });

function persistArticle(chatId: string, article: ReadingArticle): void {
	chatStore.saveMessages(chatId, [{
		id: "source-event", role: "toolResult", toolCallId: "load-source", toolName: "reading_load",
		content: [{ type: "text", text: "Source saved" }], details: { readingEvent: { kind: "source", article } },
		isError: false, timestamp: 1,
	} as unknown as LhMessage]);
}

function response(content: string | Uint8Array, type: string, url?: string): Response {
	const result = new Response(typeof content === "string" ? content : new Uint8Array(content), { headers: { "content-type": type } });
	if (url) Object.defineProperty(result, "url", { value: url });
	return result;
}

/** Tiny real PDF with one optionally text-bearing page and one image-only
 * page, ensuring a partial text layer is not mistaken for the whole source. */
function scanPdf(withText: boolean): Uint8Array {
	const streams = withText ? ["BT /F1 12 Tf 72 720 Td (Readable opening) Tj ET", "q 200 0 0 200 72 500 cm /Scan Do Q"] : ["q 200 0 0 200 72 500 cm /Scan Do Q"];
	const objects: string[] = [];
	const pages = streams.map((_, i) => 3 + i * 2);
	const font = 3 + streams.length * 2;
	const image = font + 1;
	objects[1] = "<</Type/Catalog/Pages 2 0 R>>";
	objects[2] = `<</Type/Pages/Kids[${pages.map((id) => `${id} 0 R`).join(" ")}]/Count ${streams.length}>>`;
	streams.forEach((stream, i) => {
		objects[pages[i]!] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${pages[i]! + 1} 0 R/Resources<</Font<</F1 ${font} 0 R>>/XObject<</Scan ${image} 0 R>>>>>>`;
		objects[pages[i]! + 1] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
	});
	objects[font] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
	objects[image] = "<</Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/ASCIIHexDecode/Length 7>>\nstream\n000000>\nendstream";
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let i = 1; i < objects.length; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let i = 1; i < objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<</Size ${objects.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}

it("archives web Markdown with the original link and recovers it without fetching again", async () => {
	const chat = create();
	const url = "https://example.test/original?language=zh&ref=reading";
	const finalUrl = "https://example.test/current/article";
	let fetches = 0;
	const load = loader(async () => { fetches++; return response(markdown, "text/markdown", finalUrl); });
	const article = await load(chat.id, { url });
	persistArticle(chat.id, article);
	assert.equal(article.archive?.kind, "web");
	assert.equal(article.archive?.originalUrl, url);
	assert.equal(article.archive?.resolvedUrl, finalUrl);
	const artifact = fs.readFileSync(path.join(temp, "reading-sources", chat.id, "source.md"), "utf8");
	assert.ok(artifact.includes(`source_url: ${JSON.stringify(url)}`));
	assert.ok(artifact.includes(markdown.trim()));
	const reopened = createReadingSourceLoader(createReadingSourceStore(path.join(temp, "reading-sources")), { chatStore, fetch: noFetch });
	assert.deepEqual(await reopened(chat.id, { url }), article);
	assert.equal(fetches, 1);
	await assert.rejects(load(chat.id, { url: "https://example.test/different" }), /another|different|already|new reading/i);
	assert.equal(fetches, 1, "a different source cannot overwrite the archive");
});

it("archives extracted HTML Markdown and resolves relative source links", async () => {
	const chat = create();
	const prose = "This paragraph explains why a complete original is useful for revisiting a reading session. ".repeat(6);
	const html = `<html><head><title>Original HTML</title></head><body><article><h1>Original HTML</h1><p>${prose}</p><p><a href="../evidence">Evidence</a></p><pre><code>const source = true;</code></pre></article></body></html>`;
	const article = await loader(async () => response(html, "text/html", "https://example.test/articles/current"))(chat.id, { url: "https://example.test/start" });
	const saved = new TextDecoder().decode(readingSourceStore.get(chat.id)!.content);
	assert.match(saved, /# Original HTML/);
	assert.match(saved, /https:\/\/example\.test\/evidence/);
	assert.match(saved, /const source = true;/);
	assert.equal(article.archive?.originalUrl, "https://example.test/start");
	assert.ok(!saved.includes("<article>"));
});

it("keeps downloaded PDF bytes intact while giving the guide real page anchors", async () => {
	const chat = create();
	const article = await loader(async () => response(pdfBytes, "application/pdf"))(chat.id, { url: "https://example.test/paper" });
	persistArticle(chat.id, article);
	assert.equal(article.archive?.kind, "pdf");
	assert.deepEqual(Buffer.from(readingSourceStore.get(chat.id)!.content), pdfBytes);
	assert.deepEqual([...new Set(article.blocks.map((block) => block.page))], [1, 2, 3]);
	assert.match(article.blocks.map((block) => block.markdown).join("\n"), /Calculus/);
	assert.equal(article.sourceIssue, undefined);
	assert.deepEqual(await loader(noFetch)(chat.id, { url: "https://example.test/paper" }), article);
});

it("copies a local PDF so reopening does not depend on the original file", async () => {
	const chat = create();
	const original = path.join(temp, "Original paper.pdf");
	fs.writeFileSync(original, pdfBytes);
	const article = await loader(noFetch)(chat.id, { path: original });
	persistArticle(chat.id, article);
	assert.equal(article.archive?.originalPath, original);
	fs.unlinkSync(original);
	assert.deepEqual(await loader(noFetch)(chat.id, { path: original }), article);
	assert.deepEqual(Buffer.from(readingSourceStore.get(chat.id)!.content), pdfBytes);
});

it("retains scan-only and partial-text PDFs without manufacturing a complete reading", async () => {
	for (const withText of [false, true]) {
		const chat = create();
		const bytes = scanPdf(withText);
		const article = await loader(async () => response(bytes, "application/pdf"))(chat.id, { url: `https://example.test/scan-${withText}.pdf` });
		assert.ok(article.sourceIssue, "the guide receives a reason the text is unavailable");
		assert.deepEqual(article.blocks, [], "page headings or partial text cannot count as the full article");
		assert.deepEqual(new Uint8Array(readingSourceStore.get(chat.id)!.content), bytes);
	}
});

it("rejects unsupported URL protocols before fetching or saving", async () => {
	const chat = create();
	for (const url of ["file:///etc/passwd", "data:text/plain,not-an-article", "ftp://example.test/paper.pdf"]) {
		await assert.rejects(loader(noFetch)(chat.id, { url }), /http|protocol|URL/i);
	}
	assert.equal(readingSourceStore.get(chat.id), null);
});

it("bounds actual streamed response bytes even when Content-Length is absent", async () => {
	const chat = create();
	let sent = 0;
	let cancelled = false;
	const chunk = new Uint8Array(1024 * 1024);
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) { if (sent++ < 27) controller.enqueue(chunk); else controller.close(); },
		cancel() { cancelled = true; },
	});
	const fetch: typeof globalThis.fetch = async () => new Response(stream, { headers: { "content-type": "application/pdf" } });
	await assert.rejects(loader(fetch)(chat.id, { url: "https://example.test/oversized.pdf" }), /large|limit|size/i);
	assert.equal(readingSourceStore.get(chat.id), null);
	assert.ok(cancelled, "stop consuming the oversized response");
});

it("does not publish a source when its response is cancelled", async () => {
	const chat = create();
	const controller = new AbortController();
	const reason = new Error("Cancelled source load");
	const fetch: typeof globalThis.fetch = async () => {
		controller.abort(reason);
		return response(markdown, "text/markdown");
	};
	await assert.rejects(loader(fetch)(chat.id, { url: "https://example.test/cancelled" }, controller.signal), (error) => error === reason);
	assert.equal(readingSourceStore.get(chat.id), null);
});

it("cancels the reader fallback when the original source load is cancelled", async () => {
	const chat = create();
	const controller = new AbortController();
	const reason = new Error("Cancelled during reader fallback");
	const realFetch = globalThis.fetch;
	let fallbackSignal: AbortSignal | null = null;
	let fallbackCalls = 0;
	globalThis.fetch = (async (url, init) => {
		fallbackCalls++;
		assert.equal(String(url), "https://r.jina.ai/https://example.test/scripted-page");
		fallbackSignal = init?.signal ?? null;
		return new Promise<Response>((_resolve, reject) => {
			fallbackSignal?.addEventListener("abort", () => reject(fallbackSignal!.reason), { once: true });
			setImmediate(() => {
				controller.abort(reason);
				if (!fallbackSignal?.aborted) reject(new Error("Reader fallback ignored cancellation"));
			});
		});
	}) as typeof fetch;
	try {
		const fetch: typeof globalThis.fetch = async () => response("<html><body><div id=app></div></body></html>", "text/html");
		await assert.rejects(loader(fetch)(chat.id, { url: "https://example.test/scripted-page" }, controller.signal), (error) => error === reason);
		assert.equal(fallbackCalls, 1);
		assert.equal(readingSourceStore.get(chat.id), null);
	} finally { globalThis.fetch = realFetch; }
});

it("downloads the archived original using safe format-specific headers", async () => {
	for (const pdf of [false, true]) {
		const chat = chatStore.createChat('Unsafe title "\r\nX-Injected: yes', "reading");
		const article = await loader(async () => response(pdf ? pdfBytes : markdown, pdf ? "application/pdf" : "text/markdown"))(chat.id, { url: "https://example.test/source" });
		persistArticle(chat.id, article);
		const download = await GET(new Request("http://localhost/api/source"), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(download.status, 200);
		assert.equal(download.headers.get("content-type"), pdf ? "application/pdf" : "text/markdown; charset=utf-8");
		assert.match(download.headers.get("content-disposition") ?? "", pdf ? /^attachment;.*\.pdf/ : /^attachment;.*\.md/);
		assert.equal(download.headers.get("x-injected"), null);
		assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(readingSourceStore.get(chat.id)!.content));
	}
});

it("backfills old web sources from the saved snapshot without revisiting the website", async () => {
	const chat = create();
	const url = "https://example.test/old-source";
	const article = readingArticle(url, markdown);
	persistArticle(chat.id, article);
	const realFetch = globalThis.fetch;
	globalThis.fetch = noFetch;
	try {
		const download = await getReadingSourceDownload(chat.id);
		assert.equal(download.status, 200);
		const text = await download.text();
		assert.ok(text.includes(url));
		for (const block of article.blocks) assert.ok(text.includes(block.markdown));
		assert.equal(readingSourceStore.get(chat.id)?.archive.kind, "web");
		assert.deepEqual(chatStore.getChat(chat.id)!.messages[0], {
			id: "source-event", role: "toolResult", toolCallId: "load-source", toolName: "reading_load",
			content: [{ type: "text", text: "Source saved" }], details: { readingEvent: { kind: "source", article } },
			isError: false, timestamp: 1,
		}, "downloading does not rewrite source anchors or the old transcript");
	} finally { globalThis.fetch = realFetch; }
});

it("refuses downloads when the transcript refers to a different original or archive hash", async () => {
	for (const mismatch of ["url", "hash"] as const) {
		const chat = create();
		const article = await loader(async () => response(markdown, "text/markdown"))(chat.id, { url: "https://example.test/archived-original" });
		const changed: ReadingArticle = mismatch === "url"
			? { ...article, url: "https://example.test/different-original" }
			: { ...article, archive: { ...article.archive!, sha256: "0".repeat(64) } };
		persistArticle(chat.id, changed);
		const result = await GET(new Request("http://localhost/api/source"), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(result.status, 409, `${mismatch} mismatch must not return unrelated source bytes`);
		assert.match(result.headers.get("content-type") ?? "", /application\/json/);
		assert.equal(result.headers.get("content-disposition"), null);
		assert.equal(readingSourceStore.get(chat.id)!.archive.sha256, article.archive!.sha256, "a rejected download preserves the archived original");
	}
});

it("returns 404 for unknown sessions or sessions without a source", async () => {
	assert.equal((await getReadingSourceDownload("chat_unknown_source")).status, 404);
	assert.equal((await getReadingSourceDownload(create().id)).status, 404);
});

it("deleting a reading session removes its archived original and leaves other archives intact", async () => {
	const first = create();
	const second = create();
	const load = loader(async () => response(markdown, "text/markdown"));
	persistArticle(first.id, await load(first.id, { url: "https://example.test/first" }));
	persistArticle(second.id, await load(second.id, { url: "https://example.test/second" }));
	const result = await deleteChatSession(first.id, "preserve-graph");
	assert.equal(result.ok, true);
	assert.equal(readingSourceStore.get(first.id), null);
	assert.equal((await getReadingSourceDownload(first.id)).status, 404);
	assert.ok(readingSourceStore.get(second.id));
});
