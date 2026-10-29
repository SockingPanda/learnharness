/**
 * Storage ports (the hexagonal seams — vision §1 "storage stays swappable").
 *
 * One port per ENTITY, with domain operations — never one generic
 * key/value interface. Core and the service layer that orbits it code
 * against these asynchronous types only; concrete file and Any adapters
 * live in src/store/ and are wired once per workspace, in
 * the composition root (src/server/stores.ts). Dependencies point one way:
 * adapters may import core; core NEVER imports an adapter.
 */

import type { LhMessage } from "./native-messages.ts";
import type {
	ChatRecord,
	ChatSettings,
	ChatSummary,
	GraphChain,
	GraphNode,
	JobKind,
	JobRecord,
	ExtractionRunUsage,
	PlanTree,
	Position,
	CoverageEntry,
	SessionCheckpoint,
	TurnUsage,
	NotesSource,
} from "./contracts.ts";
import type { UserSettings } from "./settings.ts";
import type { ReadingArchive } from "./reading.ts";

/** Immutable original source per reading session. */
export interface ReadingSourceStore {
	save(chatId: string, input: {
		kind: "web" | "pdf";
		originalUrl?: string;
		originalPath?: string;
		resolvedUrl?: string;
		content: Uint8Array;
	}): Promise<ReadingArchive>;
	get(chatId: string): Promise<{ archive: ReadingArchive; content: Uint8Array } | null>;
	delete(chatId: string): Promise<void>;
}

// ─── ChatStore — the session record's home (data/chats) ─────────────────────

export interface ChatDeletion {
	mode: "preserve-graph" | "delete-nodes";
	operationId: string;
	startedAt: string;
}

export interface ChatStore {
	/** Persist an unfinished request receipt; recovery must not replay it automatically. */
	setPendingTurn(id: string, turnId: string | null): Promise<void>;
	/** Atomically change one artifact presentation flag without replacing history. */
	setMessageInverted(id: string, messageId: string, inverted: boolean): Promise<boolean>;
	/** Append only new native IDs; identical replay is a no-op, conflicting IDs reject. */
	appendMessages(id: string, messages: LhMessage[]): Promise<void>;
	/** Durable deletion barrier: normal writes must refuse after this succeeds. */
	beginDeletion(id: string, deletion: ChatDeletion): Promise<void>;
	listDeletingChats(): Promise<ChatRecord[]>;
	/** Create a session record (persisted immediately). */
	/** Create a practice or reading session; absent kind defaults to teach. */
	createChat(title: string, kind?: "practice" | "reading"): Promise<ChatRecord>;
	/** The full record, or null if unknown id / corrupt file. */
	getChat(id: string): Promise<ChatRecord | null>;
	/** All sessions, newest activity first (the sidebar's list view). */
	listChats(): Promise<ChatSummary[]>;
	/** Persist the full native message list (the record IS the agent
	 * state — Wave B, owner-approved 2026-09-26). */
	saveMessages(id: string, messages: LhMessage[]): Promise<void>;
	/** Persist the session plan tree (plan tools call this in execute). */
	saveTree(id: string, tree: PlanTree): Promise<void>;
	/** Append one usage entry to the record's turn log (the money channel,
	 * 2026-09): idempotent per turn id — each request carries its own, so
	 * a turn persisted twice appends once while continuation turns (which
	 * share a response message id) each keep their usage. */
	appendTurnUsage(id: string, entry: TurnUsage): Promise<void>;
	/** Append one extraction-run usage entry — idempotent per startedAt. */
	appendExtractionUsage(id: string, entry: ExtractionRunUsage): Promise<void>;
	/** Persist the per-chat model/thinking settings (the model control).
	 *  Replace-whole: the picker sends the complete settings object. */
	saveSettings(id: string, settings: ChatSettings): Promise<void>;
	/** Rename a session (the header's click-to-edit title, 2026-09-17).
	 * Like saveSettings: a rename is NOT conversation activity — updatedAt
	 * stays put, so sidebar order never churns on a rename. */
	renameChat(id: string, title: string): Promise<ChatRecord>;
	/** Delete the session record entirely (session-deletion wave 6, owner
	 *  2026-09-22). False when the id is unknown. The graph-ledger purge and
	 *  job cleanup are the caller's choreography (core/graph-deletion.ts +
	 *  the DELETE route), not the store's. */
	deleteChat(id: string): Promise<boolean>;
}

// ─── GraphStore — the append-only evidence ledgers (data/graph) ──────────────
// Chains are the stored truth (owner, 2026-09-30): nodes + reasoning
// chains; edges are a DERIVED view (core/graph.ts) and never touch this
// seam. Reads return the raw append-order lines; merging chain assertions
// by (premises, conclusion) is DERIVED in core/graph.ts — the store never
// decides. The extraction pipeline is the sole writer; this read surface
// stays.

export interface GraphLedgers {
	nodes: GraphNode[];
	chains: GraphChain[];
	coverage: CoverageEntry[];
	checkpoints: SessionCheckpoint[];
}

export interface GraphLedgerSnapshot extends GraphLedgers {
	positions: Record<string, Position>;
	sources: NotesSource[];
	revision: string;
}

/** One replay-safe graph operation. Append and replace cannot target the same ledger. */
export interface GraphCommit {
	operationId: string;
	append?: Partial<GraphLedgers>;
	replace?: Partial<GraphLedgers>;
	positions?: Record<string, Position>;
}

/** Synchronous views are only for in-memory domain calculations and fixtures. */
export type SyncStore<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Awaited<R> : T[K] };

/** Only synchronous operations used by detached graph calculations. */
export type GraphMemoryStore = Omit<SyncStore<GraphStore>, "readSnapshot" | "commitBatch" | "getRevision">;

export interface GraphStore {
	readSnapshot(): Promise<GraphLedgerSnapshot>;
	commitBatch(batch: GraphCommit): Promise<void>;
	getRevision(): Promise<string>;
	/** Append one node assertion; repeated logical IDs retain separate evidence. */
	appendNode(node: GraphNode): Promise<void>;
	/** Raw node lines in append order. */
	readNodes(): Promise<GraphNode[]>;

	/** Append one chain ASSERTION (a second session asserting the same
	 *  (premises, conclusion) appends another line; readers merge). */
	appendChain(assertion: GraphChain): Promise<void>;
	readChains(): Promise<GraphChain[]>;

	/** Append one emission checkpoint. */
	appendCheckpoint(checkpoint: SessionCheckpoint): Promise<void>;
	readCheckpoints(): Promise<SessionCheckpoint[]>;
	/** Message-granular extraction coverage (vision-extraction-coverage.md):
	 *  append-only; one line per covered message. The chat-extraction
	 *  checkpoint — "uncovered" is derived from these, never tracked. */
	appendCoverage(entry: CoverageEntry): Promise<void>;
	readCoverage(): Promise<CoverageEntry[]>;

	/** Append one cluster-naming run's usage (graph-global money channel) —
	 *  idempotent per startedAt. */

	/** Upsert one imported-notes source record (config.SOURCES_FILE — a
	 *  JSON map, not a ledger; an upsert keeps the existing usage log). */
	upsertSource(source: NotesSource): Promise<void>;
	/** Every notes source record, by id order-insensitive. */
	readSources(): Promise<NotesSource[]>;
	/** Append one run's usage to a source record — idempotent per
	 *  startedAt, mirroring ChatRecord.extractions. */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): Promise<void>;

	/** The layout ledger (config.POSITIONS_FILE): nodeId → resting {x,y}.
	 *  WRITTEN ONLY by the incremental settle after a merge (core/layout.ts
	 *  settleGraphLayout) — read-only for everything else. */
	readPositions(): Promise<Record<string, Position>>;
	/** Replace the whole ledger (the settle is a full-graph computation). */
	writePositions(positions: Record<string, Position>): Promise<void>;

	/** THE DESTRUCTIVE SEAM (session-deletion wave 6, owner 2026-09-22 —
	 *  the first non-append operation on these ledgers): atomically
	 *  replace the full contents of any subset of the six rewritable
	 *  ledgers. Each provided array is written to a temp file and renamed
	 *  over the ledger (crash-safe: a torn write never replaces the
	 *  original); absent keys leave their ledger untouched. The pure
	 *  computation is core/graph-deletion.ts — the store only makes the
	 *  replacement atomic. */
	rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
	}): Promise<void>;
}

// ─── JobStore — background sub-agent jobs (data/jobs) ─────────────────────────

export interface CreateJobInit {
	kind: JobKind;
	chatId: string;
	toolCallId: string;
	/** First activity line (defaults to "starting"). */
	activity?: string;
	/** Saved on the job before its worker is spawned. */
	input?: unknown;
}

/** Mergeable fields — identity (id, kind, chatId, toolCallId, createdAt) is immutable. */
export type JobPatch = Partial<Omit<JobRecord, "id" | "kind" | "chatId" | "toolCallId" | "createdAt">>;

export interface JobStore {
	/** Create a running job (keyed by toolCallId for spawn dedup). */
	createJob(init: CreateJobInit): Promise<JobRecord>;
	getJob(id: string): Promise<JobRecord | null>;
	/** Merge a patch into the record; null if unknown id. */
	updateJob(id: string, patch: JobPatch): Promise<JobRecord | null>;
	/** All jobs for a chat, newest activity first. */
	listJobs(chatId: string): Promise<JobRecord[]>;
	/** The job fulfilling a given tool part, if any (spawn-hook dedup). */
	findJobByToolCallId(chatId: string, toolCallId: string): Promise<JobRecord | null>;
	/** Delete every job record for a chat — running or finished (session-
	 *  deletion wave 6). Returns how many files were removed. The deletion
	 *  route refuses while jobs are still running, so by the time this
	 *  fires every record is terminal. */
	deleteJobsForChat(chatId: string): Promise<number>;
}

// ─── SettingsStore — THE user settings record (settings-storage wave, 2026-09-19) ──

/**
 * The one record for every non-secret product preference (core/settings.ts
 * UserSettings — delta semantics, see that module's doc). The store is
 * replace-whole on the RECORD; per-section scoping is a server-band concern
 * (single process, no stale-client hazard to defend against at this seam).
 * Schema-version lazy migration happens inside readSettings, never in
 * the callers. (The legacy default-settings.json fold died with the chat
 * section — per-session models, owner 2026-09-28.)
 */
export interface SettingsStore {
	/** The sanitized record, or null when none exists yet (first boot). */
	readSettings(): UserSettings | null;
	/** Persist the record (replace-whole). Callers pass a SANITIZED record. */
	writeSettings(settings: UserSettings): void;
}

// ─── PromptOverrideStore — per-segment system-prompt overrides (2026-09-19) ──

/**
 * User text overriding ONE source prompt segment (the shared base or one
 * numeric fragment), stored at the data-dir seam mirroring the source
 * layout (config.PROMPTS_OVERRIDE_DIR). File presence is NOT the override:
 * the settings record's agent.prompts switch is the explicit on/off, so a
 * user can keep a customized file on disk while running the source default.
 * The segment LIST is always derived from source at runtime — see the
 * adapter (src/store/prompt-overrides.ts) for the loader rules.
 */
export interface PromptOverrideStore {
	/** Every override path currently on disk ("system-prompt.md",
	 *  "teacher/20-teaching.md", ...), POSIX-relative, sorted. */
	listOverrides(): string[];
	/** The override text, or null when the path has no file. */
	readOverride(segmentPath: string): string | null;
	/** Persist override text for a segment path (creates parents). */
	writeOverride(segmentPath: string, text: string): void;
	/** Remove the override file, if present (switches are untouched — an
	 *  on-switch with no file composes the source default, inert). */
	deleteOverride(segmentPath: string): void;
}

// ─── AuthStore — BYOK provider keys (auth-keys wave, 2026-09-19) ────────────

/**
 * The long-standing flat {VAR: value} auth.json map (config.AUTH_FILE) —
 * the same file the Electron app has always hand-edited, now first-class
 * server-managed. Values are opaque strings: shape validation is a
 * server-band concern (core/auth-keys.ts validateKeyShape — the store
 * persists what it is given); env precedence is a server-band concern
 * too (src/server/keys.ts). Unknown vars ride along verbatim.
 */
export interface AuthStore {
	/** The whole map — absent or corrupt file = {} ("no keys yet", the
	 *  documented first-boot state). Never throws. */
	authVars(): Record<string, string>;
	/** Set one VAR (atomic write, mode 0600 always, other vars preserved). */
	setAuthVar(name: string, value: string): void;
	/** Remove one VAR if present (absent = no-op, still a silent success). */
	deleteAuthVar(name: string): void;
}

