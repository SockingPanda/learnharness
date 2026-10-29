import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatStore } from "../src/core/ports.ts";
import { runPiTurn } from "../src/server/pi/ui-stream.ts";
import { persistTurn } from "../src/server/turn-service.ts";

/** No engine or network: exercise the runner's awaited listener seam. */
function agentEndingWith(loopFailure?: Error): Agent {
	const listeners: Array<(event: never) => unknown> = [];
	return {
		state: { messages: [] },
		subscribe(listener: (event: never) => unknown) { listeners.push(listener); return () => {}; },
		async continue() {
			await Promise.resolve(); // let the view subscribe before the terminal
			if (loopFailure) throw loopFailure;
			for (const listener of listeners) await listener({ type: "agent_end", messages: [] } as never);
		},
		abort() {},
	} as unknown as Agent;
}

function wireFrames(wire: string): string[] {
	return wire.split("\n\n").filter(Boolean).map(frame => frame.slice("data: ".length));
}

describe("turn settlement recovery", () => {
	it("reports a failed canonical save before DONE and cleans up before reporting", async () => {
		const order: string[] = [];
		const handle = runPiTurn({
			agent: agentEndingWith(),
			onFinish() { order.push("save"); throw new Error("synthetic disk failure"); },
			onSettleFailure() { order.push("cleanup"); },
			onSettleError() { order.push("report"); return "The reply could not be saved."; },
		});
		const frames = wireFrames(await new Response(handle.subscribe()).text());
		assert.deepEqual(order, ["save", "cleanup", "report"]);
		assert.equal(frames.at(-1), "[DONE]");
		assert.equal(frames.filter(f => f.includes('"type":"error"')).length, 1);
		assert.ok(frames.at(-2)?.includes("The reply could not be saved."));
	});

	it("still reports settlement failure when cleanup itself throws", async () => {
		const handle = runPiTurn({
			agent: agentEndingWith(),
			onFinish() { throw new Error("synthetic save failure"); },
			onSettleFailure() { throw new Error("synthetic cleanup failure"); },
			onSettleError: () => "The reply could not be saved.",
		});
		const frames = wireFrames(await new Response(handle.subscribe()).text());
		assert.equal(frames.at(-1), "[DONE]");
		assert.equal(frames.filter(f => f.includes('"type":"error"')).length, 1);
	});

	it("does not replace an already reported loop failure with a second settlement error", async () => {
		let cleanups = 0;
		const handle = runPiTurn({
			agent: agentEndingWith(new Error("synthetic loop failure")),
			onError: () => "An error occurred.",
			onFinish() { throw new Error("synthetic save failure"); },
			onSettleFailure(error, reportedErrorText) {
				cleanups++;
				assert.match(String(error), /synthetic save failure/);
				assert.equal(reportedErrorText, "An error occurred.");
			},
		});
		const frames = wireFrames(await new Response(handle.subscribe()).text());
		assert.equal(cleanups, 1);
		assert.equal(frames.filter(f => f.includes('"type":"error"')).length, 1);
		assert.equal(frames.at(-1), "[DONE]");
	});

	it("a healthy terminal follows persistence and emits no error", async () => {
		let saves = 0;
		const handle = runPiTurn({ agent: agentEndingWith(), onFinish() { saves++; } });
		const frames = wireFrames(await new Response(handle.subscribe()).text());
		assert.equal(saves, 1);
		assert.equal(frames.at(-1), "[DONE]");
		assert.equal(frames.some(f => f.includes('"type":"error"')), false);
	});

	it("does not contain a canonical write failure as an empty successful persist", async () => {
		const store = {
			getChat: async () => ({ messages: [] }),
			async appendMessages() { throw new Error("synthetic disk failure"); },
		} as unknown as ChatStore;
		const message = { role: "assistant", content: [{ type: "text", text: "Synthetic reply" }], stopReason: "stop", timestamp: 1 } as AgentMessage;
		await assert.rejects(() => persistTurn(store, "fixture", 0, [message], false), /The reply could not be saved\./);
	});
});


describe("asynchronous turn persistence", () => {
	it("withholds agent_end and DONE until the canonical write resolves", async () => {
		let finish!: () => void;
		let started!: () => void;
		const writing = new Promise<void>((resolve) => { started = resolve; });
		const saved = new Promise<void>((resolve) => { finish = resolve; });
		const handle = runPiTurn({ agent: agentEndingWith(), onFinish: async () => { started(); await saved; } });
		let completed = false;
		const result = new Response(handle.subscribe()).text().then((wire) => { completed = true; return wireFrames(wire); });
		await writing;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(completed, false);
		finish();
		const frames = await result;
		assert.equal(JSON.parse(frames.at(-2)!).type, "agent_end");
		assert.equal(frames.at(-1), "[DONE]");
	});

	it("reports an asynchronous save rejection after awaited cleanup without a successful terminal", async () => {
		const order: string[] = [];
		const handle = runPiTurn({
			agent: agentEndingWith(),
			onFinish: async () => { await Promise.resolve(); throw new Error("database disconnected"); },
			onSettleFailure: async () => { await Promise.resolve(); order.push("cleaned"); },
			onSettleError: () => { order.push("reported"); return "The reply could not be saved."; },
		});
		const frames = wireFrames(await new Response(handle.subscribe()).text());
		assert.deepEqual(order, ["cleaned", "reported"]);
		assert.equal(frames.some((frame) => frame.includes('"type":"agent_end"')), false);
		assert.match(frames.at(-2)!, /could not be saved/);
		assert.equal(frames.at(-1), "[DONE]");
	});
});

describe("native message append retry", () => {
	it("reuses native message identities after an acknowledged write is lost and preserves concurrent input", async () => {
		const { chatStore } = await import("../src/store/chats.ts");
		const { newUserMessage } = await import("../src/core/native-messages.ts");
		const { fauxAssistantMessage, fauxThinking, fauxText } = await import("@earendil-works/pi-ai");
		const chat = await chatStore.createChat("Atomic turn append");
		const concurrent = newUserMessage("A new question during settlement");
		let firstRead = true, lostResponse = true;
		const store: ChatStore = { ...chatStore,
			getChat: async (id) => {
				const snapshot = await chatStore.getChat(id);
				if (firstRead) { firstRead = false; await chatStore.appendMessages(id, [concurrent]); }
				return snapshot;
			},
			appendMessages: async (id, messages) => {
				await chatStore.appendMessages(id, messages);
				if (lostResponse) { lostResponse = false; throw new Error("Committed reply lost its acknowledgement"); }
			},
		};
		const message = fauxAssistantMessage([{ ...fauxThinking("Signed reasoning"), thinkingSignature: "provider-signature" }, fauxText("Native reply")]);
		await assert.rejects(persistTurn(store, chat.id, 0, [message], false), /could not be saved/);
		const retried = await persistTurn(store, chat.id, 0, [message], false);
		const saved = (await chatStore.getChat(chat.id))!.messages;
		assert.equal(saved.length, 2);
		assert.deepEqual(saved[0], concurrent);
		assert.deepEqual(saved[1], { ...message, id: retried[0]!.id });
	});
});
