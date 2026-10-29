import type { Usage } from "@earendil-works/pi-ai";
import { createReadingSourceLoader } from "./reading-sources.ts";
import {
	createPracticeAgent,
	createReadingAgent,
	createProberAgent,
	createTeacherAgent,
	type AgentBuildOptions,
	type TeachingAgent,
} from "../agent/teacher-agent.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { connectionBackgroundAllowed as subscriptionBackgroundAllowed, connectionScopeCurrent, isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { nativeSubscriptionError } from "../agent/subscription-stream.ts";
import { chatGPTStreamError } from "../agent/chatgpt-stream.ts";
import { SubscriptionRequestCycle, type SubscriptionDispatchLifecycle } from "../agent/subscription-request-cycle.ts";
import { reconstructRequestCause } from "../core/native-messages.ts";
import { createJobRunner } from "../agent/subagents/runner.ts";
import { createExtractionPipeline } from "../agent/subagents/extraction.ts";
import type { ModelRole } from "../../config.ts";
import {
	deliverJobResult,
	noteSteersDurable,
	reconcileUserSteers,
	registerLiveAgent,
	restoreUncommittedAutomatic,
	setJobRespawn,
	setTurnRunner,
	settleSteers,
	steerLiveChat,
	unregisterLiveAgent,
} from "./jobs.ts";
import { runPiTurn } from "./pi/ui-stream.ts";
import { collectToolCallIds } from "./pi/call-ids.ts";
import { providerEventNote } from "../agent/provider-events.ts";
import { effectiveSettings, stores, storageMode, storageMutationResponse } from "./stores.ts";
import { isStorageStopping, StorageStoppingError } from "../core/storage-lifecycle.ts";
import { searchAvailable, searchProvider } from "./search.ts";
import { providerKeyPresent } from "./keys.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import {
	extractionEnabled,
	graphToolsEnabled,
	resolveConversationSpec,
	resolveRoleSpec,
} from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope, type ProviderKeyMissing } from "../core/settings.ts";
import { beginTurn, endTurn } from "./turn-liveness.ts";
import { applyParkedDismissal } from "./dismissal-park.ts";
import { registerTurn, registerPendingTurnAbort, unregisterPendingTurnAbort, rememberTurnFailure, unregisterTurn } from "./turn-runs.ts";
import { persistTurn, triggerExtraction, TurnPersistenceError } from "./turn-service.ts";
import { withChatWrite } from "../core/storage-coordination.ts";
import { hasProbeDone, danglingQuestionOf } from "../core/native-messages.ts";
import { composeInstructions } from "../agent/teacher-agent.ts";
import { ensureCompacted, kickCompaction, effectiveThresholdTokens } from "./compaction.ts";
import { catalogContextLimits, refreshConnectionCatalog } from "./model-catalog.ts";
import { emit } from "../core/events.ts";
import { settledTurnResponse } from "./turn-runs.ts";
import { asAgentMessages } from "../core/native-messages.ts";
import {
	ChatInputError,
	inputAppends,
	parseChatInput,
	retryDrops,
	type TurnInput,
} from "../core/input-events.ts";
import { steerDelivered } from "../core/contracts.ts";
import type {CallUsage} from "../core/contracts.ts";
import { readingSessionContext } from "../core/reading.ts";

/**
 * One chat turn over the server-owned native record. Framework-free (plain
 * Request/Response) so tests can drive it directly with a scripted faux
 * engine — the Next route handler in app/api/chat is a one-line wrapper.
 *
 * THE INPUT-EVENTS CONTRACT (Wave B, owner ruling 2026-09-26): POST /api/chat
 * carries {chatId, input} — one explicit event (text / answer / verdict /
 * continue), never a client transcript. The server owns the record; this
 * module is the TURN COMPOSITION ROOT: it turns the event into native
 * record appends (core/input-events.ts), builds the agent from the record
 * (the record IS the agent state — state.messages = record.messages,
 * continue()), and runs the turn as a background object (pi/ui-stream.ts).
 * Wake-pipeline steers ride the same composition (TurnInput's steer kind).
 *
 * THE SAME COMPOSITION serves both entry points: client requests and the
 * wake pipeline's server-side steers (src/server/jobs.ts) — one code path
 * for write-ahead persistence, turn liveness, and the turn services.
 */

/** Fresh check only at new background-run admission; never cancel a run
 * already in progress when the opt-in is switched off. */
function connectionBackgroundAllowed(provider: string): boolean {
	return subscriptionBackgroundAllowed(provider) && (provider !== CLAUDE_CODE_PROVIDER || providerKeyPresent(provider));
}

function settlementErrorText(error: unknown): string {
	return error instanceof TurnPersistenceError ? error.message : "An error occurred.";
}

const jobRunner = createJobRunner({
	chatStore: stores.chatStore,
	jobStore: stores.jobStore,
	deliver: deliverJobResult,
	// BYOK (owner, 2026-09-22): job engines resolve the chain — role
	// override → slot → NOTHING — read FRESH per job (a settings PUT
	// between dispatch and spawn lands); an empty chain flows through as
	// undefined and the runner refuses the spawn honestly.
	engineFor: (role) =>
		resolveEngine(role),
	// Key-presence gate (provider-key interlude, 2026-09-25): the runner
	// reads the resolved engine's provider and asks THIS check (the agent
	// layer may not read the key store); a missing key refuses the spawn
	// with the 503-envelope family instead of dying mid-run.
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
	// Search port wave (2026-09-20): the researcher's web_search runs on the
	// injected port — resolved FRESH per job (key rotations land immediately).
	// null = honestly unavailable; the dispatch-level drop (below) uses the
	// same signal so keyless servers never see the research tool at all.
	searchProvider,
});
/** The app's ONE extraction pipeline instance — both front doors share it:
 *  quiz-triggered session runs (turn-service) and notes imports
 *  (/api/graph/import) hit the same single-flight registry. */
export const extraction = createExtractionPipeline({
	...stores,
	// BYOK (owner, 2026-09-22): the extraction stages resolve the chain —
	// role override → slot → NOTHING — read FRESH per stage call; an empty
	// chain flows through as undefined and the pipeline refuses the run
	// with the typed ModelsNotConfiguredError. Direct test values still win.
	engineFor: (role) =>
		resolveEngine(role),
	// Key-presence gate (provider-key interlude, 2026-09-25): same check
	// the job runner gets — a stage engine whose provider key is gone
	// refuses BEFORE any batch runs (the typed throw), never mid-run.
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
});


// Wake-pipeline wiring (contracts.ts "THE ASYNC PROTOCOL" §4): the pipeline
// delivers its steers through THIS composition root (one event: the steer
// marker, appended natively under the turn claim), and crash recovery
// re-spawns orphaned sub-agent loops through THIS runner.
setTurnRunner(async (chatId, input) => {
	const res = await handleChatInput(chatId, input);
	// Drive the stream to completion server-side — nobody else will read it,
	// and onFinish (persist, extraction, endTurn) only runs when it drains.
	await res.arrayBuffer().catch(() => undefined);
	return res.status;
});
/** The settings-resolved engine for one role — BYOK (owner, 2026-09-22):
 *  the chain (role override → slot → NOTHING) may end empty, and undefined
 *  flows through to the per-need refusal gates (runner/extraction), read
 *  FRESH so a settings PUT between dispatch and spawn lands. */
function resolveEngine(role: ModelRole): PiEngine | undefined {
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	return spec ? piEngineForSpec(spec) : undefined;
}

setJobRespawn((jobId) => void jobRunner.runJob(jobId));

/** The route-facing entry: parse {chatId, input} and run one turn. */
export async function handleChatRequest(
	req: Request,
	buildAgent?: (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent,
): Promise<Response> {
	const unavailable = storageMutationResponse();
	if (unavailable) return unavailable;
	let body: { chatId?: unknown; input?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const chatId = typeof body.chatId === "string" ? body.chatId : "";
	if (!chatId) return Response.json({ error: "Unknown chat" }, { status: 404 });
	let input: TurnInput;
	try {
		input = parseChatInput(body.input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}
	return handleChatInput(chatId, input, buildAgent);
}

/**
 * The turn composition: one input event → native record appends → one
 * agent turn as a background object. Also the wake pipeline's entry
 * (TurnInput's steer kind appends the marker under the same claim).
 */
export async function handleChatInput(
	chatId: string,
	input: TurnInput,
	buildAgent?: (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent,
): Promise<Response> {
	const unavailable = storageMutationResponse();
	if (unavailable) return unavailable;
	const tracksInterruptedTurns = storageMode() === "any";
	const turnUsageId = crypto.randomUUID();
	const preparing = new AbortController();
	let record = await stores.chatStore.getChat(chatId);
	if (!record || record.deleting) {
		return Response.json({ error: "Unknown chat" }, { status: 404 });
	}

	if (tracksInterruptedTurns && record.pendingTurnId && (input.type === "continue" || input.type === "steers")) {
		return Response.json({ error: "This turn was interrupted. Retry explicitly to continue." }, { status: 409 });
	}

	// Refuse an ineligible Retry before catalog refresh, compaction, or any
	// turn/write effects. Revalidate after the awaited gates below too.
	if (input.type === "retry") {
		try {
			retryDrops(record.messages);
		} catch (err) {
			if (!(tracksInterruptedTurns && record.pendingTurnId)) {
				if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
				throw err;
			}
		}
	}

	// THE UNIVERSAL TURN GATE (BYOK, owner, 2026-09-22): a turn needs the
	// CONVERSATION chain — the chat's own model override over the strong
	// slot — and there is no factory floor; when both are empty the turn
	// refuses honestly with the machine-readable 503 envelope (new sessions
	// and continuing ones alike — wake-pipeline turns ride this same path).
	// Placement is deliberate: BEFORE beginTurn (no liveness effects), the
	// write-ahead persist (nothing durable changes), and every downstream
	// resolution (jobs/extraction gate per-need on their own tiers).
	const effective = effectiveSettings();
	const conversation = resolveConversationSpec(record.settings, effective.models.strong);
	if (!conversation) {
		const envelope = modelsNotConfigured(["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	// THE KEY-PRESENCE GATE (provider-key interlude, owner, 2026-09-25): a
	// pinned model is not enough — its PROVIDER's key must be present, or
	// the turn dies mid-stream masked to a generic error. Truth is env-first
	// (providerKeyPresent reads what pi-ai would read at request time), so
	// an env-shadowed key passes. Same placement discipline as the models
	// gate: BEFORE beginTurn (no liveness effects) and the write-ahead
	// persist (nothing durable changes); wake-pipeline turns ride the same
	// path. The affected tier is strong — the conversation chain's own tier
	// (a chat.model override still resolves through it).
	if (isSubscriptionProvider(conversation.provider)) {
		await refreshConnectionCatalog(conversation.provider);
		if (input.type === "steers" && !connectionBackgroundAllowed(conversation.provider)) {
			return Response.json({ error: "Background use is off for this connection. Automatic follow-up remains deferred in its queue." }, { status: 403 });
		}
	}
	if (!providerKeyPresent(conversation.provider)) {
		const envelope = providerKeyMissingEnvelope(conversation.provider, ["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	// THE COMPACTION GATE (owner round 14, 2026-10-05 — the structural
	// ruling: NOTHING model-facing for this chat interleaves with a
	// running compaction): await any in-flight compaction (the settle
	// kick usually finished inside the learner's answer pause), and if
	// the record is STILL over threshold, compact synchronously — this
	// request waits. Skipped under tests (the extraction precedent);
	// placement mirrors the BYOK/key gates — BEFORE appends and
	// beginTurn, no liveness effects — and the record re-reads after
	// because compaction appends the marker.
	const callPurpose = { background: input.type === "steers" || (input.type === "continue" && reconstructRequestCause(record.messages) !== "foreground") };
	let requestCycle: SubscriptionRequestCycle | undefined;
	const lifecycle: SubscriptionDispatchLifecycle = {
		captured: (scope) => requestCycle?.captured(scope),
		beforeDispatch: (scope) => requestCycle?.beforeDispatch(scope),
		didDispatch: (scope) => requestCycle?.didDispatch(scope),
		noDispatch: (kind) => requestCycle?.noDispatch(kind),
	};
	let conversationEngine: PiEngine;
	try { conversationEngine = piEngineForSpec(conversation, () => callPurpose.background, lifecycle); }
	catch { return Response.json({ error: conversation.provider === "chatgpt" ? chatGPTStreamError("model catalog") : isSubscriptionProvider(conversation.provider) ? nativeSubscriptionError(conversation.provider, "model catalog") : "The selected model is unavailable." }, { status: 503 }); }
	const modelIdForCompaction = `${conversationEngine.model.provider}:${conversationEngine.model.id}`;
	await ensureCompacted(
		{
			chatStore: stores.chatStore,
			engine: piEngineForSpec(conversation, true),
			canStart: () => connectionBackgroundAllowed(conversation.provider),
			modelId: modelIdForCompaction,
			kind: record.kind === "reading" ? "reading" : record.kind === "practice" ? "practice" : hasProbeDone(record.messages) ? "teach" : "probe",
			thresholdTokens: effectiveThresholdTokens(
				effective.compaction?.thresholdTokens,
				catalogContextLimits().get(modelIdForCompaction),
			),
			systemPromptTokens: Math.ceil((composeInstructions(record.kind === "reading" ? "reading" : record.kind === "practice" ? "practice" : "teacher").length + (record.kind === "reading" ? readingSessionContext(record.messages).length : 0)) / 4),
		},
		chatId,
	);
	// Validation, turn ownership and the durable prefix share deletion's
	// per-chat gate. No model request runs while this gate is held.
	const prefix = await withChatWrite(chatId, async () => {
		if (isStorageStopping()) return storageMutationResponse()!;
		const current = await stores.chatStore.getChat(chatId);
		if (isStorageStopping()) return storageMutationResponse()!;
		if (!current || current.deleting) return Response.json({ error: "Unknown chat" }, { status: 404 });
		if (tracksInterruptedTurns && current.pendingTurnId && (input.type === "continue" || input.type === "steers")) {
			return Response.json({ error: "This turn was interrupted. Retry explicitly to continue." }, { status: 409 });
		}
		let retryOmissions = new Set<string>();
		let appends;
		try {
			if (input.type === "retry") {
				try { retryOmissions = retryDrops(current.messages); }
				catch (error) { if (!(tracksInterruptedTurns && current.pendingTurnId)) throw error; }
			}
			appends = input.type === "steers"
				? input.steers.filter((steer) => !steerDelivered(current.messages, steer.id))
				: inputAppends(current, input);
		} catch (error) {
			if (error instanceof ChatInputError) return Response.json({ error: error.message }, { status: 400 });
			throw error;
		}
		const merged = [...current.messages, ...appends];
		if (input.type === "answer" && danglingQuestionOf(merged) !== null) {
			try { await stores.chatStore.appendMessages(chatId, appends); }
			catch (error) {
				console.error(`[chat ${chatId}] write-ahead persist failed:`, error);
				return new Response("Your input could not be saved. Please try again.", { status: 500 });
			}
			emit("record-changed", { chatId });
			return settledTurnResponse();
		}
		if (!beginTurn(chatId)) return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
		registerPendingTurnAbort(chatId, () => preparing.abort());
		const agentMessages = input.type === "retry" ? merged.filter((message) => !retryOmissions.has(message.id)) : merged;
		const stagedAutomatic = isSubscriptionProvider(conversation.provider) && input.type === "steers";
		try {
			if (tracksInterruptedTurns) await stores.chatStore.setPendingTurn(chatId, turnUsageId);
			if (!stagedAutomatic) await stores.chatStore.appendMessages(chatId, appends);
		} catch (error) {
			console.error(`[chat ${chatId}] write-ahead persist failed:`, error);
			unregisterPendingTurnAbort(chatId);
			endTurn(chatId);
			return new Response("Your input could not be saved. Please try again.", { status: 500 });
		}
		if (!stagedAutomatic) await noteSteersDurable(chatId, merged);
		if (preparing.signal.aborted || isStorageStopping()) {
			unregisterPendingTurnAbort(chatId);
			rememberTurnFailure(chatId, "This turn was interrupted. Retry explicitly to continue.");
			endTurn(chatId);
			return Response.json({ error: "The turn stopped before the model request." }, { status: 409 });
		}
		return { record: current, appends, merged, agentMessages, stagedAutomatic };
	});
	if (prefix instanceof Response) return prefix;
	record = prefix.record;
	const { appends, merged, agentMessages, stagedAutomatic } = prefix;
	let persistBaseCount = stagedAutomatic ? record.messages.length : agentMessages.length;

	// MONEY CHANNEL (wave 4): one collector per request, fed by the agent's
	// message_end events. Every model call's usage lands in the chat record's
	// append-only turns log at onFinish — idempotent per turn id.
	const steps: CallUsage[] = [];
	const collectUsage = (usage: Usage) => {
		steps.push({
			inputTokens: usage.input,
			outputTokens: usage.output,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
			// Optional in pi's Usage — persisted as 0, never dropped.
			reasoningTokens: usage.reasoning ?? 0,
		});
	};

	// AGENT CONSTRUCTION BRANCH (docs/probe-teach-split.md §2): the transcript
	// is the seam — a probe_done call in the record means the probe is
	// concluded: build the TEACHER (planning + the full toolset). Otherwise
	// the session is still probing: build the PROBER (quiz/ask + probe_done).
	// Both share this whole composition (write-ahead persist, liveness,
	// steers, usage, extraction) — only the agent differs.
	const teaching = hasProbeDone(agentMessages);
	// BYOK (owner, 2026-09-22): the conversation chain was resolved by the
	// turn gate above (chat.model override → strong slot → refused) — the
	// engine build is pure from here; thinking levels clamp natively.
	// (Built once above the compaction gate; reused verbatim.)
	const engine = conversationEngine;
	// Provider-qualified stamp (model slots wave): matches the price table's
	// provider:id keys.
	const modelId = `${engine.model.provider}:${engine.model.id}`;
	// Tests inject a factory: the agent is stateless per turn, so each
	// request builds a fresh one off the record — the factory mirrors that
	// seam exactly. Wave B: the record IS the agent state (native messages;
	// the record's id field strips at the wire in toLlmMessages).
	// CROSS-STREAM SEAM (P2 reconciliation, 2026-09-19): `toolToggles`
	// rides the build opts as the user-level DELTA map (absent key =
	// enabled). The definitive toggleable set is TOGGLEABLE_TOOLS — the
	// sub-agent JOB tools (research/demo/visual/pdf; adjudicated with the
	// user: quiz/ask/fs/plan/probe_done are always-on).
	try {
		if (isSubscriptionProvider(conversation.provider)) requestCycle = new SubscriptionRequestCycle({
			initialMessages: asAgentMessages(agentMessages),
			staged: stagedAutomatic ? asAgentMessages(appends) : undefined,
			foregroundOwed: !callPurpose.background,
			purpose: callPurpose,
			scopeCurrent: (scope) => connectionScopeCurrent(conversation.provider, scope),
			commitStaged: async () => {
				await stores.chatStore.appendMessages(chatId, appends);
				persistBaseCount = merged.length;
				await noteSteersDurable(chatId, merged);
			},
			restoreAutomatic: (automaticIds, retainedIds) => restoreUncommittedAutomatic(chatId, constructed, automaticIds, retainedIds),
		});
		const agentOpts: AgentBuildOptions = {
			engine,
			callPurpose,
			requestCycle,
			messages: asAgentMessages(agentMessages),
			onUsage: collectUsage,
			toolToggles: effective.agent.tools,
			// Debug (owner, 2026-10-04): teacher/prober raw provider events under
			// LH_PROVIDER_EVENTS=1 (provider-events.ts); no-op otherwise.
			chatId,
			// The prompt-override switches (P2, 2026-09-19): same resolution
			// point as the tool delta — the agent layer composes the system
			// prompt fresh per turn, swapping in any enabled override segments.
			promptSwitches: effective.agent.prompts,
			...(record.kind === "reading" ? { readingContext: readingSessionContext(merged) } : {}),
		};
		// PRACTICE BRANCH (owner design, 2026-10-04): a kind:"practice"
		// session builds the practitioner from turn 1 — no prober→teacher
		// split, no plan/question/job tools; the whole registry is
		// problem + conclude. buildAgent stays honored (the test seam is
		// uniform across kinds).
		const constructed: TeachingAgent = buildAgent
			? buildAgent({ ...agentOpts, teaching })
			: record.kind === "reading"
				? createReadingAgent({ chatId, chatStore: stores.chatStore,
					loadSource: createReadingSourceLoader(stores.readingSourceStore, { chatStore: stores.chatStore }),
					...(graphToolsEnabled(effective) ? { graphStore: stores.graphStore } : {}),
				}, agentOpts)
			: record.kind === "practice"
				? createPracticeAgent(
						{
							chatId,
							chatStore: stores.chatStore,
							// TARGET VALIDATION (owner round 9): the practice tools read the
							// WHOLE graph fresh per pose — targets validate against every
							// proposition, not just the session's picks (pickless sessions
							// and future graph-tools poses stay valid).
							graphNodes: () => stores.graphStore.readNodes(),
							// THE RARELY-NEEDED SET (owner round 10): research + pdf jobs
							// (same runner/gating as the teacher's — research honestly
							// absent when no engine is live) and the map readers behind
							// the SAME settings gate as the prober's.
							jobs: {
								chatId,
								jobStore: stores.jobStore,
								spawn: (job, input) => void jobRunner.runJob(job.id, input),
								searchAvailable,
							},
							...(graphToolsEnabled(effective) ? { graph: { chatStore: stores.chatStore, graphStore: stores.graphStore } } : {}),
						},
						agentOpts,
					)
				: teaching
				? createTeacherAgent(
						{
							chatId,
							chatStore: stores.chatStore,
							jobStore: stores.jobStore,
							spawn: (job, input) => void jobRunner.runJob(job.id, input),
							// The registry drop's signal (2026-09-20): no live engine
							// = no research tool in the teacher's registry.
							searchAvailable,
						},
						agentOpts,
					)
				: createProberAgent(
						{
							chatId,
							chatStore: stores.chatStore,
							deliver: (steer) => void deliverJobResult(steer),
							// Fix wave (2026-09-20): the prober carries research + pdf
							// dispatch (owner ruling — phase-omnipresent), so its ctx
							// needs the same job wiring as the teacher's.
							jobStore: stores.jobStore,
							spawn: (job, input) => void jobRunner.runJob(job.id, input),
							searchAvailable,
							// The map reader (wave 7): the prober reads the learner's
							// knowledge graph through tools when the gate opens —
							// graph master switch AND the agent.graphTools toggle.
							...(graphToolsEnabled(effective) ? { graphStore: stores.graphStore } : {}),
						},
						agentOpts,
					);

		// A test-injected agent gets no usage collector (tests assert the
		// transcript, not the money channel); when it's ours, usage flows through
		// the factory's subscription (wired above via onUsage).
		// THE TURN AS A BACKGROUND OBJECT (owner ruling, 2026-09-25):
		// runPiTurn executes decoupled from this response — the POST stream
		// is just the FIRST subscriber (a view). A client disconnect can no
		// longer abort the turn; the remote kill is the abort channel, and
		// late views reattach via GET /api/chats/[id]/stream.
		// Wave C (owner correction, 2026-09-26 — steering): register the live
		// agent BEFORE runPiTurn — the loop's start steering-poll drains the
		// queue SYNCHRONOUSLY inside that call, so a later registration would
		// miss it. Registration also steers any pending registry markers into
		// this run: a marker parked behind a just-answered quiz rides THIS
		// run's first LLM call (the native replacement for continuation
		// coalescing). Settlement still cannot beat the flow below: it needs
		// a streamed response, which never happens inside the constructor.
		await registerLiveAgent(chatId, constructed, input.type !== "steers" && input.type !== "continue",
			input.type === "steers" ? new Set(appends.map((message) => message.id)) : undefined);
		if (isStorageStopping()) throw new StorageStoppingError();
		preparing.signal.throwIfAborted();
		// Debug recorder run marker (owner, 2026-10-04): correlates the
		// JSONL event stream with the record's turns; no-op unless
		// LH_PROVIDER_EVENTS=1.
		providerEventNote(chatId, "turn", `run start (base: ${agentMessages.length} messages)`);
		const handle = runPiTurn({
			agent: constructed,
			requestCycle,
			// The coalescing window seam (COMPACTION LAW, 2026-10-09): tests
			// tighten it via LH_UPDATE_FLUSH_MS; production rides the 100ms
			// default in ui-stream.
			...(process.env.LH_UPDATE_FLUSH_MS ? { updateFlushMs: Number(process.env.LH_UPDATE_FLUSH_MS) } : {}),
			// THE LACAN FIX (2026-10-04): seed the uniquifier with every
			// tool-call id the record already holds — a provider that resets
			// ids per response (DeepSeek) then gets fresh unique ids for this
			// turn's calls at the wire boundary, on the wire, in the record,
			// and in the next turn's context alike.
			usedToolCallIds: new Set(collectToolCallIds(merged)),
			// Stream-level failures are provider/transport internals — masked,
			// like the SDK defaults. Tool-input validation messages never
			// route through here: they ride the error-result path and reach the
			// transcript directly (the retry context the model saw).
			onError: (error) => {
				if (conversation.provider === "chatgpt") return chatGPTStreamError(String(error));
				if (isSubscriptionProvider(conversation.provider)) return nativeSubscriptionError(conversation.provider, String(error));
				console.error(`[chat ${chatId}] turn error:`, error);
				return "An error occurred.";
			},
			onSettleError: settlementErrorText,
			onSettleFailure: async (error, reportedErrorText) => {
				// POST only acknowledges acceptance; the submitter may attach
				// after this turn has already failed and left the registry.
				rememberTurnFailure(chatId, reportedErrorText ?? settlementErrorText(error));
				endTurn(chatId);
				unregisterTurn(chatId);
				unregisterLiveAgent(chatId);
				// The canonical save may have succeeded before later bookkeeping
				// threw. Reconcile against actual durability, never replay input
				// merely because usage/extraction/other settlement work failed.
				const persisted = (await stores.chatStore.getChat(chatId))?.messages ?? [];
				reconcileUserSteers(chatId, persisted);
				settleSteers(chatId, persisted, true, constructed);
			},
			onFinish: async (turnMessages, isAborted, didFail) => {
				// Wave B: append only messages past the temporary agent prefix.
				// Retry's saved record still includes its earlier failed attempts.
				const stamped = await persistTurn(stores.chatStore, chatId, persistBaseCount, turnMessages, isAborted);
				await noteSteersDurable(chatId, (await stores.chatStore.getChat(chatId))?.messages ?? stamped);
				// usage log append (idempotent per turn id) — the stats bar
				// refolds this on the client after the turn settles. The
				// provenance message is the turn's FIRST new assistant message.
				const response = stamped.find((m) => (m as { role?: string }).role === "assistant");
				if (response && steps.length > 0) {
					await stores.chatStore.appendTurnUsage(chatId, {
						id: turnUsageId,
						messageId: response.id,
						at: new Date().toISOString(),
						model: modelId,
						steps,
					});
				}
				// GRAPH GATE (settings-storage wave, 2026-09-19): the write channel —
				// extraction, its auditor — dies with the master switch.
				// PRACTICE (owner, 2026-10-04): practice sessions write nothing —
				// no extraction, no graph, no coverage (v1: the session itself
				// is the deliverable).
				if ((!requestCycle || requestCycle.dispatched) && record.kind !== "practice" && extractionEnabled(effective.graph)) {
					// Fresh per-turn read of the graph section's chunk budget
					// (extraction-UX redesign, 2026-09-24): the trigger compares
					// against it and the pipeline's batches share it.
					void triggerExtraction(stores, extraction, chatId, effective.graph.extractionChunkTokens);
				}
				// PARKED DISMISSAL (owner, 2026-10-04): a dismissal that arrived
				// mid-turn was parked by the dismiss route (202); now that
				// persistTurn has landed the turn's messages, apply it against
				// real truth — BEFORE endTurn, so "turn-settled" guarantees a
				// subsequent fetch reads the dismissal already in the record
				// (the same ordering law as persistTurn itself).
				await withChatWrite(chatId, async () => {
					// A concurrent dismissal must either join this park before we
					// apply it, or see the fully settled turn after this gate opens.
					await applyParkedDismissal(stores.chatStore, chatId);
					if (tracksInterruptedTurns && !isAborted && !didFail && !isStorageStopping() && (!requestCycle || requestCycle.dispatched)) {
						await stores.chatStore.setPendingTurn(chatId, null);
					}
					endTurn(chatId);
					unregisterTurn(chatId);
					unregisterLiveAgent(chatId);
				});
				settleSteers(chatId, stamped, false, constructed);
				// Composer steers (2026-10-03): delivered ids dropped, stranded
				// ones stay parked for the chat's next run (the registry is the
				// stranding safety net — the agent's undrained copy died above).
				reconcileUserSteers(chatId, stamped);
				// THE SETTLE KICK (owner round 14): the turn settled — if the
				// projection is now over threshold, the summary starts in the
				// background, INSIDE the learner's reading/answering pause
				// (question/problem poses end runs, so this moment is always a
				// between-runs window). The next turn's ensureCompacted gate
				// awaits whatever this leaves running; a lost engine or a
				// beneath-threshold record is a silent no-op. Skipped under
				// tests (the extraction precedent — scripted chats are
				// fixtures; the service itself is pinned directly).
				if (process.env.NODE_ENV !== "test" && (!requestCycle || requestCycle.dispatched))
					kickCompaction(async () => {
						const fresh = effectiveSettings();
						const spec = resolveConversationSpec((await stores.chatStore.getChat(chatId))?.settings, fresh.models.strong);
						if (!spec || !connectionBackgroundAllowed(spec.provider)) return null;
						let kickEngine: PiEngine;
						try { kickEngine = piEngineForSpec(spec, true); } catch { return null; }
						const kickModelId = `${kickEngine.model.provider}:${kickEngine.model.id}`;
						const freshRecord = await stores.chatStore.getChat(chatId);
						if (!freshRecord) return null;
						return {
							chatStore: stores.chatStore,
							engine: kickEngine,
							canStart: () => connectionBackgroundAllowed(spec.provider),
							modelId: kickModelId,
							kind: freshRecord.kind === "reading" ? "reading" : freshRecord.kind === "practice" ? "practice" : hasProbeDone(freshRecord.messages) ? "teach" : "probe",
							thresholdTokens: effectiveThresholdTokens(
								fresh.compaction?.thresholdTokens,
								catalogContextLimits().get(kickModelId),
							),
							systemPromptTokens: Math.ceil((composeInstructions(freshRecord.kind === "reading" ? "reading" : freshRecord.kind === "practice" ? "practice" : "teacher").length + (freshRecord.kind === "reading" ? readingSessionContext(freshRecord.messages).length : 0)) / 4),
						};
					}, chatId);
			},
		});
		// The turn is now a live background object: register it so any view
		// can reattach (GET /api/chats/[id]/stream) or remotely abort it
		// (POST /api/activity/abort, kind "turn"). Registration after the
		// runPiTurn call is race-free: the agent loop only ticks in later
		// microtasks, so settle (and thus unregister) cannot beat us here.
		registerTurn(chatId, handle);
		// CONNECTION DIET B (owner, 2026-10-10 — the parallel-session freeze
		// postmortem): the POST no longer holds the turn's SSE stream open for
		// its whole duration. It acknowledges acceptance and CLOSES; the
		// submitter attaches through GET /api/chats/[id]/stream — the same
		// universal reattach wire a returning visitor uses. The browser's
		// 6-connections-per-origin pool is the scarce resource: a submission
		// must cost zero permanently-held slots beyond the one live view. The
		// turn itself is a server-side process (ruling 2026-09-25) — it never
		// needed this connection, only a view did.
		if (stagedAutomatic && requestCycle && !(await requestCycle.admission)) return Response.json({ error: "Automatic follow-up remains deferred in its queue." }, { status: 403 });
		return Response.json({ ok: true });
	} catch (err) {
		// The stream never started, so no onFinish will fire — clear the registry
		// or a malformed request would lock the chat until the TTL eviction.
		unregisterPendingTurnAbort(chatId);
		endTurn(chatId);
		// Wave C: the live-agent registration (if it happened) dies with the
		// turn here too - nothing was handed (the loop never ticked).
		unregisterLiveAgent(chatId);
		if (tracksInterruptedTurns) rememberTurnFailure(chatId, "This turn was interrupted. Retry explicitly to continue.");
		if (err instanceof StorageStoppingError) return storageMutationResponse()!;
		console.error(`[chat ${chatId}] turn failed to start:`, err);
		return Response.json({ error: "Failed to start the turn" }, { status: 500 });
	}
}
