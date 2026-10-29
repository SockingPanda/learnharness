import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	ChatStore,
	GraphStore,
	JobStore,
	ReadingSourceStore,
	GraphCommit,
	GraphLedgerSnapshot,
	GraphLedgers,
} from "../../core/ports.ts";
import type { ChatRecord, ChatSummary, JobRecord, NotesSource } from "../../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../../core/contracts.ts";
import { setSteerUiInverted } from "../../core/contracts/jobs.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../../core/native-messages.ts";
import { phaseAt3Lh } from "../../core/phases.ts";
import type { ReadingArchive } from "../../core/reading.ts";
import { AnyClient, digest, recordId, type AnyOptions, type StoredRow, type RowInput } from "./client.ts";
export type { AnyOptions, AnyChange } from "./client.ts";

const now = () => new Date().toISOString();
const ledgers = ["nodes", "chains", "coverage", "checkpoints"] as const;
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)]),
		);
	return value;
}
const valueKey = (value: unknown) => digest(JSON.stringify(canonical(value)));

type ArchiveState = { archive: ReadingArchive; fileId?: string; name: string };
type PendingGraph = { status: "pending"; operationId: string; writes: RowInput[] };

/** Single executing device: serialize materialization+write, never cache domain truth. */
export function createAnyStores(options: AnyOptions) {
	const db = new AnyClient(options);
	async function readOne<T>(id: string): Promise<T | null> {
		const rows = await db.rows({ id });
		return rows[0] ? db.value<T>(rows[0]) : null;
	}
	const chatKey = (id: string) => recordId("chat", id);
	async function chat(id: string): Promise<ChatRecord | null> {
		const meta = await readOne<Omit<ChatRecord, "messages">>(chatKey(id));
		if (!meta) return null;
		if ((meta.version ?? 0) > CURRENT_CHAT_VERSION) throw new Error("This session uses a newer schema.");
		const rows = await db.rows({ kind: "message", owner: id });
		return { ...meta, messages: await Promise.all(rows.map((row) => db.value<LhMessage>(row))) };
	}
	async function writableChat(id: string): Promise<ChatRecord> {
		const record = await chat(id);
		if (!record || record.deleting) throw new Error(`Session ${id} is missing or being deleted.`);
		return record;
	}
	async function chatRow(record: ChatRecord): Promise<RowInput> {
		const { messages: _messages, ...meta } = record;
		return db.row(chatKey(record.id), "chat", record.id, 0, { ...meta, version: CURRENT_CHAT_VERSION });
	}
	async function append(id: string, messages: LhMessage[]): Promise<void> {
		const record = await writableChat(id);
		const known = new Map(record.messages.map((message) => [message.id, message]));
		const writes: RowInput[] = [];
		let sequence = record.messages.length;
		for (const message of messages) {
			const previous = known.get(message.id);
			if (previous) {
				if (!isDeepStrictEqual(previous, JSON.parse(JSON.stringify(message))))
					throw new Error(`Conflicting native message ID ${message.id}.`);
				continue;
			}
			known.set(message.id, message);
			writes.push(
				await db.row(recordId("message", `${id}:${message.id}`), "message", id, sequence++, message),
			);
		}
		if (writes.length) {
			record.updatedAt = now();
			writes.push(await chatRow(record));
			await db.write(writes);
		}
	}
	async function editChat(id: string, edit: (record: ChatRecord) => void): Promise<ChatRecord> {
		const record = await writableChat(id);
		edit(record);
		await db.write([await chatRow(record)]);
		return record;
	}
	const chatStore: ChatStore = {
		createChat: (title, kind) =>
			db.run(async () => {
				const time = now();
				const record: ChatRecord = {
					id: `chat_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
					title: title.trim() || "Untitled session",
					createdAt: time,
					updatedAt: time,
					version: CURRENT_CHAT_VERSION,
					messages: [],
					...(kind ? { kind } : {}),
				};
				await db.write([await chatRow(record)]);
				db.notify({ chats: true });
				return record;
			}),
		getChat: (id) => db.run(() => chat(id)),
		listChats: () =>
			db.run(async () => {
				const rows = await db.rows({ kind: "chat" });
				const records = await Promise.all(rows.map((row) => db.value<ChatRecord>(row)));
				const result: ChatSummary[] = [];
				for (const metadata of records) {
					if (metadata.deleting) continue;
					const record = await chat(metadata.id);
					if (!record) continue;
					const { messages, tree: _tree, turns: _turns, extractions: _extractions, ...summary } = record;
					result.push({
						...summary,
						kind: record.kind ?? "teach",
						messageCount: messages.length,
						phase: phaseAt3Lh(messages),
						pendingQuestion: danglingQuestionOf(messages) !== null,
						pendingProblem: summary.kind === "practice" && activeProblemOf(messages) !== null,
					});
				}
				return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
			}),
		appendMessages: (id, messages) => db.run(() => append(id, messages)),
		// Compatibility for old callers: replacement may only extend native history.
		saveMessages: (id, messages) => db.run(() => append(id, messages)),
		setPendingTurn: (id, turnId) =>
			db.run(async () => {
				await editChat(id, (record) => {
					if (turnId === null) delete record.pendingTurnId;
					else record.pendingTurnId = turnId;
				});
			}),
		saveTree: (id, tree) =>
			db.run(async () => {
				await editChat(id, (record) => {
					record.tree = tree;
				});
			}),
		saveSettings: (id, settings) =>
			db.run(async () => {
				await editChat(id, (record) => {
					record.settings = settings;
				});
			}),
		renameChat: (id, title) =>
			db.run(async () => {
				const record = await editChat(id, (record) => {
					record.title = title.trim() || "Untitled session";
				});
				db.notify({ chats: true });
				return record;
			}),
		appendTurnUsage: (id, entry) =>
			db.run(async () => {
				await editChat(id, (record) => {
					if (!record.turns?.some((value) => value.id === entry.id))
						record.turns = [...(record.turns ?? []), entry];
				});
			}),
		appendExtractionUsage: (id, entry) =>
			db.run(async () => {
				await editChat(id, (record) => {
					if (!record.extractions?.some((value) => value.startedAt === entry.startedAt))
						record.extractions = [...(record.extractions ?? []), entry];
				});
			}),
		setMessageInverted: (id, messageId, inverted) =>
			db.run(async () => {
				const record = await writableChat(id);
				const before = record.messages.find((message) => message.id === messageId);
				const after = setSteerUiInverted(record.messages, messageId, inverted).find(
					(message) => message.id === messageId,
				);
				if (!before || !after || before === after) return false;
				const row = (await db.rows({ id: recordId("message", `${id}:${messageId}`) }))[0]!;
				await db.write([await db.row(row.id, row.kind, row.owner, row.seq, after)]);
				return true;
			}),
		beginDeletion: (id, deletion) =>
			db.run(async () => {
				const record = await chat(id);
				if (!record) return;
				if (record.deleting && record.deleting.mode !== deletion.mode)
					throw new Error("A different deletion is already in progress.");
				if (!record.deleting) {
					record.deleting = deletion;
					await db.write([await chatRow(record)]);
					db.notify({ chats: true });
				}
			}),
		listDeletingChats: () =>
			db.run(async () => {
				const result: ChatRecord[] = [];
				for (const row of await db.rows({ kind: "chat" })) {
					const record = await db.value<ChatRecord>(row);
					if (record.deleting) result.push((await chat(record.id))!);
				}
				return result;
			}),
		deleteChat: (id) =>
			db.run(async () => {
				const rows = await db.rows({ kind: "chat", owner: id });
				if (!rows.length) return false;
				const messages = await db.rows({ kind: "message", owner: id });
				await db.retire(messages);
				await db.retire(rows);
				await db.collectUnreferencedBlobs();
				db.notify({ chats: true });
				return true;
			}),
	};

	async function snapshot(): Promise<GraphLedgerSnapshot> {
		if ((await db.rows({ kind: "graph-pending" })).length)
			throw new Error("An incomplete graph commit requires recovery before graph reads.");
		const result: GraphLedgerSnapshot = {
			nodes: [],
			chains: [],
			coverage: [],
			checkpoints: [],
			sources: [],
			positions: {},
			revision: "empty",
		};
		const rows = await db.rows({ owner: "graph" });
		for (const row of rows) {
			if (ledgers.includes(row.kind as (typeof ledgers)[number]))
				(result[row.kind as keyof GraphLedgers] as unknown[]).push(await db.value(row));
			else if (row.kind === "graph-source") result.sources.push(await db.value<NotesSource>(row));
			else if (row.kind === "graph-positions") result.positions = await db.value(row);
			else if (row.kind === "graph-meta")
				result.revision = (await db.value<{ revision: string }>(row)).revision;
		}
		return result;
	}
	async function finishGraphCommit(pending: PendingGraph): Promise<void> {
		await db.write(pending.writes);
		const actual = new Map(
			(
				await db.rows({ id: { $in: pending.writes.map((row) => row.id) }, deleted: { $in: [false, true] } })
			).map((row) => [row.id, row]),
		);
		for (const expected of pending.writes) {
			const found = actual.get(expected.id);
			if (
				!found ||
				["kind", "owner", "seq", "json", "blob", "hash", "deleted"].some(
					(key) => found[key as keyof StoredRow] !== expected[key as keyof RowInput],
				)
			)
				throw new Error("Any graph batch was only partially applied; recovery is required.");
		}
		await db.write([
			await db.row(recordId("graph-receipt", pending.operationId), "graph-receipt", "receipts", 0, {
				status: "committed",
			}),
		]);
		db.notify({ graph: true });
		await db.retire(await db.rows({ owner: "graph", deleted: true }));
	}
	async function recoverGraphCommits(): Promise<void> {
		for (const row of await db.rows({ kind: "graph-pending" }))
			await finishGraphCommit(await db.value<PendingGraph>(row));
	}
	async function graphCommit(batch: GraphCommit): Promise<void> {
		if (!batch.operationId) throw new Error("A graph operation ID is required.");
		const receiptId = recordId("graph-receipt", batch.operationId);
		await recoverGraphCommits();
		const receipt = await readOne<{ status: string }>(receiptId);
		if (receipt) {
			await db.retire(await db.rows({ owner: "graph", deleted: true }));
			return;
		}
		const rows = await db.rows({ owner: "graph" });
		let sequence = Math.max(0, ...rows.map((row) => row.seq)) + 1;
		const writes: RowInput[] = [];
		let index = 0;
		for (const ledger of ledgers) {
			if (batch.append?.[ledger] && batch.replace?.[ledger])
				throw new Error("A batch cannot append and replace the same ledger.");
			const replacement = batch.replace?.[ledger];
			if (replacement) {
				const previous = rows.filter((row) => row.kind === ledger);
				const candidates = new Map<string, { row: StoredRow; index: number }[]>();
				for (let i = 0; i < previous.length; i++) {
					const row = previous[i]!;
					const key = valueKey(await db.value(row));
					const pool = candidates.get(key) ?? [];
					pool.push({ row, index: i });
					candidates.set(key, pool);
				}
				let lastIndex = -1;
				const retained = replacement.map((value) => {
					const candidate = candidates.get(valueKey(value))?.find((entry) => entry.index > lastIndex);
					if (candidate) lastIndex = candidate.index;
					return candidate?.row;
				});
				const kept = new Set(retained.filter((row) => row !== undefined).map((row) => row.id));
				for (const row of previous)
					if (!kept.has(row.id))
						writes.push({ ...row, json: "null", blob: "", hash: digest("null"), deleted: true });
				let before = 0;
				for (let i = 0; i < replacement.length; ) {
					if (retained[i]) {
						before = retained[i]!.seq;
						i++;
						continue;
					}
					let end = i;
					while (end < replacement.length && !retained[end]) end++;
					const after = retained[end]?.seq ?? before + end - i + 1;
					const step = (after - before) / (end - i + 1);
					for (let j = i; j < end; j++) {
						const seq = before + step * (j - i + 1);
						if (!(seq > before && seq < after))
							throw new Error("Graph entry order needs rebuilding before this replacement.");
						writes.push(
							await db.row(
								recordId("entry", `${batch.operationId}:${index++}`),
								ledger,
								"graph",
								seq,
								replacement[j],
							),
						);
					}
					i = end;
				}
			} else {
				for (const value of batch.append?.[ledger] ?? [])
					writes.push(
						await db.row(
							recordId("entry", `${batch.operationId}:${index++}`),
							ledger,
							"graph",
							sequence++,
							value,
						),
					);
			}
		}
		if (batch.positions)
			writes.push(await db.row("graph-positions", "graph-positions", "graph", 0, batch.positions));
		writes.push(await db.row("graph-meta", "graph-meta", "graph", 0, { revision: batch.operationId }));
		db.assertBatchSize(writes);
		const pending: PendingGraph = { status: "pending", operationId: batch.operationId, writes };
		// Persist the repair recipe before the change. A handler may reject a subset
		// despite HTTP 200; pending batches are never projected as covered knowledge.
		await db.write([await db.row(receiptId, "graph-pending", "receipts", 0, pending)]);
		await finishGraphCommit(pending);
	}
	const graphStore: GraphStore = {
		readSnapshot: () => db.run(snapshot),
		getRevision: () => db.run(async () => (await snapshot()).revision),
		commitBatch: (batch) => db.run(() => graphCommit(batch)),
		readNodes: () => db.run(async () => (await snapshot()).nodes),
		readChains: () => db.run(async () => (await snapshot()).chains),
		readCoverage: () => db.run(async () => (await snapshot()).coverage),
		readCheckpoints: () => db.run(async () => (await snapshot()).checkpoints),
		readPositions: () => db.run(async () => (await snapshot()).positions),
		readSources: () => db.run(async () => (await snapshot()).sources),
		appendNode: (node) => db.run(() => graphCommit({ operationId: randomUUID(), append: { nodes: [node] } })),
		appendChain: (chain) =>
			db.run(() => graphCommit({ operationId: randomUUID(), append: { chains: [chain] } })),
		appendCoverage: (entry) =>
			db.run(() => graphCommit({ operationId: randomUUID(), append: { coverage: [entry] } })),
		appendCheckpoint: (checkpoint) =>
			db.run(() => graphCommit({ operationId: randomUUID(), append: { checkpoints: [checkpoint] } })),
		writePositions: (positions) => db.run(() => graphCommit({ operationId: randomUUID(), positions })),
		rewriteLedgers: (replace) => db.run(() => graphCommit({ operationId: randomUUID(), replace })),
		upsertSource: (source) =>
			db.run(async () => {
				const id = recordId("graph-source", source.id);
				const previous = await readOne<NotesSource>(id);
				await db.write([
					await db.row(id, "graph-source", "graph", 0, {
						...source,
						...(previous?.extractions ? { extractions: previous.extractions } : {}),
					}),
				]);
				db.notify({ graph: true });
			}),
		appendSourceUsage: (id, entry) =>
			db.run(async () => {
				const key = recordId("graph-source", id);
				const source = await readOne<NotesSource>(key);
				if (!source || source.extractions?.some((value) => value.startedAt === entry.startedAt)) return;
				source.extractions = [...(source.extractions ?? []), entry];
				await db.write([await db.row(key, "graph-source", "graph", 0, source)]);
				db.notify({ graph: true });
			}),
	};

	async function jobs(chatId: string): Promise<JobRecord[]> {
		return Promise.all(
			(await db.rows({ kind: "job", owner: chatId })).map((row) => db.value<JobRecord>(row)),
		);
	}
	const jobStore: JobStore = {
		createJob: (init) =>
			db.run(async () => {
				await writableChat(init.chatId);
				const previous = (await jobs(init.chatId)).find((job) => job.toolCallId === init.toolCallId);
				if (previous) return previous;
				const time = now();
				const record: JobRecord = {
					id: `job_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
					kind: init.kind,
					chatId: init.chatId,
					toolCallId: init.toolCallId,
					status: "running",
					activity: init.activity ?? "starting",
					createdAt: time,
					updatedAt: time,
					...(init.input === undefined ? {} : { input: init.input }),
				};
				await db.write([await db.row(recordId("job", record.id), "job", record.chatId, 0, record)]);
				db.notify({ jobs: true, chatId: record.chatId });
				return record;
			}),
		getJob: (id) => db.run(() => readOne<JobRecord>(recordId("job", id))),
		updateJob: (id, patch) =>
			db.run(async () => {
				const record = await readOne<JobRecord>(recordId("job", id));
				if (!record) return null;
				await writableChat(record.chatId);
				const next = { ...record, ...patch, updatedAt: patch.updatedAt ?? now() };
				await db.write([await db.row(recordId("job", id), "job", record.chatId, 0, next)]);
				db.notify({ jobs: true, chatId: record.chatId });
				return next;
			}),
		listJobs: (chatId) =>
			db.run(async () => (await jobs(chatId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
		findJobByToolCallId: (chatId, toolCallId) =>
			db.run(async () => (await jobs(chatId)).find((job) => job.toolCallId === toolCallId) ?? null),
		deleteJobsForChat: (chatId) =>
			db.run(async () => {
				const rows = await db.rows({ kind: "job", owner: chatId });
				await db.retire(rows);
				if (rows.length) db.notify({ jobs: true, chatId });
				return rows.length;
			}),
	};

	async function readArchive(
		chatId: string,
	): Promise<{ archive: ReadingArchive; content: Uint8Array } | null> {
		const key = recordId("archive", chatId);
		const state = await readOne<ArchiveState>(key);
		if (!state) return null;
		const needsRegistration = !state.fileId;
		if (!state.fileId) {
			const files = await db.request<{ files: { fileId: string; name?: string }[] }>(
				`${db.prefix}/files?objectId=${db.location.objectId}&limit=0`,
			);
			const match = files.files.find((file) => file.name === state.name);
			if (!match)
				throw new Error("The saved reading source upload is incomplete. Retry with the original source.");
			state.fileId = match.fileId;
		}
		const content = await db.download(state.fileId);
		if (content.byteLength !== state.archive.byteLength || digest(content) !== state.archive.sha256)
			throw new Error("The saved reading source is damaged.");
		if (needsRegistration) await db.write([await db.row(key, "archive", chatId, 0, state)]);
		return { archive: state.archive, content };
	}
	const readingSourceStore: ReadingSourceStore = {
		get: (chatId) => db.run(() => readArchive(chatId)),
		save: (chatId, input) =>
			db.run(async () => {
				await writableChat(chatId);
				const url = typeof input.originalUrl === "string" && !!input.originalUrl.trim();
				const file = typeof input.originalPath === "string" && !!input.originalPath.trim();
				if (
					(input.kind !== "web" && input.kind !== "pdf") ||
					url === file ||
					(file && input.kind !== "pdf") ||
					(input.resolvedUrl !== undefined &&
						(!url || typeof input.resolvedUrl !== "string" || !input.resolvedUrl.trim()))
				)
					throw new Error("A reading source requires one original URL or PDF path.");
				const key = recordId("archive", chatId);
				let state = await readOne<ArchiveState>(key);
				const hash = digest(input.content);
				if (
					state &&
					(state.archive.sha256 !== hash ||
						state.archive.kind !== input.kind ||
						state.archive.originalUrl !== input.originalUrl ||
						state.archive.originalPath !== input.originalPath)
				)
					throw new Error("This session already has a different saved source.");
				if (!state) {
					const archive: ReadingArchive = {
						kind: input.kind,
						fileName: input.kind === "pdf" ? "source.pdf" : "source.md",
						...(input.originalUrl === undefined ? {} : { originalUrl: input.originalUrl }),
						...(input.originalPath === undefined ? {} : { originalPath: input.originalPath }),
						...(input.resolvedUrl === undefined ? {} : { resolvedUrl: input.resolvedUrl }),
						sha256: hash,
						byteLength: input.content.byteLength,
						savedAt: now(),
					};
					state = {
						archive,
						name: `source-${digest(chatId)}-${hash}.${input.kind === "pdf" ? "pdf" : "md"}`,
					};
					await db.write([await db.row(key, "archive", chatId, 0, state)]);
				}
				if (!state.fileId) {
					const attached = await db.attach(
						state.name,
						input.kind === "pdf" ? "application/pdf" : "text/markdown",
						input.content,
					);
					state.fileId = attached.fileId;
					await db.write([await db.row(key, "archive", chatId, 0, state)]);
				}
				return (await readArchive(chatId))!.archive;
			}),
		delete: (chatId) =>
			db.run(async () => {
				const key = recordId("archive", chatId);
				const state = await readOne<ArchiveState>(key);
				if (!state) return;
				const files = await db.request<{ files: { fileId: string; name?: string }[] }>(
					`${db.prefix}/files?objectId=${db.location.objectId}&limit=0`,
				);
				for (const file of files.files.filter(
					(file) => file.name === state.name || file.fileId === state.fileId,
				))
					await db.deleteFile(file.fileId);
				await db.retire(await db.rows({ id: key }));
			}),
	};
	return {
		chatStore,
		graphStore,
		jobStore,
		readingSourceStore,
		ready: async () => {
			const location = await db.ready();
			await db.run(async () => {
				await recoverGraphCommits();
				await db.retire(await db.rows({ owner: "graph", deleted: true }));
				await db.collectUnreferencedBlobs();
			});
			return location;
		},
		checkHealth: () => db.checkHealth(),
		close: () => db.close(),
	};
}
