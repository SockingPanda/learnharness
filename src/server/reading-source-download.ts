import { readingStateOf } from "../core/reading.ts";
import { archiveReadingSnapshot } from "./reading-sources.ts";
import { stores } from "./stores.ts";

/** Download only this session's archived original, never an arbitrary path. */
export async function getReadingSourceDownload(chatId: string): Promise<Response> {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) return Response.json({ error: "Unknown reading session" }, { status: 404 });
	const chat = await stores.chatStore.getChat(chatId);
	if (chat?.kind !== "reading" || chat.deleting) return Response.json({ error: "Unknown reading session" }, { status: 404 });
	try {
		const article = readingStateOf(chat.messages).article;
		let saved = await stores.readingSourceStore.get(chatId);
		if (saved && article) await archiveReadingSnapshot(stores.readingSourceStore, chatId, article);
		if (!saved) {
			if (!article) return Response.json({ error: "No saved source" }, { status: 404 });
			await archiveReadingSnapshot(stores.readingSourceStore, chatId, article);
			saved = await stores.readingSourceStore.get(chatId);
		}
		if (!saved) return Response.json({ error: "No saved source" }, { status: 404 });
		return new Response(new Uint8Array(saved.content), { headers: {
			"Content-Type": saved.archive.kind === "pdf" ? "application/pdf" : "text/markdown; charset=utf-8",
			"Content-Disposition": `attachment; filename="${saved.archive.fileName}"`,
			"Content-Length": String(saved.content.byteLength),
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		} });
	} catch (error) {
		console.error(`[reading source ${chatId}]`, error);
		return Response.json({ error: "The saved source is missing or damaged. Restore the original archive from a backup." }, { status: 409 });
	}
}
