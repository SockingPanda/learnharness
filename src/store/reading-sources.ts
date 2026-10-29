/** Original reading sources: one immutable artifact and manifest per session.
 * A complete temporary directory is renamed into place, so interrupted writes
 * never publish a metadata record without its source bytes. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../../config.ts";
import type { ReadingSourceStore } from "../core/ports.ts";
import type { ReadingArchive } from "../core/reading.ts";

type SaveInput = Parameters<ReadingSourceStore["save"]>[1];

function digest(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function hasOrigin(value: { kind: unknown; originalUrl?: unknown; originalPath?: unknown; resolvedUrl?: unknown }): boolean {
	const url = typeof value.originalUrl === "string" && value.originalUrl.trim().length > 0;
	const file = typeof value.originalPath === "string" && value.originalPath.trim().length > 0;
	return (value.kind === "web" || value.kind === "pdf") &&
		(url !== file) && (url || value.kind === "pdf") &&
		(value.originalUrl === undefined || url) &&
		(value.originalPath === undefined || file) &&
		(value.resolvedUrl === undefined || (url && typeof value.resolvedUrl === "string" && value.resolvedUrl.trim().length > 0));
}

function isArchive(value: unknown): value is ReadingArchive {
	if (typeof value !== "object" || value === null) return false;
	const archive = value as Partial<ReadingArchive>;
	return hasOrigin({ ...archive, kind: archive.kind }) &&
		archive.fileName === (archive.kind === "web" ? "source.md" : "source.pdf") &&
		typeof archive.sha256 === "string" && /^[a-f0-9]{64}$/.test(archive.sha256) &&
		typeof archive.byteLength === "number" && Number.isSafeInteger(archive.byteLength) && archive.byteLength >= 0 &&
		typeof archive.savedAt === "string" && Number.isFinite(Date.parse(archive.savedAt));
}

function statIfPresent(file: string): fs.Stats | null {
	try { return fs.lstatSync(file); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function sameSource(archive: ReadingArchive, input: SaveInput): boolean {
	return archive.kind === input.kind && archive.originalUrl === input.originalUrl &&
		archive.originalPath === input.originalPath &&
		archive.byteLength === input.content.byteLength && archive.sha256 === digest(input.content);
}

export function createReadingSourceStore(rootDir: string): ReadingSourceStore {
	const root = path.resolve(rootDir);
	const sessionDir = (chatId: string): string => {
		if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
		return path.join(root, chatId);
	};

	const get: ReadingSourceStore["get"] = (chatId) => {
		const dir = sessionDir(chatId);
		const stat = statIfPresent(dir);
		if (!stat) return null;
		const invalid = () => new Error(`Saved reading source for ${chatId} is incomplete or damaged.`);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
		try {
			const metadataFile = path.join(dir, "metadata.json");
			if (!fs.lstatSync(metadataFile).isFile()) throw invalid();
			const archive: unknown = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
			if (!isArchive(archive)) throw invalid();
			const sourceFile = path.join(dir, archive.fileName);
			if (!fs.lstatSync(sourceFile).isFile()) throw invalid();
			const content = fs.readFileSync(sourceFile);
			if (content.byteLength !== archive.byteLength || digest(content) !== archive.sha256) throw invalid();
			return { archive, content };
		} catch (error) {
			throw new Error(invalid().message, { cause: error });
		}
	};

	return {
		get,
		save(chatId, input) {
			const dir = sessionDir(chatId);
			if (!hasOrigin(input)) throw new Error("A reading source needs one original URL, or a local path for a PDF.");
			const previous = get(chatId);
			if (previous) {
				if (sameSource(previous.archive, input)) return previous.archive;
				throw new Error("This session already has a different saved source. Start a new reading session.");
			}
			const archive: ReadingArchive = {
				kind: input.kind,
				fileName: input.kind === "web" ? "source.md" : "source.pdf",
				...(input.originalUrl === undefined ? {} : { originalUrl: input.originalUrl }),
				...(input.originalPath === undefined ? {} : { originalPath: input.originalPath }),
				...(input.resolvedUrl === undefined ? {} : { resolvedUrl: input.resolvedUrl }),
				sha256: digest(input.content),
				byteLength: input.content.byteLength,
				savedAt: new Date().toISOString(),
			};
			fs.mkdirSync(root, { recursive: true });
			const temporary = fs.mkdtempSync(path.join(root, `.${chatId}-`));
			try {
				fs.writeFileSync(path.join(temporary, archive.fileName), input.content, { flag: "wx" });
				fs.writeFileSync(path.join(temporary, "metadata.json"), JSON.stringify(archive, null, "\t") + "\n", { flag: "wx" });
				try {
					fs.renameSync(temporary, dir);
				} catch (error) {
					// A second process may have published the same source first.
					const winner = get(chatId);
					if (winner && sameSource(winner.archive, input)) return winner.archive;
					throw error;
				}
				return archive;
			} finally {
				fs.rmSync(temporary, { recursive: true, force: true });
			}
		},
		delete(chatId) {
			// rm unlinks a session symlink itself; it never traverses its target.
			fs.rmSync(sessionDir(chatId), { recursive: true, force: true });
		},
	};
}

export const readingSourceStore = createReadingSourceStore(PATHS.readingSources);
