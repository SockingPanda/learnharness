import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ChatGPTCatalogEntry } from "../core/contracts/chatgpt.ts";

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Account capabilities take precedence over the bundled API catalog. New
 * models need explicit text input, context and at least one supported effort;
 * an id/name alone never grants guessed capabilities. Pi currently has no
 * `ultra` level, so unrepresentable efforts are not offered by the picker. */
export function resolveChatGPTModel(entry: ChatGPTCatalogEntry, supported: Model<"openai-responses">[]): Model<"openai-responses"> | undefined {
	if (!entry || typeof entry.id !== "string" || !entry.id || /[\x00-\x20\x7f]/.test(entry.id) || typeof entry.name !== "string") return;
	const known = supported.find((model) => model.id === entry.id && model.api === "openai-responses");
	const input = Array.isArray(entry.input) ? [...new Set(entry.input.filter((value) => value === "text" || value === "image"))] : undefined;
	const efforts = Array.isArray(entry.reasoningEfforts) ? entry.reasoningEfforts : undefined;
	const thinkingLevelMap = Object.fromEntries(levels.map((level) => {
		const effort = level === "off" ? "none" : level;
		return [level, efforts?.includes(effort) ? effort : null];
	})) as Record<ThinkingLevel, string | null>;
	const hasEffort = Object.values(thinkingLevelMap).some((value) => value !== null);
	if ((input && !input.includes("text")) || (efforts && !hasEffort)) return;
	if (!known && (!positiveInt(entry.contextWindow) || !input?.includes("text") || !hasEffort)) return;
	return {
		...known,
		id: entry.id,
		name: entry.name,
		api: "openai-responses",
		provider: "chatgpt",
		baseUrl: "https://api.openai.com/v1",
		input: input?.includes("text") ? input : known!.input,
		contextWindow: positiveInt(entry.contextWindow) ? entry.contextWindow : known!.contextWindow,
		// The account endpoint does not advertise an output ceiling. Zero is
		// unknown (projected as null); chatGPTPayload omits max_output_tokens
		// and lets the subscription transport choose its output budget.
		maxTokens: known?.maxTokens ?? 0,
		reasoning: hasEffort ? efforts!.some((effort) => effort !== "none" && levels.includes(effort as ThinkingLevel)) : known!.reasoning,
		...(hasEffort ? { thinkingLevelMap } : {}),
		headers: undefined,
		samplingParams: undefined,
		samplingParamsByThinkingLevel: undefined,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}
