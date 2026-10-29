/** Private Node-mode child: IPC disconnection is proof that its desktop owner died. */
const { startAnyRuntime } = require("./any-runtime.cjs");

async function supervise() {
	if (!process.channel || !process.connected) throw new Error("Any supervisor requires inherited parent IPC");
	const controller = new AbortController();
	let runtime;
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		controller.abort();
		await runtime?.stop();
		// If startup is in flight, its abort catch owns final process exit.
		if (runtime) process.exit(0);
	};
	process.once("disconnect", stop);
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	process.on("error", () => { void stop(); });
	process.on("message", (message) => { if (message?.type === "stop") void stop(); });
	const send = (message) => {
		if (!process.connected) { void stop(); return; }
		try { process.send(message, (error) => { if (error) void stop(); }); }
		catch { void stop(); }
	};
	try {
		runtime = await startAnyRuntime({ binary: process.argv[2], dataDir: process.argv[3], signal: controller.signal });
		if (stopping || !process.connected) { await runtime.stop(); process.exit(0); }
		send({ type: "ready", url: runtime.url, accountId: runtime.accountId, dataDir: runtime.dataDir, pid: runtime.pid });
		const exit = await runtime.exited;
		if (!stopping && process.connected) send({ type: "failed", message: "The local database stopped. Restart LearnHarness Any Preview." });
		process.exit(exit.expected ? 0 : 1);
	} catch (error) {
		await runtime?.stop();
		if (!stopping && process.connected) send({ type: "failed", message: error.message });
		process.exit(stopping ? 0 : 1);
	}
}

if (require.main === module) supervise().catch(() => process.exit(1));
module.exports = { supervise };
