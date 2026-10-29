import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

function isolated(script: string, backend = "any") {
	const dir = mkdtempSync(path.join(tmpdir(), "lh-storage-composition-"));
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, LH_DATA_DIR: dir, LH_STORAGE_BACKEND: backend, LH_AUTH_FILE: path.join(dir, "auth.json") };
		delete env.LH_ANY_URL;
		delete env.LH_ANY_ACCOUNT_ID;
		delete env.LH_ANY_DATA_DIR;
		const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			cwd: root, env, encoding: "utf8", timeout: 20_000,
		});
		assert.deepEqual(readdirSync(dir), [], "no fallback records, account or graph initialization");
		return output;
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

test("importing the storage composition during build does not connect or initialize Any", () => {
	isolated(`
		globalThis.fetch = async () => { throw new Error("unexpected network during import"); };
		const { stores } = await import("./src/server/stores.ts");
		if (typeof stores.chatStore.getChat !== "function") throw new Error("missing lazy port");
	`);
});

test("Any mode without its owned endpoint refuses writes instead of falling back to files", () => {
	isolated(`
		const assert = (await import("node:assert/strict")).default;
		const { stores } = await import("./src/server/stores.ts");
		await assert.rejects(stores.chatStore.createChat("must not exist"), /application-managed database/);
		await assert.rejects(stores.graphStore.readSnapshot(), /application-managed database/);
	`);
});

test("unknown backend names fail explicitly", () => {
	isolated(`
		const assert = (await import("node:assert/strict")).default;
		const { stores } = await import("./src/server/stores.ts");
		await assert.rejects(stores.chatStore.listChats(), /Unknown LearnHarness storage backend/);
	`, "not-a-backend");
});

test("a late readiness probe cannot reopen storage after shutdown", () => {
	isolated(`
		const assert = (await import("node:assert/strict")).default;
		const { storageReady, closeStorage } = await import("./src/server/stores.ts");
		const { beginStorageShutdown, markStorageClosed } = await import("./src/core/storage-lifecycle.ts");
		beginStorageShutdown();
		await closeStorage();
		markStorageClosed();
		await assert.rejects(storageReady(), { code: "storage_stopping" });
	`);
});

test("failed startup recovery closes its subscription before a new backend is tried", () => {
	isolated(`
		const assert = (await import("node:assert/strict")).default;
		process.env.LH_ANY_URL = "http://127.0.0.1:44556";
		process.env.LH_ANY_ACCOUNT_ID = "fixture-account";
		const { storageReady, closeStorage } = await import("./src/server/stores.ts");
		let subscriptions = 0;
		let subscriptionAborts = 0;
		const json = (value) => Response.json(value);
		globalThis.fetch = async (url, init = {}) => {
			const pathname = new URL(url).pathname;
			const body = init.body ? JSON.parse(String(init.body)) : undefined;
			if (pathname.endsWith("/health")) return json({
				version: "any v0.3.5 (commit e7ea90ea, fixture)", account: "fixture-account",
				bootstrapping: false, crdtVersion: { newer: false },
			});
			if (pathname.endsWith("/auth")) return json({ authorized: true });
			if (pathname === "/v1/spaces") return json(init.method === "POST" ? { id: "fixture-space" } : { spaces: [] });
			if (pathname.endsWith("/bundles")) return json({ bundle: { rootId: "fixture-object" } });
			if (pathname.endsWith("/datasets")) return json({ datasets: [{
				collection: "fixture-object_entries", idRule: "user",
				fields: Object.entries({ kind: "string", owner: "string", seq: "number", json: "string", blob: "string", hash: "string", deleted: "boolean" })
					.map(([key, kind]) => ({ key, kind, required: true, mutableBy: "any" })),
			}] });
			if (pathname.endsWith("/query/subscribe")) {
				subscriptions++;
				return new Response(new ReadableStream({
					start(controller) {
						init.signal.addEventListener("abort", () => { subscriptionAborts++; controller.close(); }, { once: true });
					},
				}));
			}
			if (pathname.endsWith("/query")) {
				if (body?.filter?.kind === "graph-pending") return new Response("recovery unavailable", { status: 503 });
				return json({ records: [{ id: "schema", json: JSON.stringify({ version: 1 }) }] });
			}
			throw new Error("Unexpected Any fixture request: " + pathname);
		};
		for (let attempt = 1; attempt <= 2; attempt++) {
			await assert.rejects(storageReady(), /recovery unavailable/);
			assert.equal(subscriptions, attempt);
			assert.equal(subscriptionAborts, attempt, "failed initialization must close the client it created");
		}
		await closeStorage();
		assert.equal(subscriptions, subscriptionAborts, "no unmanaged subscriptions remain after failure");
	`);
});
