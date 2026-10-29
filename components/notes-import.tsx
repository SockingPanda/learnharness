"use client";

import { useI18n } from "@/components/i18n";
import { createTranslator, type TranslationValues, type Translator } from "@/src/core";

import { useRef, useState } from "react";

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
}

/** Retain the source message and arguments even when a caller asks for a
 * localized Error.message. The hook can then render a settled failure in the
 * current language without repeating the import or retaining its Files. */
class NotesImportRequestError extends Error {
	constructor(readonly source: string, readonly values: TranslationValues | undefined, t: Translator) {
		super(t(source, values));
	}
}

type ImportFailure = {
	filePath: string;
	source: string;
	values?: TranslationValues;
	/** Provider identifiers and raw diagnostic metadata stay verbatim. */
	details?: string;
};

/** Validate the entire response before applying any row: a malformed index
 * must never attribute another file's success to this file (same names included). */
export function parseNotesImportResults(body: unknown, files: readonly File[], t: Translator = createTranslator("en")): NotesImportResult[] {
	const invalid = () => new NotesImportRequestError("Invalid import response. Please retry the file.", undefined, t);
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= files.length || seen.has(r.requestIndex) || r.filePath !== files[r.requestIndex]!.name) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.ok && !r.stats) throw invalid();
		if (!r.ok && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

export async function postNotesImport(files: readonly File[], t: Translator = createTranslator("en")): Promise<NotesImportResult[]> {
	const form = new FormData();
	for (const file of files) form.append("files", file);
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new NotesImportRequestError("Invalid import response. Please retry the file.", undefined, t); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new NotesImportRequestError("Import request failed (HTTP {status}){detail}. Please retry the file.", { status: response.status, detail }, t);
	}
	return parseNotesImportResults(body, files, t);
}

/** Only source error text/arguments survive a request; selected Files stay
 * request-local. The public errors array is derived during render, so changing
 * the interface language also updates failures from an earlier request. */
export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const { t } = useI18n();
	const [failures, setFailures] = useState<ImportFailure[]>([]);
	const [importing, setImporting] = useState(false);
	const pending = useRef(false);
	const submit = async (files: File[]) => {
		if (pending.current || files.length === 0) return;
		pending.current = true;
		setImporting(true);
		setFailures([]);
		try {
			callbacks.onStart?.();
			const results = await postNotesImport(files);
			setFailures(results
				.filter((result) => !result.ok)
				.sort((a, b) => a.requestIndex - b.requestIndex)
				.map((r) => ({
					filePath: r.filePath,
					source: r.error!,
					details: r.code ? `\n${r.code}${r.provider ? ` — ${r.provider}` : ""}${r.missing?.length ? ` — ${r.missing.join(", ")}` : ""}${r.slots?.length ? ` — ${r.slots.join(", ")}` : ""}` : "",
				})));
		} catch (error) {
			const source = error instanceof NotesImportRequestError ? error.source : error instanceof Error ? error.message : String(error);
			const values = error instanceof NotesImportRequestError ? error.values : undefined;
			setFailures(files.map((file) => ({ filePath: file.name, source, values })));
		} finally {
			pending.current = false;
			setImporting(false);
			callbacks.onFinish?.();
		}
	};
	const errors = failures.map(({ filePath, source, values, details }) => `${filePath}: ${t(source, values)}${details ?? ""}`);
	return {
		errors, importing,
		onImportFiles: (files: FileList | null) => { if (files) void submit(Array.from(files)); },
	};
}

export function NotesImportErrors({ errors }: { errors: readonly string[] }) {
	return <>{errors.map((error, i) => (
		<p key={i} role="alert" className="max-w-full whitespace-pre-wrap break-words text-xs text-red-400">{error}</p>
	))}</>;
}
