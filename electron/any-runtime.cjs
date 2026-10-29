/** Own one pinned, standalone Any process. This module never logs child output or recovery words. */
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const release = require("./any-release.json");

const OWNER = "LearnHarness Any Preview";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanAnyEnvironment(environment = process.env) {
	return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith("ANY_")));
}

function localConfiguration(nodeconfPath) {
	return {
		network: { nodeconfPath },
		p2p: { enabled: false, global: { enabled: false } },
		push: { enabled: false },
		index: { embedder: "none" },
		webUI: { enabled: false },
		log: { defaultLevel: "error", disableStdErr: true },
	};
}

async function jsonFile(file) {
	try { return JSON.parse(await fs.readFile(file, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function writePrivateJson(file, value) {
	const temporary = `${file}.tmp`;
	await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
	await fs.rename(temporary, file);
}

function runPrivate(binary, args, env, timeoutMs, signal) {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		// `any init` prints the recovery phrase to stderr. Neither stream may reach logs.
		const child = spawn(binary, args, { env, stdio: "ignore", windowsHide: true });
		const aborted = () => { child.kill("SIGKILL"); reject(new Error("Any startup cancelled")); };
		signal?.addEventListener("abort", aborted, { once: true });
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Any account initialization timed out")); }, timeoutMs);
		const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); };
		child.once("error", () => { cleanup(); reject(new Error("Cannot start the bundled Any executable")); });
		child.once("exit", (code) => {
			cleanup();
			if (code === 0) resolve();
			else reject(new Error(`Any account initialization failed (exit ${code})`));
		});
	});
}

async function requestJson(url, pathname) {
	const response = await fetch(`${url}${pathname}`, { signal: AbortSignal.timeout(3000), redirect: "error" });
	if (!response.ok) throw new Error(`Any readiness request failed (${response.status})`);
	return response.json();
}

function assertHealth(health, auth, accountId) {
	if (typeof health.version !== "string" || !health.version.includes(`any v${release.version} `) || !health.version.includes(release.commit.slice(0, 8))) throw new Error("The Any binary does not match the pinned version");
	if (health.networkId !== release.networkId) throw new Error("Any is configured for an unexpected network");
	if (health.account !== accountId || auth.authorized !== true || auth.mode !== "standalone") throw new Error("Any account does not match this preview workspace");
	if (!health.crdtVersion || health.crdtVersion.newer !== false) throw new Error("Any data requires a newer database version");
	return health.bootstrapping === false;
}

/** Start fresh or reopen only this preview's owned data directory. */
async function startAnyRuntime({ binary, dataDir, environment = process.env, startupTimeoutMs = 60_000, shutdownTimeoutMs = 10_000, signal }) {
	signal?.throwIfAborted();
	if (!path.isAbsolute(binary) || !path.isAbsolute(dataDir)) throw new Error("Any executable and data directory must be absolute paths");
	await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
	const ownershipFile = path.join(dataDir, "preview-owner.json");
	let ownership = await jsonFile(ownershipFile);
	if (ownership && (ownership.owner !== OWNER || ownership.networkId !== release.networkId || ownership.version !== release.version)) throw new Error("This Any data directory belongs to another application or version");
	if (!ownership) {
		const existing = await fs.readdir(dataDir);
		if (existing.length) throw new Error("Refusing to initialize a non-empty, unowned Any data directory");
		ownership = { owner: OWNER, version: release.version, networkId: release.networkId, accountId: null };
		await writePrivateJson(ownershipFile, ownership);
	}
	const placeholder = await fs.readFile(path.join(__dirname, "any-placeholder.yml"));
	const nodeconfPath = path.join(dataDir, "placeholder.yml");
	await fs.writeFile(nodeconfPath, placeholder, { mode: 0o600 });
	const configPath = path.join(dataDir, "config.json");
	await writePrivateJson(configPath, localConfiguration(nodeconfPath));
	const env = cleanAnyEnvironment(environment);
	if (!ownership.accountId) {
		await runPrivate(binary, ["init", "--config", configPath, "--data-dir", dataDir], env, startupTimeoutMs, signal);
		const accounts = [];
		for (const entry of await fs.readdir(dataDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try { await fs.access(path.join(dataDir, entry.name, "wallet.key")); accounts.push(entry.name); }
			catch { /* Non-account files or cache folders. */ }
		}
		if (accounts.length !== 1) throw new Error("Any initialization did not produce one isolated account");
		ownership = { ...ownership, accountId: accounts[0], placeholderSha256: createHash("sha256").update(placeholder).digest("hex") };
		await writePrivateJson(ownershipFile, ownership);
	}
	signal?.throwIfAborted();
	const child = spawn(binary, ["run", "--mode", "standalone", "--config", configPath, "--data-dir", dataDir, "--account", ownership.accountId, "--addr", "127.0.0.1:0"], { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	let stopped = false;
	let ended = false;
	let stopping;
	const exited = new Promise((resolve) => {
		child.once("error", () => { ended = true; resolve({ code: null, signal: null, expected: stopped }); });
		child.once("exit", (code, signal) => { ended = true; resolve({ code, signal, expected: stopped }); });
	});
	const stop = () => stopping ??= (async () => {
		stopped = true;
		signal?.removeEventListener("abort", aborted);
		if (ended) return;
		child.kill("SIGTERM");
		let timer;
		await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, shutdownTimeoutMs); })]);
		clearTimeout(timer);
		if (!ended) { child.kill("SIGKILL"); await exited; }
	})();
	const aborted = () => { void stop(); };
	signal?.addEventListener("abort", aborted, { once: true });
	try {
		const url = await new Promise((resolve, reject) => {
			let pending = "";
			const timeout = setTimeout(() => reject(new Error("Any did not become ready before the startup deadline")), startupTimeoutMs);
			const cleanup = () => { clearTimeout(timeout); child.stdout.off("data", onData); };
			const onData = (chunk) => {
				pending = (pending + chunk.toString("utf8")).slice(-8192);
				const lines = pending.split(/\r?\n/); pending = lines.pop();
				for (const line of lines) {
					const match = /^LISTENING 127\.0\.0\.1:(\d+)$/.exec(line);
					if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) { cleanup(); resolve(`http://127.0.0.1:${match[1]}`); }
				}
			};
			child.stdout.on("data", onData);
			exited.then(() => { cleanup(); reject(new Error("Any exited before the owned database became ready")); });
		});
		const deadline = Date.now() + startupTimeoutMs;
		while (true) {
			if (ended) throw new Error("Any exited during startup");
			const [health, auth] = await Promise.all([requestJson(url, "/v1/health"), requestJson(url, "/v1/auth")]);
			if (assertHealth(health, auth, ownership.accountId)) break;
			if (Date.now() >= deadline) throw new Error("Any account bootstrap timed out");
			await delay(100);
		}
		return { url, accountId: ownership.accountId, dataDir, pid: child.pid, stop, exited };
	} catch (error) {
		await stop();
		throw error;
	}
}

module.exports = { startAnyRuntime, cleanAnyEnvironment, localConfiguration, assertHealth, release };
