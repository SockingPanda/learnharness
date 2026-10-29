import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { handleChatInput } from "../src/server/chat-handler.ts";
import { abortTurn, runningTurn } from "../src/server/turn-runs.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { stores } from "../src/server/stores.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";

const originals = { chat: { ...stores.chatStore }, job: { ...stores.jobStore }, mode: process.env.LH_STORAGE_BACKEND };
// Exercise the Any admission/receipt policy against the same async contract,
// with a deterministic local backend. Real Any persistence has separate tests.
Object.assign(stores.chatStore, chatStore);
Object.assign(stores.jobStore, jobStore);
process.env.LH_STORAGE_BACKEND = "any";
process.env.OPENROUTER_API_KEY ??= "test-key";
after(() => {
	Object.assign(stores.chatStore, originals.chat);
	Object.assign(stores.jobStore, originals.job);
	if (originals.mode === undefined) delete process.env.LH_STORAGE_BACKEND;
	else process.env.LH_STORAGE_BACKEND = originals.mode;
});
function latch() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}
async function createChat() {
	const chat = await chatStore.createChat("Any interrupted turn");
	await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "anthropic/claude-sonnet-4.6" } });
	return chat.id;
}
async function settle(chatId: string) {
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	assert.equal(isTurnRunning(chatId), false);
}

test("cancel during input save leaves one durable input, blocks automatic replay, and permits explicit retry", async () => {
	const chatId = await createChat();
	const entered = latch(), release = latch();
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxText("Explicit retry completed.")])]);
	let calls = 0;
	const factory: Parameters<typeof handleChatInput>[2] = (opts) => createTeacherAgent(undefined, {
		messages: opts.messages,
		engine: { model: faux.getModel(), streamFn: (...args) => { calls++; return faux.streamSimple(...args); } },
	});
	stores.chatStore.appendMessages = async (id, messages) => {
		if (id === chatId && messages.some((message) => message.role === "user")) {
			assert.ok((await chatStore.getChat(id))?.pendingTurnId, "interruption receipt precedes input persistence");
			entered.release(); await release.promise;
		}
		await chatStore.appendMessages(id, messages);
	};
	const preparing = handleChatInput(chatId, { type: "text", text: "Explain the article" }, factory);
	await entered.promise;
	assert.deepEqual(abortTurn(chatId), { ok: true });
	release.release();
	assert.equal((await preparing).status, 409);
	stores.chatStore.appendMessages = chatStore.appendMessages;
	assert.equal(calls, 0);
	let saved = (await chatStore.getChat(chatId))!;
	assert.equal(saved.messages.filter((message) => message.role === "user").length, 1);
	assert.ok(saved.pendingTurnId);
	assert.equal((await handleChatInput(chatId, { type: "continue" }, factory)).status, 409);
	assert.equal((await handleChatInput(chatId, { type: "steers", steers: [] }, factory)).status, 409);
	assert.equal(calls, 0);
	assert.equal((await handleChatInput(chatId, { type: "retry" }, factory)).status, 200);
	await settle(chatId);
	saved = (await chatStore.getChat(chatId))!;
	assert.equal(calls, 1);
	assert.equal(saved.pendingTurnId, undefined);
	assert.equal(saved.messages.filter((message) => message.role === "user").length, 1);
	assert.equal(saved.messages.filter((message) => message.role === "assistant").length, 1);
});

test("provider failure keeps the interrupted receipt until a successful explicit turn", async () => {
	const chatId = await createChat();
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "fixture provider failure" })]);
	const response = await handleChatInput(chatId, { type: "text", text: "Start reading" }, (opts) => createTeacherAgent(undefined, {
		messages: opts.messages, engine: { model: faux.getModel(), streamFn: faux.streamSimple },
	}));
	assert.equal(response.status, 200);
	await settle(chatId);
	assert.ok((await chatStore.getChat(chatId))?.pendingTurnId);
});
