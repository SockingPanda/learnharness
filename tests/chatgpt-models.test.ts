import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { resolveChatGPTModel } from "../src/agent/chatgpt-models.ts";
import { toModelDto } from "../src/server/model-catalog.ts";
const { projectChatGPTModel } = createRequire(import.meta.url)("../electron/chatgpt-catalog.cjs");
const raw = () => ({ slug: "gpt-future-terra", display_name: "Future Terra", visibility: "list", context_window: 500000, max_context_window: 872000, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "max" }, { effort: "ultra" }] });

test("new account models resolve without a static catalog entry and use account capabilities", () => {
	const entry = projectChatGPTModel({ ...raw(), base_instructions: "do not forward", headers: { Authorization: "do not forward" }, baseUrl: "https://example.invalid" });
	assert.deepEqual(Object.keys(entry).sort(), ["contextWindow", "id", "input", "name", "reasoningEfforts"]);
	const model = resolveChatGPTModel(entry, []);
	assert(model);
	assert.equal(model.provider, "chatgpt");
	assert.equal(model.baseUrl, "https://api.openai.com/v1");
	assert.equal(model.contextWindow, 500000, "use the active window, not optional maximum context");
	assert.deepEqual(model.input, ["text", "image"]);
	assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "max"]);
	assert.equal(toModelDto(model).maxTokens, null, "unknown output capacity is never invented");
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("incomplete or unsupported account metadata does not invent new model capabilities", () => {
	for (const patch of [{ context_window: 0 }, { context_window: NaN }, { context_window: "500000" }, { input_modalities: ["audio"] }, { supported_reasoning_levels: [{ effort: "ultra" }] }, { supported_reasoning_levels: undefined }]) {
		assert.equal(resolveChatGPTModel(projectChatGPTModel({ ...raw(), ...patch }), []), undefined);
	}
	assert.equal(resolveChatGPTModel({ id: "unknown", name: "Unknown" }, []), undefined);
	assert.equal(projectChatGPTModel({ ...raw(), visibility: "hide" }), null);
	assert.equal(projectChatGPTModel({ ...raw(), supported_in_api: false }), null);
	assert.equal(projectChatGPTModel({ ...raw(), slug: "bad\nmodel" }), null);
});

test("known models retain compatibility metadata while live limits/modalities/efforts win", () => {
	const known: Model<"openai-responses"> = { id: "gpt-future-terra", name: "Old", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 128000, cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { max: "max" }, compat: { supportsStrictMode: true }, headers: { Authorization: "must not survive" }, samplingParams: { temperature: 1 } };
	const model = resolveChatGPTModel(projectChatGPTModel({ ...raw(), input_modalities: ["text"], supported_reasoning_levels: [{ effort: "none" }] }), [known])!;
	assert.equal(model.contextWindow, 500000);
	assert.deepEqual(model.input, ["text"]);
	assert.equal(model.reasoning, false);
	assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
	assert.deepEqual(model.compat, known.compat);
	assert.equal(model.headers, undefined);
	assert.equal(model.samplingParams, undefined);
	assert.equal(model.maxTokens, 128000);
	assert.equal(resolveChatGPTModel(projectChatGPTModel({ ...raw(), input_modalities: ["audio"] }), [known]), undefined);
	assert.equal(resolveChatGPTModel(projectChatGPTModel({ ...raw(), supported_reasoning_levels: [{ effort: "ultra" }] }), [known]), undefined);
	assert.equal(resolveChatGPTModel({ id: known.id, name: "Legacy owner" }, [known])?.contextWindow, 272000);
});
