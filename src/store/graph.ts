/**
 * GraphStore — the fs JSONL adapter: the append-only ledgers at
 * config.LEDGER_FILES (contracts.ts "v1 emission").
 *   nodes.jsonl     GraphNode        — one line per node write: the FIRST
 *                                      line for an id defines it; a later
 *                                      line with a REPEATED id is a
 *                                      link-append (session phrasings join
 *                                      aliases, provenance unions); reads
 *                                      merge by id (core/graph.ts getGraph)
 *   chains.jsonl    GraphChain       — one line per chain ASSERTION (a second
 *                                      session asserting the same
 *                                      (premises, conclusion) appends
 *                                      another line; readers merge)
 *   sessions.jsonl  SessionCheckpoint— emission checkpoints (foldedAt)
 *   coverage.jsonl  CoverageEntry    — per-message extraction coverage
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): there is NO edges ledger — the edge
 * view (implication nodes + untyped arrows) is derived in core/graph.ts on
 * every read and never persisted. Stale edges/events files from older
 * builds are retired on the next real write; importing this adapter is
 * side-effect free.
 *
 * Plus config.SOURCES_FILE (sources.json): the imported-notes bookkeeping
 * (NOT a ledger) — one JSON map, src-id → NotesSource, read-modify-write
 * like a chat file. The format-agnostic front door (2026-09-13).
 *
 * Implements core/ports.ts GraphStore. data/graph/* is exclusively this
 * adapter's. Reads are strict against the contracts.ts shapes (the 2026-09-02
 * graph redesign): corrupt lines are skipped, never guessed at — the ledgers
 * are the source of truth and everything else is derived (core/graph.ts,
 * which takes a detached snapshot). The asynchronous port serializes reads
 * and commits; a durable redo journal completes interrupted multi-file
 * writes before any reader can observe a partial batch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { LEDGER_FILES, POSITIONS_FILE, SOURCES_FILE } from "../../config.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import type {
	GraphChain,
	GraphNode,
	ExtractionRunUsage,
	NotesSource,
	Position,
	ProvenancePoint,
	CoverageEntry,
	SessionCheckpoint,
} from "../core/contracts.ts";
import type { GraphCommit, GraphLedgers, GraphLedgerSnapshot, GraphStore } from "../core/ports.ts";
import { atomicWriteFile, canonicalJson, fileStoreQueue, syncDirectory } from "./fs-atomic.ts";

// ─── JSONL primitives ────────────────────────────────────────────────────────

function readRawLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return []; // no ledger yet — nothing has ever been emitted
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// Corrupt line: skip rather than fail the whole read — a torn
			// append must never take the home graph down with it.
		}
	}
	return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Strict shape guards — anything not matching a W4 ledger shape is skipped. */
function readValid<T>(file: string, isValid: (v: unknown) => v is T): T[] {
	assertGraphFormat(); // honest refusal on a newer-stamped data dir
	return readRawLines(file).filter(isValid);
}

/** Provenance points are (chatId, messageId) pairs — message-granular. */
const isProvenancePoint = (v: unknown): v is ProvenancePoint =>
	isRecord(v) && isString(v.chatId) && isString(v.messageId);


const isGraphNode = (v: unknown): v is GraphNode =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

/** A chain line: premises ≥ 1 (a chain IS an argument — bare propositions
 *  ride the node ledger alone), every member a string, conclusion a string.
 *  Endpoint EXISTENCE is the derivation's concern (it drops dangling
 *  chains); the store only shapes. */
const isGraphChain = (v: unknown): v is GraphChain =>
	isRecord(v) &&
	isString(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isString) &&
	isString(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint) &&
	isString(v.createdAt);

const isCheckpoint = (v: unknown): v is SessionCheckpoint =>
	isRecord(v) && isString(v.chatId) && isString(v.foldedAt);

const isCoverageEntry = (v: unknown): v is CoverageEntry =>
	isRecord(v) && isString(v.chatId) && isString(v.fp) && typeof v.tokens === "number" && isString(v.foldedAt);

const graphDir = path.dirname(LEDGER_FILES.nodes);
const files = {
	nodes: LEDGER_FILES.nodes,
	chains: LEDGER_FILES.chains,
	coverage: LEDGER_FILES.coverage,
	checkpoints: LEDGER_FILES.sessions,
	positions: POSITIONS_FILE,
	sources: SOURCES_FILE,
} as const;
type GraphFile = keyof typeof files;
const ledgerKeys = ["nodes", "chains", "coverage", "checkpoints"] as const;
const queue = fileStoreQueue(graphDir);
const pendingFile = path.join(graphDir, ".pending-commit.json");

interface GraphJournal {
	version: 1;
	operationId: string;
	fingerprint: string;
	/** Absolute filenames are deliberately never accepted from the journal. */
	writes: Partial<Record<GraphFile, string>>;
}

function textIfPresent(file: string): string | null {
	try { return fs.readFileSync(file, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function receiptFile(operationId: string): string {
	return path.join(graphDir, ".commits", `${createHash("sha256").update(operationId).digest("hex")}.json`);
}

function hasReceipt(operationId: string): boolean {
	const raw = textIfPresent(receiptFile(operationId));
	if (raw === null) return false;
	const receipt: unknown = JSON.parse(raw);
	if (!isRecord(receipt) || receipt.version !== 1 || receipt.operationId !== operationId || !isString(receipt.fingerprint)) {
		throw new Error(`Graph operation receipt is invalid: ${operationId}`);
	}
	return true;
}

/** The journal contains final file images. Replaying never appends a batch twice. */
function finishCommit(journal: GraphJournal): void {
	ensureGraphFormat();
	for (const [key, body] of Object.entries(journal.writes) as [GraphFile, string][]) {
		atomicWriteFile(files[key], body);
	}
	atomicWriteFile(receiptFile(journal.operationId), JSON.stringify({
		version: 1, operationId: journal.operationId, fingerprint: journal.fingerprint,
	}));
	fs.unlinkSync(pendingFile);
	syncDirectory(graphDir);
}

function recoverCommit(): void {
	const raw = textIfPresent(pendingFile);
	if (raw === null) return;
	const pending: unknown = JSON.parse(raw);
	if (!isRecord(pending) || pending.version !== 1 || !isString(pending.operationId) || !pending.operationId ||
		!isString(pending.fingerprint) || !/^[a-f0-9]{64}$/.test(pending.fingerprint) || !isRecord(pending.writes) ||
		!Object.entries(pending.writes).every(([key, body]) => Object.hasOwn(files, key) && isString(body))) {
		throw new Error("Graph commit recovery journal is invalid; refusing to expose a partial graph.");
	}
	finishCommit(pending as unknown as GraphJournal);
}

function run<T>(work: () => T): Promise<T> {
	return queue.run(() => {
		assertGraphFormat();
		recoverCommit();
		return work();
	});
}

function commitFiles(operationId: string, fingerprint: string, writes: GraphJournal["writes"]): void {
	if (hasReceipt(operationId)) return;
	const journal: GraphJournal = { version: 1, operationId, fingerprint, writes };
	atomicWriteFile(pendingFile, JSON.stringify(journal));
	finishCommit(journal);
	// Legacy files are retired only on a real write, never while importing a
	// module during a Next build or reading an existing workspace.
	for (const name of ["edges.jsonl", "events.jsonl"]) fs.rmSync(path.join(graphDir, name), { force: true });
}

function commitBatch(batch: GraphCommit): void {
	if (!batch.operationId) throw new Error("A graph commit requires a stable operation id.");
	// A resumed delete may calculate a different draft after the first commit.
	// Its persisted operation ID names the intent; a receipt wins over the draft.
	if (hasReceipt(batch.operationId)) return;
	const fingerprint = createHash("sha256").update(canonicalJson(batch)).digest("hex");
	const writes: GraphJournal["writes"] = {};
	for (const key of ledgerKeys) {
		const added = batch.append?.[key];
		const replaced = batch.replace?.[key];
		if (added !== undefined && replaced !== undefined) throw new Error(`Cannot append and replace the same graph ledger: ${key}`);
		if (replaced !== undefined) writes[key] = jsonLines(replaced);
		if (added !== undefined && added.length > 0) {
			const before = textIfPresent(files[key]) ?? "";
			writes[key] = before + (before && !before.endsWith("\n") ? "\n" : "") + jsonLines(added);
		}
	}
	if (batch.positions !== undefined) writes.positions = JSON.stringify({ positions: batch.positions, updatedAt: new Date().toISOString() }, null, "\t");
	commitFiles(batch.operationId, fingerprint, writes);
}

function jsonLines(records: readonly unknown[]): string {
	return records.map((record) => JSON.stringify(record) + "\n").join("");
}

function revision(): string {
	const hash = createHash("sha256");
	for (const [key, file] of Object.entries(files)) {
		hash.update(key + "\0");
		hash.update(textIfPresent(file) ?? "");
		hash.update("\0");
	}
	return `fs:${hash.digest("hex")}`;
}

function snapshot(): GraphLedgerSnapshot {
	return {
		nodes: readValid(LEDGER_FILES.nodes, isGraphNode),
		chains: readValid(LEDGER_FILES.chains, isGraphChain),
		coverage: readValid(LEDGER_FILES.coverage, isCoverageEntry),
		checkpoints: readValid(LEDGER_FILES.sessions, isCheckpoint),
		positions: readPositionMap(), sources: Object.values(readSourceMap()), revision: revision(),
	};
}

function saveSources(sources: Record<string, NotesSource>): void {
	const body = JSON.stringify(sources, null, "\t");
	commitFiles(crypto.randomUUID(), createHash("sha256").update(body).digest("hex"), { sources: body });
}

export const graphStore: GraphStore = {
	readSnapshot: () => run(snapshot),
	getRevision: () => run(revision),
	commitBatch: (batch) => run(() => commitBatch(batch)),
	appendNode: (node) => run(() => commitBatch({ operationId: crypto.randomUUID(), append: { nodes: [node] } })),
	readNodes: () => run(() => readValid(LEDGER_FILES.nodes, isGraphNode)),
	appendChain: (chain) => run(() => commitBatch({ operationId: crypto.randomUUID(), append: { chains: [chain] } })),
	readChains: () => run(() => readValid(LEDGER_FILES.chains, isGraphChain)),
	appendCoverage: (entry) => run(() => commitBatch({ operationId: crypto.randomUUID(), append: { coverage: [entry] } })),
	readCoverage: () => run(() => readValid(LEDGER_FILES.coverage, isCoverageEntry)),
	appendCheckpoint: (entry) => run(() => commitBatch({ operationId: crypto.randomUUID(), append: { checkpoints: [entry] } })),
	readCheckpoints: () => run(() => readValid(LEDGER_FILES.sessions, isCheckpoint)),
	readPositions: () => run(readPositionMap),
	writePositions: (positions) => run(() => commitBatch({ operationId: crypto.randomUUID(), positions })),
	rewriteLedgers: (replace: Partial<GraphLedgers>) => run(() => commitBatch({ operationId: crypto.randomUUID(), replace })),
	readSources: () => run(() => Object.values(readSourceMap())),
	upsertSource: (source) => run(() => {
		const all = readSourceMap();
		const previous = all[source.id];
		all[source.id] = previous ? { ...source, extractions: previous.extractions } : source;
		saveSources(all);
	}),
	appendSourceUsage: (id, entry: ExtractionRunUsage) => run(() => {
		const all = readSourceMap();
		const source = all[id];
		if (!source || source.extractions?.some((run) => run.startedAt === entry.startedAt)) return;
		source.extractions = [...(source.extractions ?? []), entry];
		saveSources(all);
	}),
};

/** positions.json — { positions, updatedAt }. Read-modify-write, NOT
 *  append-only: the settle is a full-graph computation, so it replaces the
 *  whole map. The updatedAt stamp exists for future live-physics conflict
 *  handling (a browser commit must be able to detect "the graph changed
 *  underneath me"); reads just return the map. */
function readPositionMap(): Record<string, Position> {
	let raw: string;
	try {
		raw = fs.readFileSync(POSITIONS_FILE, "utf-8");
	} catch {
		return {}; // no ledger yet — nothing has ever settled
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || !isRecord(parsed.positions)) return {};
		const out: Record<string, Position> = {};
		for (const [id, value] of Object.entries(parsed.positions)) {
			if (isPosition(value)) out[id] = { x: value.x, y: value.y };
		}
		return out;
	} catch {
		return {};
	}
}

const isPosition = (v: unknown): v is Position =>
	isRecord(v) && typeof v.x === "number" && Number.isFinite(v.x) && typeof v.y === "number" && Number.isFinite(v.y);

/** sources.json — { id: NotesSource }. Read-modify-write, NOT append-only:
 *  the usage log lives inside the record (like a chat's JSON file). */
function readSourceMap(): Record<string, NotesSource> {
	assertGraphFormat(); // honest refusal on a newer-stamped data dir
	let raw: string;
	try {
		raw = fs.readFileSync(SOURCES_FILE, "utf-8");
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return {};
		const out: Record<string, NotesSource> = {};
		for (const [id, value] of Object.entries(parsed)) {
			if (isNotesSource(value)) out[id] = value;
		}
		return out;
	} catch {
		return {};
	}
}

const isNotesSource = (v: unknown): v is NotesSource =>
	isRecord(v) && isString(v.id) && isString(v.filePath) && isString(v.importedAt);
