import { abortExtraction, extractionStatuses } from "../agent/subagents/extraction.ts";
import { isJobLive } from "../agent/subagents/aborts.ts";
import { withChatWrite, withGraphWrite } from "../core/storage-coordination.ts";
import { graphDraft } from "../core/storage-snapshot.ts";
import type { ChatDeletion } from "../core/ports.ts";
import { coverageOf } from "../core/coverage.ts";
import { deleteChatTraces, type ChatDeleteMode, type ChatDeletionStats } from "../core/graph-deletion.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import { graphRevision } from "./graph.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { clearTurnFailure } from "./turn-runs.ts";
import { discardChatDeliveries } from "./jobs.ts";

/**
 * Server-side chat entries for the transport layer (app/api/chats*,
 * app/chat/[id]). Today these delegate straight to the ChatStore port; the
 * services stage carves the real orchestration behind this same surface.
 *
 * deleteChatSession (wave 6, session deletion — the FIRST destructive
 * operation on the graph ledgers) is the one real orchestration here:
 * gates → extraction wind-down → durable marker → recoverable cleanup. See
 * core/graph-deletion.ts for the ledger semantics and the atomicity
 * argument.
 */

export const { createChat, getChat, listChats } = stores.chatStore;
export { titleFromPrompt };
export type { ChatDeleteMode, ChatDeletionStats } from "../core/graph-deletion.ts";

/** How long the wind-down wait may take before the caller gets a retryable
 *  503 (an aborted extraction ends at its next model-call boundary —
 *  provider cancellation is normally sub-second, but a wedged provider
 *  must never wedge deletion). */
const WIND_DOWN_TIMEOUT_MS = 10_000;
const WIND_DOWN_POLL_MS = 50;

/** What deleteChatSession did — the route maps it straight to HTTP. */
export type ChatDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "turn_in_flight" | "jobs_running"; error: string; jobIds: string[] }
	| { ok: false; status: 503; code: "extraction_winding_down"; error: string }
	| {
			ok: true;
			mode: ChatDeleteMode;
			stats: ChatDeletionStats;
			jobsRemoved: number;
			graphRevision: string;
	  };

/** Refuse live work before establishing the durable deletion barrier. */
async function runningWorkBlocker(chatId: string): Promise<Extract<ChatDeleteOutcome, { status: 409 }> | null> {
	if (isTurnRunning(chatId)) {
		return {
			ok: false,
			status: 409,
			code: "turn_in_flight",
			error: "A turn is running in this session — try again when it finishes",
			jobIds: [],
		};
	}
	// Legacy records kept completed workers running until delivery. A saved
	// result without a live loop is pending session data, not computing work;
	// deletion must not depend on a prior recovery poll to recognize it.
	const runningJobs = (await stores.jobStore.listJobs(chatId)).filter((job) =>
		job.status === "running" && (!job.result || isJobLive(job.id)));
	if (runningJobs.length > 0) {
		return {
			ok: false,
			status: 409,
			code: "jobs_running",
			error: "Background jobs are still running in this session — try again when they finish",
			jobIds: runningJobs.map((job) => job.id),
		};
	}
	return null;
}

/** Finish only after the durable marker has blocked every normal session write. */
async function finishDeletion(chatId: string, deletion: ChatDeletion): Promise<Extract<ChatDeleteOutcome, { ok: true }>> {
	const stats = await withGraphWrite(async () => {
		const draft = graphDraft(await stores.graphStore.readSnapshot());
		const stats = deleteChatTraces(draft.store, chatId, deletion.mode);
		await stores.graphStore.commitBatch(draft.batch(deletion.operationId));
		return stats;
	});
	const jobsRemoved = await stores.jobStore.deleteJobsForChat(chatId);
	await stores.readingSourceStore.delete(chatId);
	if (await stores.chatStore.deleteChat(chatId)) {
		discardChatDeliveries(chatId);
		clearTurnFailure(chatId);
	}
	return { ok: true, mode: deletion.mode, stats, jobsRemoved, graphRevision: await graphRevision() };
}

export function deleteChatSession(chatId: string, mode: ChatDeleteMode): Promise<ChatDeleteOutcome> {
	return withChatWrite(chatId, async () => {
		const record = await stores.chatStore.getChat(chatId);
		if (!record) return { ok: false, status: 404, code: "not_found", error: "No such session" };
		if (record.deleting) return finishDeletion(chatId, record.deleting);
		const blocker = await runningWorkBlocker(chatId);
		if (blocker) return blocker;
		if (extractionStatuses().some((run) => run.chatId === chatId)) {
			abortExtraction(chatId);
			const deadline = Date.now() + WIND_DOWN_TIMEOUT_MS;
			while (extractionStatuses().some((run) => run.chatId === chatId)) {
				if (Date.now() > deadline) return { ok: false, status: 503, code: "extraction_winding_down", error: "The session's extraction is still winding down — try again in a moment" };
				await new Promise((resolve) => setTimeout(resolve, WIND_DOWN_POLL_MS));
			}
		}
		const lateBlocker = await runningWorkBlocker(chatId);
		if (lateBlocker) return lateBlocker;
		const deletion: ChatDeletion = { mode, operationId: `delete-chat:${crypto.randomUUID()}`, startedAt: new Date().toISOString() };
		await stores.chatStore.beginDeletion(chatId, deletion);
		return finishDeletion(chatId, deletion);
	});
}

/** Called before job recovery and before accepting requests after a restart. */
export async function recoverChatDeletions(): Promise<void> {
	for (const record of await stores.chatStore.listDeletingChats()) {
		await withChatWrite(record.id, async () => {
			const fresh = await stores.chatStore.getChat(record.id);
			if (fresh?.deleting) await finishDeletion(fresh.id, fresh.deleting);
		});
	}
}

/** One session's coverage read (extraction-UX redesign, owner dispatch
 *  2026-09-24): the chat view's ring meter + popover data, scoped to one
 *  chat (the all-sessions GET died with this redesign — nothing consumed
 *  it once the sidebar and ring read here; the Extract POST stays).
 *  Uncovered stays DERIVED per request (fingerprint the transcript,
 *  diff the coverage ledger — never dual-tracked).
 *
 *  lastFoldedAt: the newest coverage row's fold timestamp — a cheap single
 *  pass over the chat's ledger rows (the ring popover's "last extraction"
 *  line); null before the session's first fold. */
export interface SessionCoverage {
	totalMessages: number;
	coveredCount: number;
	uncoveredCount: number;
	coveredTokens: number;
	uncoveredTokens: number;
	/** True while a chat-kind extraction run is registered for this session. */
	running: boolean;
	/** ISO of the newest fold in this session's coverage rows; null before any. */
	lastFoldedAt: string | null;
}

/** The per-session coverage block (see SessionCoverage). Null when the
 *  chat doesn't exist — callers own the 404. */
export async function sessionCoverage(chatId: string): Promise<SessionCoverage | null> {
	const record = await stores.chatStore.getChat(chatId);
	if (!record || record.deleting) return null;
	const entries = await stores.graphStore.readCoverage();
	// Wave B: the record is native history — coverage reads through the
	// projection (same view the extraction pipeline folds).
	const cov = coverageOf(record.messages, entries, chatId, record.kind === "reading");
	let lastFoldedAt: string | null = null;
	for (const entry of entries) {
		if (entry.chatId !== chatId) continue;
		if (lastFoldedAt === null || entry.foldedAt > lastFoldedAt) lastFoldedAt = entry.foldedAt;
	}
	return {
		totalMessages: cov.slots.length,
		coveredCount: cov.coveredCount,
		uncoveredCount: cov.uncoveredCount,
		coveredTokens: cov.coveredTokens,
		uncoveredTokens: cov.uncoveredTokens,
		running: extractionStatuses().some((run) => run.kind === "chat" && run.chatId === chatId),
		lastFoldedAt,
	};
}
