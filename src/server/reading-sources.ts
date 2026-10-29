/** Original-source acquisition. The archive holds bytes; the chat keeps
 * stable citation blocks and the reading route. No model chooses the format. */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ChatStore, ReadingSourceStore } from "../core/ports.ts";
import { readingArticle, readingStateOf, type ReadingArchive, type ReadingArticle, type ReadingSourceInput, type ReadingSourceLoader } from "../core/reading.ts";
import { extractWebResponse } from "../agent/tools/web.ts";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";
import { pdfReadingPages } from "../agent/subagents/pdf-ops.ts";

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_WEB_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const TIMEOUT_MS = 30_000;

function sourceInput(input: ReadingSourceInput): { url?: string; filePath?: string; location: string } {
	if (Boolean(input.url) === Boolean(input.path)) throw new Error("Provide exactly one article/PDF URL or local PDF path.");
	if (input.url) {
		const parsed = new URL(input.url);
		if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Use an http(s) URL, or the path field for a local PDF.");
		return { url: input.url, location: parsed.href };
	}
	const filePath = resolveSourcePath(input.path!);
	return { filePath, location: pathToFileURL(filePath).href };
}

function sameOrigin(archive: ReadingArchive, source: ReturnType<typeof sourceInput>): boolean {
	return source.url ? Boolean(archive.originalUrl && new URL(archive.originalUrl).href === source.location)
		: archive.originalPath === source.filePath;
}

function webPrefix(url: string): string {
	return `---\nsource_url: ${JSON.stringify(url)}\n---\n\n`;
}

function sourceMarkdown(raw: string): string {
	return raw.replace(/^Source: .+\n\n/, "").replace(/\n\nSource: .+\n\n---\n\n/, "\n\n");
}

/** Backfill old sessions from their saved text, never from a changed website. */
export async function archiveReadingSnapshot(store: ReadingSourceStore, chatId: string, article: ReadingArticle): Promise<ReadingArchive> {
	const existing = await store.get(chatId);
	if (existing) {
		const expected = new URL(article.url).href;
		const actual = existing.archive.originalUrl ? new URL(existing.archive.originalUrl).href : pathToFileURL(existing.archive.originalPath!).href;
		if (expected !== actual || (article.archive && article.archive.sha256 !== existing.archive.sha256)) throw new Error("The saved source does not match this reading session.");
		return existing.archive;
	}
	if (article.archive) throw new Error("The saved original file is missing. Restore it from a backup; it will not be silently downloaded again.");
	const url = new URL(article.url);
	if (!["http:", "https:"].includes(url.protocol) || !article.blocks.length) throw new Error("This session has no original source to archive.");
	return store.save(chatId, { kind: "web", originalUrl: article.url,
		content: Buffer.from(webPrefix(article.url) + article.blocks.map((b) => b.markdown).join("\n\n"), "utf8") });
}

async function responseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > MAX_PDF_BYTES) {
		await response.body?.cancel();
		throw new Error("Source too large (over 25 MB).");
	}
	if (!response.body) throw new Error("The source response is empty.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	const cancel = () => { void reader.cancel().catch(() => {}); };
	signal.addEventListener("abort", cancel, { once: true });
	try {
		while (true) {
			signal.throwIfAborted();
			const part = await reader.read();
			signal.throwIfAborted();
			if (part.done) break;
			length += part.value.byteLength;
			if (length > MAX_PDF_BYTES) throw new Error("Source too large (over 25 MB).");
			chunks.push(part.value);
		}
		return Buffer.concat(chunks, length);
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function localPdfBytes(filePath: string, signal?: AbortSignal): Promise<Uint8Array> {
	const file = await fs.open(filePath, "r");
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error("Choose a PDF file, not a directory.");
		if (stat.size > MAX_PDF_BYTES) throw new Error("PDF too large (over 25 MB).");
		const chunks: Buffer[] = [];
		let length = 0;
		for await (const chunk of file.createReadStream({ signal, autoClose: false })) {
			length += (chunk as Buffer).length;
			if (length > MAX_PDF_BYTES) throw new Error("PDF too large (over 25 MB).");
			chunks.push(chunk as Buffer);
		}
		return Buffer.concat(chunks, length);
	} finally { await file.close(); }
}

function isPdf(bytes: Uint8Array): boolean {
	return Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"));
}

function pdfTitle(archive: ReadingArchive): string {
	if (archive.originalPath) return path.basename(archive.originalPath);
	const last = new URL(archive.resolvedUrl ?? archive.originalUrl!).pathname.split("/").filter(Boolean).pop();
	try { return last ? decodeURIComponent(last) : "PDF document"; }
	catch { return last || "PDF document"; }
}

async function articleFromArchive(saved: NonNullable<Awaited<ReturnType<ReadingSourceStore["get"]>>>, signal?: AbortSignal): Promise<ReadingArticle> {
	const { archive, content } = saved;
	const url = archive.originalUrl ?? pathToFileURL(archive.originalPath!).href;
	if (archive.kind === "web") {
		const markdown = Buffer.from(content).toString("utf8");
		const prefix = webPrefix(archive.originalUrl!);
		return { ...readingArticle(url, markdown.startsWith(prefix) ? markdown.slice(prefix.length) : markdown), archive };
	}
	const article: ReadingArticle = { url, title: pdfTitle(archive), blocks: [], archive };
	try {
		const pages = await pdfReadingPages(content, { maxChars: MAX_TEXT_CHARS, signal });
		const missing = pages.filter((page) => !page.text.trim()).map((page) => page.page);
		if (missing.length || !pages.length) {
			article.sourceIssue = `The original PDF is saved, but pages ${missing.join(", ") || "all"} have no extractable text. Full guided reading needs readable text for every page; no incomplete route was created.`;
			return article;
		}
		article.blocks = pages.map(({ page, text }) => ({ id: `p${page}`, markdown: text, section: `Page ${page}`, page }));
	} catch (error) {
		signal?.throwIfAborted();
		article.sourceIssue = `The original PDF is saved, but its full text could not be extracted: ${error instanceof Error ? error.message : String(error)}`;
	}
	return article;
}

export function createReadingSourceLoader(store: ReadingSourceStore, options: { chatStore?: ChatStore; fetch?: typeof fetch } = {}): ReadingSourceLoader {
	return async (chatId, input, signal) => {
		signal?.throwIfAborted();
		const source = sourceInput(input);
		const checkChat = async () => {
			const chat = options.chatStore ? await options.chatStore.getChat(chatId) : null;
			if (options.chatStore && (chat?.kind !== "reading" || chat.deleting)) throw new Error("This reading session no longer exists.");
			return chat;
		};
		const chat = await checkChat();
		const previous = chat ? readingStateOf(chat.messages).article : null;
		if (previous) {
			if (new URL(previous.url).href !== source.location) throw new Error("This session already has a source. Start another reading session for a different source.");
			return { ...previous, archive: await archiveReadingSnapshot(store, chatId, previous) };
		}
		const existing = await store.get(chatId);
		if (existing) {
			if (!sameOrigin(existing.archive, source)) throw new Error("This session already has a saved source. Start another reading session for a different source.");
			return articleFromArchive(existing, signal);
		}
		let content: Uint8Array;
		let kind: "web" | "pdf";
		let resolvedUrl: string | undefined;
		if (source.filePath) {
			content = await localPdfBytes(source.filePath, signal);
			if (!isPdf(content)) throw new Error("The selected file is not a PDF.");
			kind = "pdf";
		} else {
			const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
			const response = await (options.fetch ?? fetch)(source.url!, { signal: requestSignal, headers: {
				"User-Agent": "Mozilla/5.0", Accept: "text/html,application/pdf,text/markdown,text/plain;q=0.9,*/*;q=0.8",
			} });
			if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status} ${response.statusText}`); }
			resolvedUrl = response.url || source.location;
			content = await responseBytes(response, requestSignal);
			const contentType = response.headers.get("content-type") ?? "";
			if (isPdf(content)) kind = "pdf";
			else {
				if (/application\/pdf/i.test(contentType)) throw new Error("The response is not a PDF.");
				if (content.byteLength > MAX_WEB_BYTES) throw new Error("Web source too large (over 5 MB).");
				const raw = await extractWebResponse(new Response(Buffer.from(content), { headers: response.headers }), resolvedUrl,
					{ maxChars: MAX_TEXT_CHARS, requireFull: true, signal });
				const markdown = sourceMarkdown(raw);
				readingArticle(source.location, markdown); // validate before committing the file
				content = Buffer.from(webPrefix(source.url!) + markdown, "utf8");
				kind = "web";
			}
		}
		signal?.throwIfAborted();
		await checkChat();
		const archive = await store.save(chatId, { kind, content, originalUrl: source.url, originalPath: source.filePath, resolvedUrl });
		return articleFromArchive({ archive, content }, signal);
	};
}
