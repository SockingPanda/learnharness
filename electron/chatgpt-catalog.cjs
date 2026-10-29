"use strict";

// Only capability data crosses the private catalog boundary. Never forward
// account instructions, endpoint overrides, credentials, or arbitrary fields.
function projectChatGPTModel(model) {
	if (!model || model.visibility !== "list" || model.supported_in_api === false || typeof model.slug !== "string" || !model.slug || /[\x00-\x20\x7f]/.test(model.slug) || typeof model.display_name !== "string") return null;
	const entry = { id: model.slug, name: model.display_name };
	if (Number.isSafeInteger(model.context_window) && model.context_window > 0) entry.contextWindow = model.context_window;
	if (Array.isArray(model.input_modalities)) entry.input = model.input_modalities.filter((value) => value === "text" || value === "image");
	if (Array.isArray(model.supported_reasoning_levels)) entry.reasoningEfforts = model.supported_reasoning_levels.flatMap((level) => typeof level?.effort === "string" ? [level.effort] : []);
	return entry;
}
module.exports = { projectChatGPTModel };
