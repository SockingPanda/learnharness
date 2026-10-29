import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const { startAnyRuntime, cleanAnyEnvironment, localConfiguration, assertHealth, release } = require("../electron/any-runtime.cjs");
const { startAnySupervisor } = require("../electron/any-host.cjs");
const binary = process.env.LH_TEST_ANY_BINARY ?? path.join(root, "vendor/any", `${process.platform}-${process.arch}`, process.platform === "win32" ? "any.exe" : "any");
const real = existsSync(binary);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("preview explicitly disables synchronization and embeddings, removing inherited Any overrides", () => {
	assert.deepEqual(cleanAnyEnvironment({ PATH: "/bin", ANY_NETWORK_NODECONF_PATH: "/production.yml", ANY_P2P_GLOBAL_ENABLED: "true", any_mode: "managed" }), { PATH: "/bin" });
	const config = localConfiguration("/preview/placeholder.yml");
	assert.deepEqual(config.network, { nodeconfPath: "/preview/placeholder.yml" });
	assert.deepEqual(config.p2p, { enabled: false, global: { enabled: false } });
	assert.equal(config.push.enabled, false);
	assert.equal(config.index.embedder, "none");
});

test("ready requires matching pinned binary, local network, account, authorization and CRDT version", () => {
	const health = { version: `any v${release.version} (commit ${release.commit.slice(0, 8)})`, networkId: release.networkId, account: "fixture-account", bootstrapping: false, crdtVersion: { newer: false } };
	const auth = { authorized: true, mode: "standalone" };
	assert.equal(assertHealth(health, auth, "fixture-account"), true);
	assert.equal(assertHealth({ ...health, bootstrapping: true }, auth, "fixture-account"), false);
	for (const patch of [{ version: "any v0.1.0" }, { networkId: "production" }, { account: "another" }, { crdtVersion: { newer: true } }]) assert.throws(() => assertHealth({ ...health, ...patch }, auth, "fixture-account"));
	assert.throws(() => assertHealth(health, { ...auth, authorized: false }, "fixture-account"));
});

test("preview package has independent identity, data flavor and no update feed", async () => {
	const { getConfig, validateConfiguration } = require("app-builder-lib/out/util/config/config.js");
	const config = await getConfig(root, "electron-builder.any.yml");
	await validateConfiguration(config, { isEnabled: false });
	assert.equal(config.productName, "LearnHarness Any Preview");
	assert.equal(config.appId, "com.sockingpanda.learnharness.anypreview");
	assert.equal(config.extraMetadata.lhAnyPreview, true);
	assert.equal(config.publish, null);
	assert.ok(config.extraResources.some((resource: { from: string; to: string }) => resource.from === ".next" && resource.to === "server"));
	for (const [platform, folder] of [["mac", "darwin"], ["win", "win32"], ["linux", "linux"]]) {
		assert.ok(config[platform!].extraResources.some((resource: { from: string; to: string }) => resource.from.startsWith(`vendor/any/${folder}-`) && resource.to === "any"));
	}
});

test("Any initialization refuses an unowned nonempty directory", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "lh-any-unowned-"));
	try {
		await writeFile(path.join(directory, "important-data"), "keep");
		await assert.rejects(startAnyRuntime({ binary, dataDir: directory }), /unowned/);
		assert.equal(await readFile(path.join(directory, "important-data"), "utf8"), "keep");
	} finally { await rm(directory, { recursive: true, force: true }); }
});

for (const drained of [true, false]) test(`preview exit drains business before stopping Next and Any (drained=${drained})`, async () => {
	const trace: string[] = [];
	class Child extends EventEmitter {
		kill(signal: string) { trace.push(`next:${signal}`); queueMicrotask(() => this.emit("exit", 0)); return true; }
	}
	const mainFile = path.join(root, "electron/main.cjs");
	const mainRequire = createRequire(mainFile);
	const context = {
		require: (id: string) => id === "electron" ? {
			app: { setName() {}, requestSingleInstanceLock: () => false, quit() {}, getPath: () => "/unused" },
		} : id === "node:fs" ? { mkdirSync() {}, appendFileSync() {} } : mainRequire(id),
		process: { platform: "linux", argv: [], env: {}, on() {} },
		__dirname: path.dirname(mainFile),
		fakeChild: new Child(),
		trace,
		setTimeout, clearTimeout, AbortSignal,
		console: { log() {} },
		fetch: async (url: string, init: RequestInit) => {
			assert.equal(url, "http://127.0.0.1:1234/api/storage/shutdown");
			assert.equal(init.method, "POST");
			assert.equal((init.headers as Record<string, string>)["x-learnharness-desktop"], "private-capability");
			trace.push("drain");
			return Response.json({ stopped: drained }, { status: drained ? 200 : 503 });
		},
	};
	runInNewContext(await readFile(mainFile, "utf8"), context, { filename: mainFile });
	runInNewContext('serverProcess = fakeChild; ownedServerUrl = "http://127.0.0.1:1234"; desktopAPISecret = "private-capability"; anyRuntime = { stop: async () => trace.push("any:stop") };', context);
	await Promise.all([runInNewContext("stopPreview()", context), runInNewContext("stopPreview()", context)]);
	assert.deepEqual(trace, ["drain", "next:SIGTERM", "any:stop"]);
});

test("real pinned Any creates one local account and reopens its saved data", { skip: !real, timeout: 40_000 }, async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "lh-any-restart-"));
	let runtime;
	try {
		runtime = await startAnyRuntime({ binary, dataDir: directory, environment: { ...process.env, ANY_MODE: "managed", ANY_NETWORK_NODECONF_PATH: "/must-not-be-used" } });
		const accountId = runtime.accountId;
		const created = await fetch(`${runtime.url}/v1/spaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Preview restart test" }) });
		assert.equal(created.ok, true);
		const space = await created.json() as { id: string };
		assert.equal(typeof space.id, "string");
		await runtime.stop();
		runtime = await startAnyRuntime({ binary, dataDir: directory });
		assert.equal(runtime.accountId, accountId);
		const response = await fetch(`${runtime.url}/v1/spaces`);
		assert.equal(response.ok, true);
		assert.match(await response.text(), new RegExp(space.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		const config = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
		assert.equal(config.p2p.global.enabled, false);
		assert.equal(config.index.embedder, "none");
	} finally { await runtime?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("real supervisor sends only endpoint metadata and shuts down the owned service", { skip: !real, timeout: 30_000 }, async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "lh-any-supervisor-"));
	let runtime;
	try {
		runtime = await startAnySupervisor({ binary, dataDir: directory });
		assert.equal(Object.hasOwn(runtime, "mnemonic"), false);
		assert.equal((await fetch(`${runtime.url}/v1/health`)).ok, true);
		await runtime.stop();
		await assert.rejects(fetch(`${runtime.url}/v1/health`));
	} finally { await runtime?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("an occupied Any account fails without attaching to the already running service", { skip: !real, timeout: 30_000 }, async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "lh-any-occupied-"));
	let runtime;
	try {
		runtime = await startAnyRuntime({ binary, dataDir: directory });
		await assert.rejects(startAnyRuntime({ binary, dataDir: directory }), /exited before/);
		assert.equal((await fetch(`${runtime.url}/v1/health`)).ok, true);
	} finally { await runtime?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("unexpected Any exit reports failure and never silently restarts the database", { skip: !real, timeout: 30_000 }, async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "lh-any-failure-"));
	let runtime;
	try {
		let report!: (message: string) => void;
		const failed = new Promise<string>((resolve) => { report = resolve; });
		runtime = await startAnySupervisor({ binary, dataDir: directory, onFailure: report });
		process.kill(runtime.pid, "SIGTERM");
		assert.match(await failed, /stopped|Restart/);
		await assert.rejects(fetch(`${runtime.url}/v1/health`));
	} finally { await runtime?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("real supervisor stops Any when its owner disappears", { skip: !real, timeout: 35_000 }, async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "lh-any-parent-death-"));
	try {
		const script = `const {startAnySupervisor}=require(${JSON.stringify(path.join(root, "electron/any-host.cjs"))}); startAnySupervisor({binary:process.argv[1],dataDir:process.argv[2]}).then(r=>{process.stdout.write(JSON.stringify({url:r.url,pid:r.pid})+'\\n',()=>process.exit(0))}).catch(()=>process.exit(1));`;
		const owner = spawn(process.execPath, ["-e", script, binary, directory], { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let error = "";
		owner.stdout.on("data", (value) => { output += value; });
		owner.stderr.on("data", (value) => { error += value; });
		const code = await new Promise((resolve) => owner.once("exit", resolve));
		assert.equal(code, 0, error);
		const runtime = JSON.parse(output.trim()) as { url: string; pid: number };
		let running = true;
		for (let attempt = 0; attempt < 120; attempt++) {
			try { await fetch(`${runtime.url}/v1/health`, { signal: AbortSignal.timeout(300) }); }
			catch { running = false; break; }
			await pause(100);
		}
		assert.equal(running, false, "IPC disconnect must stop the owned database");
	} finally { await rm(directory, { recursive: true, force: true }); }
});
