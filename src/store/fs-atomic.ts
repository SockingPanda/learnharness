import fs from "node:fs";
import path from "node:path";

/** One process owns a workspace. Queueing also orders reads after pending writes. */
export class FileStoreQueue {
	private tail: Promise<void> = Promise.resolve();
	run<T>(work: () => T): Promise<T> {
		const next = this.tail.then(work);
		this.tail = next.then(() => undefined, () => undefined);
		return next;
	}
}

const queues = new Map<string, FileStoreQueue>();

/** Factories reopening the same archive directory share its ordering boundary. */
export function fileStoreQueue(root: string): FileStoreQueue {
	const key = path.resolve(root);
	let queue = queues.get(key);
	if (!queue) { queue = new FileStoreQueue(); queues.set(key, queue); }
	return queue;
}

export function syncDirectory(dir: string): void {
	// Windows does not support opening a directory for fsync. File contents still
	// get flushed before rename; POSIX also flushes the directory entry itself.
	if (process.platform === "win32") return;
	const fd = fs.openSync(dir, "r");
	try { fs.fsyncSync(fd); }
	finally { fs.closeSync(fd); }
}

/** Flush, rename, then flush the directory. Failure never publishes torn JSON. */
export function atomicWriteFile(file: string, body: string | Uint8Array): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const temporary = `${file}.tmp-${crypto.randomUUID()}`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(temporary, "wx", 0o600);
		fs.writeFileSync(fd, body);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temporary, file);
		syncDirectory(dir);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try { fs.unlinkSync(temporary); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}

/** Compare what JSON storage preserves, independently of object key order. */
export function canonicalJson(value: unknown): string {
	const sort = (entry: unknown): unknown => {
		if (Array.isArray(entry)) return entry.map(sort);
		if (entry && typeof entry === "object") {
			return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]));
		}
		return entry;
	};
	return JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
}
