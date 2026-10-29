import type { PiEngine } from "../models.ts";
import type { SearchProvider } from "../../core/search.ts";
import {
	accumulateJobUsage,
	buildSubagentSteer,
	isSubagentFailure,
	piUsageToStep,
	type DemoResult,
	type DemoToolInput,
	type JobKind,
	type JobRecord,
	type JobUsage,
	type PdfResult,
	type PdfToolInput,
	type ResearchResult,
	type ResearchToolInput,
	type SteerMessage,
	type UsageStepLike,
	type VisualResult,
	type VisualToolInput,
} from "../../core/contracts.ts";
import { registerJobAbort, unregisterJobAbort } from "./aborts.ts";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRole } from "../../../config.ts";
import { ROLE_SLOT, modelsNotConfigured, type ModelSlotName, type ProviderKeyMissing } from "../../core/settings.ts";
import type { ChatStore, JobPatch, JobStore } from "../../core/ports.ts";
import { withChatWrite } from "../../core/storage-coordination.ts";
import { isStorageStopping, StorageStoppingError } from "../../core/storage-lifecycle.ts";
import { runDemoBuilder } from "./demo-builder.ts";
import { runPdfReaderAgent } from "./pdf-reader.ts";
import { runResearcherAgent } from "./researcher.ts";
import { runVisualMaker } from "./visual-maker.ts";

/**
 * The background job runner (contracts.ts "THE ASYNC PROTOCOL" §2–3), created
 * via createJobRunner({ chatStore, jobStore, deliver }) — the composition root
 * (chat-handler) injects the storage ports and the WAKE SEAM (the server-side
 * steer delivery, src/server/jobs.ts); this module never imports an adapter.
 *
 *   runJob(jobId) — runs the kind's sub-agent loop in the background
 *     (the job tools' execute fires this via the spawn seam, fire-and-forget),
 *     updating the job's activity line on every iteration. On completion the
 *     runner builds the STEER MESSAGE (buildSubagentSteer) and hands it to
 *     `deliver` without waiting. The worker's final outcome and pending
 *     delivery are saved together; the session owns delivery from then on.
 *
 *   On failure the result is the failure shape (empty html/svg + "FAILED: …"
 *   notes; research: failure brief) — and it STILL steers, because the
 *   teacher must learn the outcome. Failed delivery starts stay quietly
 *   pending and never rewrite the worker's computation outcome.
 */

/**
 * Test seam: the spawn wiring has no injection point at the tool layer, so
 * tests swap in a scripted pi engine here to keep job tests off the network.
 * Undefined in production. (The jobs spawn through the module-level KIND
 * runners, which read these at call time.)
 */
export const researchModelOverride: { current?: PiEngine } = {};
export const demoModelOverride: { current?: PiEngine } = {};
export const visualModelOverride: { current?: PiEngine } = {};
export const pdfModelOverride: { current?: PiEngine } = {};

/** The dispatch-time tool input (from src/agent/tools/jobs.ts schemas). */
type JobToolInput = ResearchToolInput | DemoToolInput | VisualToolInput | PdfToolInput;

export interface JobRunnerDeps {
	chatStore: Pick<ChatStore, "getChat">;
	jobStore: Pick<JobStore, "getJob" | "updateJob">;
	/**
	 * Hand a finished job's steer to the session delivery registry. The
	 * promise tracks durable marker acceptance, but the worker never waits
	 * on it. Its persisted pending obligation survives process restart.
	 */
	deliver: (steer: SteerMessage) => Promise<void>;
	/** Settings-resolved engine per role (model slots wave, 2026-09-20):
	 *  the role-override → slot chain, read FRESH per job (the server
	 *  wiring passes effectiveSettings-based resolution). Test overrides
	 *  (below) still win. BYOK (owner, 2026-09-22): the chain may end
	 *  EMPTY → undefined; runJob then refuses the spawn honestly instead
	 *  of guessing a model. */
	engineFor?: (role: ModelRole) => PiEngine | undefined;
	/** The search seam (search port wave, 2026-09-20): resolves the LIVE
	 *  provider fresh per job — server/search.ts composition injected by
	 *  the wiring; null = honestly unavailable (the researcher's web_search
	 *  reports it as recoverable text). Absent seam (tests) reads the same;
	 *  research dispatch and web_fetch do not require search credentials. */
	searchProvider?: () => SearchProvider | null;
	/** Key-presence gate (provider-key interlude, 2026-09-25): given the
	 *  resolved engine's provider + the kind's slot tier, return the
	 *  refusal envelope when the provider's key is missing (null = run).
	 *  Injected because the agent layer may not read the key store; absent
	 *  in tests that inject engines directly (test engines never owe a key). */
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
}

export interface JobRunner {
	/** Run one job's sub-agent loop to completion (background; never throws).
	 *  The tool input rides along from dispatch (the spawn fires mid-stream,
	 *  before the tool part is persisted). Recovery reads saved job input,
	 *  with transcript fallback for legacy jobs. Delivery is not awaited. */
	runJob(jobId: string, input?: JobToolInput): Promise<void>;
}

/** One job loop's injected machinery: the kill switch (real abort, 2026-09
 * semantics) and the usage tap (money channel — every model call folds into
 * JobRecord.usage as it completes). */
interface LoopContext {
	/** Fires when abortJob kills the run; abortSignal is passed into every
	 * model call so the spend stops mid-call, not at the next loop check. */
	abortSignal: AbortSignal;
	/** The job's chat (debug: raw provider-event recording under
	 * LH_PROVIDER_EVENTS=1 — forwarded into every subagent run). */
	chatId?: string;
	/** Fold one model call's usage into the job record (progress write). */
	onUsage: (step: UsageStepLike) => void;
	/** Model observers are synchronous; their writes are queued and flushed. */
	onActivity: (line: string) => void;
}

/** The kind→role table (model slots wave, 2026-09-20): which ModelRole's
 * engine each sub-agent kind runs — the engineFor injection key. */
const KIND_ROLE: Record<JobKind, ModelRole> = {
	research: "researcher",
	demo: "demoBuilder",
	visual: "visualMaker",
	pdf: "pdfReader",
};

const ACTIVE_RUNS = Symbol.for("lh.jobs.runner.active");
const runnerGlobal = globalThis as typeof globalThis & { [ACTIVE_RUNS]?: Map<string, Promise<void>> };
const activeRuns = runnerGlobal[ACTIVE_RUNS] ??= new Map<string, Promise<void>>();

/** Includes workers waiting on their first store read, before abort registration. */
export function activeJobIds(): string[] { return [...activeRuns.keys()]; }

/** Abort signals do not prove that final usage/result writes have finished. */
export async function awaitJobRunners(): Promise<void> {
	while (activeRuns.size > 0) await Promise.allSettled([...activeRuns.values()]);
}

class JobPersistenceError extends Error {
	constructor(cause: unknown) { super("The job outcome could not be saved.", { cause }); }
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
	const { chatStore, jobStore, deliver } = deps;

	/** Running usage totals per live job (the loop's onUsage folds here,
	 * then writes through the job store so the poll sees progress). */
	const usageTotals = new Map<string, JobUsage>();
	const progress = new Map<string, { flush(): Promise<void> }>();

	function makeLoopContext(job: JobRecord, engine: PiEngine): LoopContext {
		const { id: jobId, chatId } = job;
		// Provider-qualified stamp: the engine's actual model — the only
		// thing that ran (BYOK: no config-pin fallback stamps exist).
		const model = `${engine.model.provider}:${engine.model.id}`;
		// Real-kill wiring (2026-09 abort semantics): the controller is what
		// the abort endpoint fires (agent/subagents/aborts.ts registry); the
		// signal rides into every model call of the loop.
		const controller = new AbortController();
		registerJobAbort(jobId, controller);
		if (job.usage) usageTotals.set(jobId, job.usage);
		let pending = Promise.resolve();
		let failure: Error | undefined;
		const enqueue = (patch: JobPatch) => {
			pending = pending.then(async () => {
				if (failure) return;
				await withChatWrite(chatId, async () => {
					const chat = await chatStore.getChat(chatId);
					const current = await jobStore.getJob(jobId);
					if (!chat || chat.deleting || !current) { controller.abort(); return; }
					// Aborts retain billed usage but own their terminal activity.
					if (current.status !== "running" && !patch.usage) return;
					await jobStore.updateJob(jobId, patch);
				});
			}).catch((error: unknown) => { failure ??= error instanceof Error ? error : new Error("Job progress could not be saved", { cause: error }); controller.abort(failure); });
		};
		progress.set(jobId, { flush: async () => { await pending; if (failure) throw failure; } });
		return {
			abortSignal: controller.signal,
			chatId,
			onUsage: (step) => {
				const next = accumulateJobUsage(usageTotals.get(jobId), model, step);
				usageTotals.set(jobId, next);
				enqueue({ usage: next }); // merge patch — status untouched
			},
			onActivity: (activity) => enqueue({ activity }),
		};
	}

	/** Read/check/write under the same gate as abort and session deletion. */
	async function updateRunning(jobId: string, patch: JobPatch): Promise<JobRecord | null> {
		const known = await jobStore.getJob(jobId);
		if (!known) return null;
		return withChatWrite(known.chatId, async () => {
			const chat = await chatStore.getChat(known.chatId);
			const current = await jobStore.getJob(jobId);
			if (!chat || chat.deleting || !current || current.status !== "running") return null;
			return jobStore.updateJob(jobId, patch);
		});
	}

	/** The kind→runner map: one sub-agent loop per kind. Each kind's
	 *  runner narrows the union input itself (dispatch-time inputs are
	 *  kind-correct by construction; transcript fallbacks are cast after). */
	/** The engine one job runs on: test override first (the old seam —
	 *  tests swap scripted engines without touching deps), then the injected
	 *  settings-resolved engineFor. undefined = the BYOK chain came up
	 *  empty (owner, 2026-09-22) — runJob refuses below, honestly. */
	function pickEngine(kind: JobKind): PiEngine | undefined {
		const testOverride: Record<string, { current?: PiEngine } | undefined> = {
			researcher: researchModelOverride,
			demoBuilder: demoModelOverride,
			visualMaker: visualModelOverride,
			pdfReader: pdfModelOverride,
		};
		return testOverride[KIND_ROLE[kind]]?.current ?? deps.engineFor?.(KIND_ROLE[kind]);
	}

	const KIND_RUNNERS: Record<
		JobKind,
		(jobId: string, engine: PiEngine, input: JobToolInput | undefined, loop: LoopContext) => Promise<void>
	> = {
		research: (jobId, engine, input, loop) => runResearchJob(jobId, engine, input, loop),
		demo: (jobId, engine, input, loop) => runDemoJob(jobId, engine, input, loop),
		visual: (jobId, engine, input, loop) => runVisualJob(jobId, engine, input, loop),
		pdf: (jobId, engine, input, loop) => runPdfJob(jobId, engine, input, loop),
	};

	async function runJob(jobId: string, input?: JobToolInput): Promise<void> {
		if (isStorageStopping() || activeRuns.has(jobId)) return;
		// Register before the first asynchronous store operation can begin.
		const running = Promise.resolve().then(() => executeJob(jobId, input)).catch((error: unknown) => {
			console.error(`[job ${jobId}] could not complete the persisted job:`, error);
		}).finally(() => { if (activeRuns.get(jobId) === running) activeRuns.delete(jobId); });
		activeRuns.set(jobId, running);
		await running;
	}

	async function executeJob(jobId: string, input?: JobToolInput): Promise<void> {
		if (isStorageStopping()) return;
		const job = await jobStore.getJob(jobId);
		if (isStorageStopping()) return;
		if (!job) {
			console.error(`[job ${jobId}] not found — nothing to run`);
			return;
		}
		if (job.status !== "running") return; // already finished / re-run after crash recovery
		const run = KIND_RUNNERS[job.kind];
		if (!run) {
			console.error(`[job ${jobId}] unknown kind: ${job.kind}`);
			await updateRunning(jobId, { status: "error", error: `unknown kind ${job.kind}`, activity: "failed" });
			return;
		}
		const engine = pickEngine(job.kind);
		// The per-need refusal guards (BYOK 2026-09-22 / provider-key
		// interlude 2026-09-25): no engine for the kind's tier, or the
		// resolved engine's provider key gone — both refuse through the SAME
		// convention as every other failed job: record the honest error (no
		// status flip: finalizeJob owns the terminal flip after delivery),
		// then steer the kind's failure shape through finishJob so the wake
		// pipeline resumes the lesson and the teacher reads the refusal
		// instead of waiting forever on a job it already dispatched.
		const refuse = async (reason: string): Promise<void> => {
			await updateRunning(jobId, { error: reason });
			const resolved = await resolveInput(job, input) as
				| ResearchToolInput
				| DemoToolInput
				| VisualToolInput
				| PdfToolInput
				| undefined;
			const pdf = resolved as PdfToolInput | undefined;
			const failure: ResearchResult | DemoResult | VisualResult | PdfResult =
				job.kind === "research"
					? { brief: `Research failed: ${reason}`, sources: [] }
					: job.kind === "demo"
						? {
								title: typeof (resolved as DemoToolInput | undefined)?.title === "string" && (resolved as DemoToolInput).title.trim() ? (resolved as DemoToolInput).title : "Interactive demo",
								html: "",
								tested: true,
								notes: `FAILED: ${reason}`,
							}
						: job.kind === "visual"
							? { svg: "", notes: `FAILED: ${reason}` }
							: {
									path: typeof pdf?.path === "string" ? pdf.path : "",
									question: typeof pdf?.question === "string" ? pdf.question : "",
									brief: `PDF failed: ${reason}`,
									pagesRead: [],
									pagesConsulted: [],
								};
			await finishJob(jobId, failure);
		};
		if (!engine) {
			const tier = ROLE_SLOT[KIND_ROLE[job.kind]];
			const envelope = modelsNotConfigured([tier]);
			console.info(`[job ${jobId}] refused — ${JSON.stringify(envelope)}`);
			await refuse(`${envelope.error} (missing: ${tier})`);
			return;
		}
		// Key presence (2026-09-25): the engine exists, but its provider's
		// key may be gone — refuse the spawn BEFORE the loop, same
		// convention (the injected check reads the key store; absent in
		// engine-injecting tests).
		const keyRefusal =
			deps.providerKeyMissing?.(engine.model.provider, ROLE_SLOT[KIND_ROLE[job.kind]]) ?? null;
		if (keyRefusal) {
			console.info(`[job ${jobId}] refused — ${JSON.stringify(keyRefusal)}`);
			await refuse(keyRefusal.error);
			return;
		}
		if (isStorageStopping()) return;
		const guardedEngine: PiEngine = {
			...engine,
			streamFn: (...args) => {
				if (isStorageStopping()) throw new StorageStoppingError();
				return engine.streamFn(...args);
			},
		};
		try {
			await run(jobId, guardedEngine, input, makeLoopContext(job, engine));
		} finally {
			try { await progress.get(jobId)?.flush(); }
			finally {
				unregisterJobAbort(jobId);
				progress.delete(jobId);
				usageTotals.delete(jobId);
			}
		}
	}

	/** Dispatch input wins, then the job's saved arguments. Legacy jobs
	 * without saved input fall back to the durable transcript, which may
	 * lack a call if the dispatching turn died before settlement. */
	async function resolveInput(
		job: JobRecord,
		input: JobToolInput | undefined,
	): Promise<JobToolInput | undefined> {
		if (input) return input;
		if (job.input !== undefined) return job.input as JobToolInput;
		const chat = await chatStore.getChat(job.chatId);
		if (!chat) return undefined;
		// Wave D: the record is native history — the scan reads the native
		// assistant blocks directly (a toolCall's arguments are the input).
		for (const m of chat.messages) {
			if ((m as { role?: string }).role !== "assistant") continue;
			const content = (m as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			for (const block of content as Array<{ type?: string; id?: string; arguments?: unknown }>) {
				if (block.type !== "toolCall" || block.id !== job.toolCallId) continue;
				return block.arguments as JobToolInput | undefined;
			}
		}
		return undefined;
	}

	/**
	 * Save the computation outcome and session delivery obligation together.
	 * Worker liveness ends after cleanup, not after a lesson consumes the result.
	 */
	async function finishJob(jobId: string, result: ResearchResult | DemoResult | VisualResult | PdfResult): Promise<void> {
		let saved: JobRecord | null;
		try {
			await progress.get(jobId)?.flush();
			const known = await jobStore.getJob(jobId);
			if (!known) return;
			saved = await withChatWrite(known.chatId, async () => {
				const chat = await chatStore.getChat(known.chatId);
				const job = await jobStore.getJob(jobId);
				if (!chat || chat.deleting || !job || job.status !== "running") return null;
				const failed = isSubagentFailure(job.kind, result);
				return jobStore.updateJob(jobId, {
					result,
					status: failed ? "error" : "done",
					activity: failed ? "failed" : "finished",
					delivery: { kind: "result", status: "pending" },
				});
			});
		} catch (error) { throw new JobPersistenceError(error); }
		if (!saved) return;
		// The saved result now belongs to the session. Do not keep the worker,
		// abort registration, or temporary resources alive behind a question.
		if (isStorageStopping()) return; // the durable pending obligation survives restart
		void deliver(buildSubagentSteer(saved, result)).catch((err: unknown) => {
			console.error(`[job ${jobId}] pending delivery:`, err);
		});
	}

	/** Chat-record + input resolution shared by all three runners. */
	async function jobContext(jobId: string): Promise<{ job: JobRecord; chatId: string } | null> {
		if (isStorageStopping()) return null;
		const job = await jobStore.getJob(jobId);
		if (isStorageStopping() || !job || job.status !== "running") return null;
		const chat = await chatStore.getChat(job.chatId);
		if (isStorageStopping()) return null;
		if (chat?.deleting) return null;
		if (!chat) {
			await withChatWrite(job.chatId, async () => {
				const current = await jobStore.getJob(jobId);
				if (current?.status === "running") await jobStore.updateJob(jobId, { status: "error", error: `Chat not found: ${job.chatId}`, activity: "failed" });
			});
			return null;
		}
		return { job, chatId: job.chatId };
	}

	// ─── research ───────────────────────────────────────────────────────────

	async function runResearchJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = await jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? await resolveInput(job, passedInput)) as ResearchToolInput | undefined;
		if (!(typeof input?.question === "string" && input.question.trim())) {
			await updateRunning(jobId, { error: "research question unavailable" });
			await finishJob(jobId, { brief: "Research failed: the research question is unavailable.", sources: [] });
			return;
		}
		const question = input.question;
		const context = typeof input?.context === "string" && input.context.trim() ? input.context : undefined;

		const prompt = [
			`Research question: ${question}`,
			context ? `Context (what this is needed for): ${context}` : null,
			"Produce your final brief in the required format.",
		]
			.filter(Boolean)
			.join("\n\n");

		const fetchedUrls: string[] = [];
		// Per-job PDF dir (researcher PDF wave, 2026-10-07): web_fetch_pdf
		// downloads land here; every pdf tool is scoped to it; it dies with
		// the job (never enters the record).
		const pdfDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-research-"));

		try {
			if (isStorageStopping() || loop.abortSignal.aborted) return;
			if (!await updateRunning(jobId, { activity: "researching" })) return;
			if (isStorageStopping() || loop.abortSignal.aborted) return;
			const brief = await runResearcherAgent(prompt, {
				engine: model,
				search: deps.searchProvider,
				pdfDir,
				abortSignal: loop.abortSignal,
				chatId: loop.chatId,
				// Money channel: each agent step is one model call — fold its
				// usage into the record as it completes (progress write).
				onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
					onToolStart: (toolName, args) => {
					const input = args as { query?: string; url?: string } | undefined;
					if (typeof input?.url === "string" && (toolName === "web_fetch" || toolName === "web_fetch_pdf")) {
						fetchedUrls.push(input.url);
					}
					loop.onActivity(activityLine(toolName, input));
				},
			});
			if (!brief.trim()) throw new Error("the researcher produced no text");
			const research: ResearchResult = { brief: brief.trim(), sources: parseSources(brief.trim(), fetchedUrls) };
			await finishJob(jobId, research);
		} catch (err) {
			// Real-kill abort (2026-09): the abort path flipped the record and
			// queued the abort steer — unwind silently, keep the usage
			// folded so far (flushed by runJob's finally).
			if (err instanceof JobPersistenceError) throw err;
			if (err instanceof StorageStoppingError) return;
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			await updateRunning(jobId, { error: reason });
			await finishJob(jobId, { brief: `Research failed: ${reason}`, sources: [] });
		} finally {
			await fs.rm(pdfDir, { recursive: true, force: true });
		}
	}

	// ─── demo + visual ──────────────────────────────────────────────────────

	async function runDemoJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = await jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? await resolveInput(job, passedInput)) as DemoToolInput | undefined;
		const title = typeof input?.title === "string" && input.title.trim() ? input.title : "Interactive demo";
		const brief = typeof input?.brief === "string" ? input.brief : "";

		try {
			if (isStorageStopping() || loop.abortSignal.aborted) return;
			if (!await updateRunning(jobId, { activity: "building demo" })) return;
			if (isStorageStopping() || loop.abortSignal.aborted) return;
			const result = await runDemoBuilder(
				{ title, brief },
				{
					engine: model,
					abortSignal: loop.abortSignal,
					chatId: loop.chatId,
					onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
					onActivity: loop.onActivity,
				},
			);
			if (isDemoFailure(result))
				await updateRunning(jobId, { error: result.notes ?? "demo build failed" });
			await finishJob(jobId, result);
		} catch (err) {
			if (err instanceof JobPersistenceError) throw err;
			if (err instanceof StorageStoppingError) return;
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			await updateRunning(jobId, { error: reason });
			await finishJob(jobId, { title, html: "", tested: true, notes: `FAILED: ${reason}` });
		}
	}

	async function runVisualJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = await jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? await resolveInput(job, passedInput)) as VisualToolInput | undefined;
		const brief = typeof input?.brief === "string" ? input.brief : "";

		try {
			if (isStorageStopping() || loop.abortSignal.aborted) return;
			if (!await updateRunning(jobId, { activity: "drawing figure" })) return;
			if (isStorageStopping() || loop.abortSignal.aborted) return;
			const result = await runVisualMaker(
				{ brief },
				{
					engine: model,
					abortSignal: loop.abortSignal,
					chatId: loop.chatId,
					onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
					onActivity: loop.onActivity,
				},
			);
			if (isVisualFailure(result))
				await updateRunning(jobId, { error: result.notes ?? "visual build failed" });
			await finishJob(jobId, result);
		} catch (err) {
			if (err instanceof JobPersistenceError) throw err;
			if (err instanceof StorageStoppingError) return;
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			await updateRunning(jobId, { error: reason });
			await finishJob(jobId, { svg: "", notes: `FAILED: ${reason}` });
		}
	}

	// ─── pdf reading (sources v0) ────────────────────────────────────────────

	async function runPdfJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = await jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? await resolveInput(job, passedInput)) as PdfToolInput | undefined;
		const path = typeof input?.path === "string" && input.path.trim() ? input.path.trim() : "";
		const question = typeof input?.question === "string" ? input.question : "";

		try {
			if (isStorageStopping() || loop.abortSignal.aborted) return;
			if (!await updateRunning(jobId, { activity: "reading pdf" })) return;
			if (isStorageStopping() || loop.abortSignal.aborted) return;
			const result = await runPdfReaderAgent(
				{ path, question },
			{
				engine: model,
				abortSignal: loop.abortSignal,
				chatId: loop.chatId,
				onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
				onActivity: loop.onActivity,
			},
			);
			if (isPdfFailure(result))
				await updateRunning(jobId, { error: result.brief.replace(/^PDF failed:\s*/i, "") });
			await finishJob(jobId, result);
		} catch (err) {
			if (err instanceof JobPersistenceError) throw err;
			if (err instanceof StorageStoppingError) return;
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			await updateRunning(jobId, { error: reason });
			await finishJob(jobId, { path, question, brief: `PDF failed: ${reason}`, pagesRead: [], pagesConsulted: [] });
		}
	}

	return { runJob };
}

// ─── module-level pure helpers ──────────────────────────────────────────────

/** Failure shape (W6 brief): html === "" with "FAILED: …" notes. */
function isDemoFailure(result: DemoResult): boolean {
	return typeof result.html !== "string" || result.html.length === 0;
}

function isVisualFailure(result: VisualResult): boolean {
	return typeof result.svg !== "string" || result.svg.length === 0;
}

/** The pdf-reader's failure brief (mirrors the research failure shape). */
function isPdfFailure(result: PdfResult): boolean {
	return /^PDF failed:/i.test(result.brief);
}

/** The activity line shown in the UI: `web_search: "query"` / `web_fetch: host`. */
function activityLine(toolName: string, input: { query?: string; url?: string } | undefined): string {
	if (toolName === "web_search") return `web_search: "${input?.query ?? ""}"`;
	if (toolName === "web_fetch") return `web_fetch: ${hostOf(input?.url)}`;
	return toolName;
}

function hostOf(url: string | undefined): string {
	if (!url) return "(no url)";
	try {
		return new URL(url).hostname;
	} catch {
		return url.slice(0, 40);
	}
}

/** Sources for the result: markdown links cited in the brief, else fetched URLs. */
function parseSources(brief: string, fetchedUrls: string[]): ResearchResult["sources"] {
	const sources: ResearchResult["sources"] = [];
	const seen = new Set<string>();
	for (const match of brief.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
		const title = (match[1] ?? "").trim();
		const url = match[2]!;
		if (!title || seen.has(url)) continue;
		seen.add(url);
		sources.push({ title, url });
	}
	if (sources.length === 0) {
		for (const url of fetchedUrls) {
			if (seen.has(url)) continue;
			seen.add(url);
			sources.push({ title: hostOf(url), url });
		}
	}
	return sources.slice(0, 10);
}
