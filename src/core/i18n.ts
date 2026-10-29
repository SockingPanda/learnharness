/** Browser-safe UI localization. Saved conversation and model content never
 * pass through this catalog. English source messages are stable catalog keys. */
import { shellMessages } from "./i18n/shell.ts";
import { chatMessages } from "./i18n/chat.ts";
import { settingsMessages } from "./i18n/settings.ts";
import { graphMessages } from "./i18n/graph.ts";
import { supportMessages } from "./i18n/support.ts";
import { readingMessages } from "./i18n/reading.ts";

export const UI_LOCALES = ["en", "zh-CN"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
export type LocalePreference = UiLocale | "system";
export const LOCALE_COOKIE = "lh-locale";
export const LOCALE_CHANGE_SIGNAL = "lh:locale-changed";
export const APP_DESCRIPTION = "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.";

export const commonMessages = {
	"Interface language": "界面语言",
	"Follow system": "跟随系统",
	"Saved on this device. Applies to the interface.": "保存在当前设备中，用于界面显示。",
	"Working": "处理中",
	[APP_DESCRIPTION]: "拥有记忆的 AI 导师：通过会话、测验和知识图谱，记录你掌握的知识。",
	"The connection dropped before the turn completed.": "本轮回复尚未完成，连接已中断。",
	"The turn stream body is empty.": "本轮回复的数据流为空。",
	"The tool call failed.": "工具调用失败。",
	"Failed to attach to the running turn.": "无法连接正在进行的回复。",
	"An error occurred.": "发生错误。",
	"A turn is already running — try again in a moment.": "已有回复正在进行，请稍后再试。",
} as const;

export const UI_MESSAGES: Readonly<Record<string, string>> = {
	...commonMessages,
	...shellMessages,
	...chatMessages,
	...settingsMessages,
	...graphMessages,
	...supportMessages,
	...readingMessages,
};

export function isLocalePreference(value: unknown): value is LocalePreference {
	return value === "system" || value === "en" || value === "zh-CN";
}

export function localePreference(value: unknown): LocalePreference {
	return isLocalePreference(value) ? value : "system";
}

/** Accept-Language is ordered by quality, with stable order for ties. Browser
 * navigator.languages already supplies the same preference ordering. */
export function preferredLanguages(header: string | null | undefined): string[] {
	return (header ?? "").split(",").map((item, index) => {
		const [language = "", ...parameters] = item.trim().split(";");
		const quality = parameters.find((p) => p.trim().startsWith("q="));
		const q = quality === undefined ? 1 : Number(quality.trim().slice(2));
		return { language: language.trim(), q, index };
	}).filter(({ language, q }) => language && Number.isFinite(q) && q > 0 && q <= 1)
		.sort((a, b) => b.q - a.q || a.index - b.index).map(({ language }) => language);
}

export function resolveUiLocale(preference: LocalePreference, languages: readonly string[] = []): UiLocale {
	if (preference !== "system") return preference;
	for (const language of languages) {
		const base = language.trim().toLowerCase().replaceAll("_", "-").split("-")[0];
		if (base === "zh") return "zh-CN";
		if (base === "en") return "en";
	}
	return "en";
}

export function readLocaleCookie(cookies: string): LocalePreference {
	const value = cookies.split(";").map((entry) => entry.trim())
		.find((entry) => entry.startsWith(`${LOCALE_COOKIE}=`))?.slice(LOCALE_COOKIE.length + 1);
	try { return localePreference(value === undefined ? undefined : decodeURIComponent(value)); }
	catch { return "system"; }
}

export function serializeLocaleCookie(preference: LocalePreference): string {
	return `${LOCALE_COOKIE}=${preference}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export type TranslationValues = Readonly<Record<string, string | number>>;
export type Translator = (message: string, values?: TranslationValues) => string;

/** Unknown text (e.g. a provider error) is returned verbatim. Interpolation
 * substitutes only named values, never interprets HTML or model content. */
export function translateUi(locale: UiLocale, message: string, values?: TranslationValues): string {
	const text = locale === "zh-CN" && Object.hasOwn(UI_MESSAGES, message) ? UI_MESSAGES[message]! : message;
	if (!values) return text;
	return text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (token, name: string) =>
		Object.hasOwn(values, name) ? String(values[name]) : token);
}

export function createTranslator(locale: UiLocale): Translator {
	return (message, values) => translateUi(locale, message, values);
}
