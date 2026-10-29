const { spawn } = require("node:child_process");
const path = require("node:path");
const { release } = require("./any-runtime.cjs");

/** The renderer never receives the Any endpoint; only its owned Next child does. */
function startAnySupervisor({ binary, dataDir, onFailure = () => {}, execPath = process.execPath, environment = process.env }) {
	return new Promise((resolve, reject) => {
		const child = spawn(execPath, [path.join(__dirname, "any-supervisor.cjs"), binary, dataDir], {
			env: { ...environment, ELECTRON_RUN_AS_NODE: "1", NO_PROXY: `${environment.NO_PROXY ?? environment.no_proxy ?? ""},127.0.0.1,localhost,::1` },
			stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
		});
		let ready = false;
		let stopping = false;
		let stopped;
		let exited = false;
		const closed = new Promise((done) => child.once("close", () => { exited = true; done(); }));
		const timer = setTimeout(() => fail("The local database did not finish starting."), 120_000);
		const stop = () => stopped ??= (async () => {
			stopping = true; clearTimeout(timer);
			if (exited) return;
			if (child.connected) {
				try { child.send({ type: "stop" }, (error) => { if (error) child.kill("SIGTERM"); }); }
				catch { child.kill("SIGTERM"); }
			} else child.kill("SIGTERM");
			let deadline;
			await Promise.race([closed, new Promise((done) => { deadline = setTimeout(done, 12_000); })]);
			clearTimeout(deadline);
			if (!exited) child.kill("SIGKILL");
			await closed;
		})();
		const fail = (message) => {
			clearTimeout(timer);
			if (stopping) return;
			void stop();
			if (ready) onFailure(message);
			else reject(new Error(message));
		};
		child.once("error", () => fail("Cannot start the local database supervisor."));
		child.once("exit", () => { if (!stopping) fail("The local database stopped. Restart LearnHarness Any Preview."); });
		child.on("message", (message) => {
			if (message?.type === "failed") { fail(message.message); return; }
			if (ready || stopping || message?.type !== "ready") return;
			try {
				const url = new URL(message.url);
				if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || message.dataDir !== dataDir || typeof message.accountId !== "string" || !message.accountId) throw new Error("Invalid workspace");
			} catch { fail("The database supervisor returned an invalid workspace."); return; }
			clearTimeout(timer); ready = true;
			resolve({ ...message, version: release.version, stop });
		});
	});
}

module.exports = { startAnySupervisor };
