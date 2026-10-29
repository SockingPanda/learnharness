/** Pinned Any v0.3.5 data plane. Domain data never falls back to files. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const ANY_VERSION = "0.3.5";
export const ANY_SCHEMA_VERSION = 1;
const BUNDLE_ID = "learnharness-preview/v1";
const SPACE_NAME = "LearnHarness Any Preview";
export interface AnyChange {
	graph?: boolean;
	chats?: boolean;
	jobs?: boolean;
	chatId?: string;
}
export interface AnyOptions {
	url: string;
	expectedAccountId: string;
	dataDir?: string;
	onChange?: (change: AnyChange) => void;
	onError?: (error: Error) => void;
	fetch?: typeof fetch;
	subscribe?: boolean;
}
export interface StoredRow {
	id: string;
	kind: string;
	owner: string;
	seq: number;
	json: string;
	blob: string;
	hash: string;
	deleted: boolean;
}
export type RowInput = Omit<StoredRow, "id"> & { id: string };
export interface Workspace {
	accountId: string;
	spaceId: string;
	objectId: string;
	dataset: string;
	schemaVersion: number;
}
interface FileInfo {
	fileId: string;
	name?: string;
	size: number;
}
export const digest = (bytes: Uint8Array | string): string =>
	createHash("sha256").update(bytes).digest("hex");
export const recordId = (kind: string, key: string): string => `${kind}:${digest(key)}`;
export class AnyRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}
export class AnyClient {
	private readonly fetcher: typeof fetch;
	private readonly base: string;
	private initializing?: Promise<Workspace>;
	private workspace?: Workspace;
	private tail: Promise<unknown> = Promise.resolve();
	private closed = false;
	private closing = false;
	private stream?: AbortController;
	private streamTask?: Promise<void>;
	constructor(readonly options: AnyOptions) {
		const url = new URL(options.url);
		if (
			url.protocol !== "http:" ||
			!["127.0.0.1", "[::1]"].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			throw new Error("Any must use its owned loopback HTTP endpoint.");
		if (!options.expectedAccountId) throw new Error("An owned Any account is required.");
		this.base = url.origin;
		this.fetcher = options.fetch ?? fetch;
	}
	async request<T>(route: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
		if (this.closed) throw new Error("Any storage has been closed.");
		const response = await this.fetcher(`${this.base}/v1${route}`, {
			method,
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok)
			throw new AnyRequestError(
				`Any request ${method} ${route} failed (${response.status}): ${(await response.text()).slice(0, 1200)}`,
				response.status,
			);
		if (response.status === 204) return undefined as T;
		const result = (await response.json()) as T & {
			rejections?: unknown[];
			pages?: { rejections?: unknown[] }[];
		};
		if (result.rejections?.length || result.pages?.some((page) => page.rejections?.length))
			throw new Error(
				`Any rejected records in ${route}: ${JSON.stringify(result.rejections ?? result.pages)}`,
			);
		return result;
	}
	async checkHealth(): Promise<void> {
		const health = await this.request<{
			version: string;
			account: string;
			bootstrapping: boolean;
			crdtVersion?: { newer: boolean };
		}>("/health");
		if (
			!/^any v0\.3\.5 \(commit e7ea90ea,/.test(health.version) ||
			health.account !== this.options.expectedAccountId ||
			health.bootstrapping ||
			health.crdtVersion?.newer
		)
			throw new Error("Any account, version, or readiness does not match this workspace.");
		const auth = await this.request<{ authorized: boolean }>("/auth");
		if (!auth.authorized) throw new Error("Any account is not authorized.");
	}
	ready(): Promise<Workspace> {
		return (this.initializing ??= this.initialize().catch((error) => {
			this.initializing = undefined;
			throw error;
		}));
	}
	private async initialize(): Promise<Workspace> {
		await this.checkHealth();
		const manifest = this.options.dataDir && path.join(this.options.dataDir, "learnharness-workspace.json");
		let saved: Workspace | undefined;
		if (manifest) {
			try {
				saved = JSON.parse(await fs.readFile(manifest, "utf8")) as Workspace;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (
				saved &&
				(saved.schemaVersion !== ANY_SCHEMA_VERSION || saved.accountId !== this.options.expectedAccountId)
			)
				throw new Error("Unsupported Any workspace schema or account.");
		}
		let spaceId = saved?.spaceId;
		if (!spaceId) {
			const listed = await this.request<{ spaces: { id: string; name: string }[] }>("/spaces");
			const matching = listed.spaces.filter((space) => space.name === SPACE_NAME);
			if (matching.length > 1)
				throw new Error("Multiple LearnHarness Any spaces exist; refusing ambiguous workspace selection.");
			spaceId = matching[0]?.id ?? (await this.request<{ id: string }>("/spaces", { name: SPACE_NAME })).id;
		}
		if (!spaceId) throw new Error("Any returned no workspace identity.");
		const prefix = `/spaces/${encodeURIComponent(spaceId)}`;
		const bundle = await this.request<{ bundle: { rootId: string } }>(`${prefix}/bundles`, {
			id: BUNDLE_ID,
			name: SPACE_NAME,
			xKey: "learnharness_preview",
			hidden: true,
			derived: true,
			parts: [
				{
					key: "storage",
					name: "Learning records",
					datasets: [
						{
							key: "entries",
							idRule: "user",
							fields: [
								{ key: "kind", kind: "string", required: true, mutableBy: "any" },
								{ key: "owner", kind: "string", required: true, mutableBy: "any" },
								{ key: "seq", kind: "number", required: true, mutableBy: "any" },
								{ key: "json", kind: "string", required: true, mutableBy: "any" },
								{ key: "blob", kind: "string", required: true, mutableBy: "any" },
								{ key: "hash", kind: "string", required: true, mutableBy: "any" },
								{ key: "deleted", kind: "boolean", required: true, mutableBy: "any" },
							],
						},
					],
				},
			],
		});
		const objectId = bundle.bundle.rootId;
		const dataset = `${objectId}_entries`;
		if (saved && (saved.objectId !== objectId || saved.dataset !== dataset))
			throw new Error("Any workspace object mapping changed.");
		const datasets = await this.request<{
			datasets: {
				collection: string;
				idRule: string;
				invalid?: boolean;
				fields: { key: string; kind: string; required?: boolean; mutableBy?: string }[];
			}[];
		}>(`${prefix}/types/${objectId}/datasets`);
		const declaration = datasets.datasets.find((row) => row.collection === dataset);
		const expected = {
			kind: "string",
			owner: "string",
			seq: "number",
			json: "string",
			blob: "string",
			hash: "string",
			deleted: "boolean",
		};
		if (
			!declaration ||
			declaration.idRule !== "user" ||
			declaration.invalid ||
			declaration.fields.length !== Object.keys(expected).length ||
			Object.entries(expected).some(
				([key, kind]) =>
					!declaration.fields.some(
						(field) =>
							field.key === key && field.kind === kind && field.required && field.mutableBy === "any",
					),
			)
		)
			throw new Error("Any workspace dataset is incompatible.");
		this.workspace = {
			accountId: this.options.expectedAccountId,
			spaceId,
			objectId,
			dataset,
			schemaVersion: ANY_SCHEMA_VERSION,
		};
		const schema = await this.rows({ id: "schema" });
		if (schema.length && JSON.parse(schema[0]!.json).version !== ANY_SCHEMA_VERSION)
			throw new Error("Unsupported LearnHarness data schema.");
		if (!schema.length)
			await this.write([await this.row("schema", "schema", "", 0, { version: ANY_SCHEMA_VERSION })]);
		if (manifest) {
			await fs.mkdir(path.dirname(manifest), { recursive: true });
			const temporary = `${manifest}.${process.pid}.tmp`;
			await fs.writeFile(temporary, JSON.stringify(this.workspace), { mode: 0o600 });
			await fs.rename(temporary, manifest);
		}
		if (this.options.subscribe !== false && this.options.onChange) this.streamTask = this.watch();
		return this.workspace;
	}
	get location(): Workspace {
		if (!this.workspace) throw new Error("Any workspace is not initialized.");
		return this.workspace;
	}
	get prefix(): string {
		return `/spaces/${encodeURIComponent(this.location.spaceId)}`;
	}
	run<T>(action: () => Promise<T>): Promise<T> {
		if (this.closing) return Promise.reject(new Error("Any storage is shutting down."));
		const result = this.tail.then(async () => {
			await this.ready();
			await this.checkHealth();
			return action();
		});
		this.tail = result.catch(() => undefined);
		return result;
	}
	async rows(filter: Record<string, unknown> = {}): Promise<StoredRow[]> {
		const all: StoredRow[] = [];
		for (let offset = 0; ; offset += 500) {
			const page = await this.request<{ records: StoredRow[]; hasNext?: boolean }>(`${this.prefix}/query`, {
				objectId: this.location.objectId,
				dataset: this.location.dataset,
				filter: { deleted: false, ...filter },
				sort: ["seq", "id"],
				limit: 500,
				offset,
				includeTotal: true,
			});
			all.push(...page.records);
			if (!page.hasNext) return all;
		}
	}
	async row(id: string, kind: string, owner: string, seq: number, value: unknown): Promise<RowInput> {
		const json = JSON.stringify(value);
		const hash = digest(json);
		if (Buffer.byteLength(json) > 128_000) {
			const bytes = Buffer.from(json);
			const file = await this.attach(`record-${hash}.json`, "application/json", bytes);
			return { id, kind, owner, seq, json: "", blob: file.fileId, hash, deleted: false };
		}
		return { id, kind, owner, seq, json, blob: "", hash, deleted: false };
	}
	async value<T>(row: StoredRow): Promise<T> {
		const json = row.blob ? Buffer.from(await this.download(row.blob)).toString("utf8") : row.json;
		if (digest(json) !== row.hash) throw new Error(`Any record ${row.id} failed its integrity check.`);
		return JSON.parse(json) as T;
	}
	assertBatchSize(rows: RowInput[]) {
		// modify is one CRDT change. Never use paginated /upsert for an atomic graph commit.
		const body = {
			objectId: this.location.objectId,
			dataset: this.location.dataset,
			records: rows.map(({ id, kind, owner, seq, json, blob, hash, deleted }) => ({
				id,
				upsert: true,
				ops: [{ type: "$set", path: "", value: { kind, owner, seq, json, blob, hash, deleted } }],
			})),
		};
		if (Buffer.byteLength(JSON.stringify(body)) > 950_000)
			throw new Error("Any atomic batch exceeds the supported request size; nothing was submitted.");
		return body;
	}
	async write(rows: RowInput[]): Promise<void> {
		if (rows.length) await this.request(`${this.prefix}/modify`, this.assertBatchSize(rows));
	}
	async retire(rows: StoredRow[]): Promise<void> {
		if (!rows.length) return;
		for (let offset = 0; offset < rows.length; offset += 500) {
			await this.request(`${this.prefix}/delete-records`, {
				objectId: this.location.objectId,
				dataset: this.location.dataset,
				recordIds: rows.slice(offset, offset + 500).map((row) => row.id),
			});
		}
	}
	async attach(name: string, mime: string, content: Uint8Array): Promise<FileInfo> {
		const files = await this.request<{ files: FileInfo[] }>(
			`${this.prefix}/files?objectId=${encodeURIComponent(this.location.objectId)}&limit=0`,
		);
		const previous = files.files.filter((file) => file.name === name);
		for (const file of previous) {
			if (file.size === content.byteLength && digest(await this.download(file.fileId)) === digest(content))
				return file;
		}
		const response = await this.fetcher(
			`${this.base}/v1${this.prefix}/objects/${this.location.objectId}/files?name=${encodeURIComponent(name)}`,
			{
				method: "POST",
				headers: { "Content-Type": mime },
				body: Buffer.from(content),
				signal: AbortSignal.timeout(60_000),
			},
		);
		if (!response.ok)
			throw new AnyRequestError(`Any attachment upload failed (${response.status}).`, response.status);
		const file = (await response.json()) as FileInfo;
		if (digest(await this.download(file.fileId)) !== digest(content))
			throw new Error("Any attachment did not preserve the original bytes.");
		return file;
	}
	async download(id: string): Promise<Uint8Array> {
		const response = await this.fetcher(
			`${this.base}/v1${this.prefix}/files/${encodeURIComponent(id)}/content`,
			{ signal: AbortSignal.timeout(60_000) },
		);
		if (!response.ok)
			throw new AnyRequestError(`Any attachment download failed (${response.status}).`, response.status);
		return new Uint8Array(await response.arrayBuffer());
	}
	async collectUnreferencedBlobs(): Promise<void> {
		const referenced = new Set((await this.rows()).map((row) => row.blob).filter(Boolean));
		for (const pending of await this.rows({ kind: "graph-pending" })) {
			const journal = await this.value<{ writes: RowInput[] }>(pending);
			for (const row of journal.writes) if (row.blob) referenced.add(row.blob);
		}
		const files = await this.request<{ files: FileInfo[] }>(
			`${this.prefix}/files?objectId=${encodeURIComponent(this.location.objectId)}&limit=0`,
		);
		for (const file of files.files) {
			if (file.name?.startsWith("record-") && file.name.endsWith(".json") && !referenced.has(file.fileId))
				await this.deleteFile(file.fileId);
		}
	}
	async deleteFile(id: string): Promise<void> {
		try {
			await this.request(`${this.prefix}/files/${encodeURIComponent(id)}`, undefined, "DELETE");
		} catch (error) {
			if (!(error instanceof AnyRequestError) || error.status !== 404) throw error;
		}
	}
	notify(change: AnyChange): void {
		this.options.onChange?.(change);
	}
	private async watch(): Promise<void> {
		while (!this.closed) {
			const controller = (this.stream = new AbortController());
			try {
				const response = await this.fetcher(`${this.base}/v1${this.prefix}/query/subscribe`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						objectId: this.location.objectId,
						dataset: this.location.dataset,
						filter: { kind: { $in: ["graph-receipt", "chat", "job", "graph-source"] } },
						projection: { id: 1, kind: 1, owner: 1 },
						sort: ["id"],
					}),
					signal: controller.signal,
				});
				if (!response.ok || !response.body) throw new Error("Any change subscription failed.");
				this.notify({ graph: true, chats: true, jobs: true }); // reconnect invalidation
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let pending = "";
				try {
					while (!this.closed) {
						const next = await reader.read();
						if (next.done) break;
						pending += decoder.decode(next.value, { stream: true });
						let boundary: number;
						while ((boundary = pending.indexOf("\n\n")) >= 0) {
							const frame = pending.slice(0, boundary);
							pending = pending.slice(boundary + 2);
							if (/event:\s*(snapshot|changes)/.test(frame))
								this.notify({ graph: true, chats: true, jobs: true });
						}
					}
				} finally {
					await reader.cancel().catch(() => undefined);
					reader.releaseLock();
				}
			} catch (error) {
				if (!this.closed) this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
			}
			if (!this.closed)
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 1000);
					timer.unref?.();
				});
		}
	}
	async close(): Promise<void> {
		this.closing = true;
		await this.tail;
		this.closed = true;
		this.stream?.abort();
		await this.streamTask;
	}
}
