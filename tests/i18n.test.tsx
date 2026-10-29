import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createTranslator, localePreference, preferredLanguages, readLocaleCookie,
	resolveUiLocale, serializeLocaleCookie, translateUi, UI_MESSAGES,
} from "../src/core/i18n.ts";
import { I18nProvider } from "../components/i18n.tsx";
import { LanguageSetting } from "../components/language-setting.tsx";
import { shellMessages } from "../src/core/i18n/shell.ts";
import { chatMessages } from "../src/core/i18n/chat.ts";
import { settingsMessages } from "../src/core/i18n/settings.ts";
import { graphMessages } from "../src/core/i18n/graph.ts";
import { supportMessages } from "../src/core/i18n/support.ts";
import { connectionMessages } from "../src/core/i18n/connections.ts";

describe("interface locale negotiation", () => {
	it("honors explicit choices, regional language tags, quality weights and supported fallbacks", () => {
		assert.equal(resolveUiLocale("en", ["zh-CN"]), "en");
		assert.equal(resolveUiLocale("zh-CN", ["en-US"]), "zh-CN");
		assert.equal(resolveUiLocale("system", ["zh_Hans_CN", "en"]), "zh-CN");
		assert.equal(resolveUiLocale("system", ["fr-FR", "en-GB", "zh-CN"]), "en");
		assert.equal(resolveUiLocale("system", ["fr-FR"]), "en");
		const preferences = preferredLanguages("fr;q=1, en-US;q=.2, zh-CN;q=.9, en;q=0, zh;q=bad");
		assert.deepEqual(preferences, ["fr", "zh-CN", "en-US"]);
		assert.equal(resolveUiLocale("system", preferences), "zh-CN");
		assert.equal(resolveUiLocale("system", preferredLanguages(undefined)), "en");
	});
	it("reads only the language cookie and tolerates corrupt or unsupported values", () => {
		for (const value of [undefined, null, "fr", "ZH", {}, "<script>"]) assert.equal(localePreference(value), "system");
		assert.equal(readLocaleCookie("other=zh-CN; lh-locale=en; a=b"), "en");
		assert.equal(readLocaleCookie("other-lh-locale=en; lh-locale=zh-CN"), "zh-CN");
		assert.equal(readLocaleCookie("lh-locale=%E0%A4%A"), "system");
		assert.equal(readLocaleCookie("lh-locale=fr"), "system");
		assert.match(serializeLocaleCookie("zh-CN"), /^lh-locale=zh-CN; Path=\/; Max-Age=31536000; SameSite=Lax$/);
	});
});

describe("interface translation catalog", () => {
	it("uses consistent translations for source messages shared by multiple UI areas", () => {
		const seen = new Map<string, string>();
		for (const catalog of [shellMessages, chatMessages, settingsMessages, graphMessages, supportMessages, connectionMessages]) {
			for (const [message, translation] of Object.entries(catalog)) {
				if (seen.has(message)) assert.equal(translation, seen.get(message), `conflicting translation: ${message}`);
				seen.set(message, translation);
			}
		}
	});
	it("keeps English and unknown content intact, without prototype lookups", () => {
		assert.equal(translateUi("en", "Interface language"), "Interface language");
		assert.equal(translateUi("zh-CN", "Interface language"), "界面语言");
		assert.equal(translateUi("zh-CN", "Unknown model result: x = 42"), "Unknown model result: x = 42");
		assert.equal(translateUi("zh-CN", "toString"), "toString");
		assert.equal(translateUi("zh-CN", "constructor"), "constructor");
		assert.equal(createTranslator("en")("{name}: {count}", { name: "$&<b>", count: 0 }), "$&<b>: 0");
		assert.equal(createTranslator("en")("{missing}", {}), "{missing}");
	});
	it("provides nonempty Chinese translations with matching named placeholders", () => {
		const parameters = (text: string) => [...new Set(text.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g) ?? [])].sort();
		assert.ok(Object.keys(UI_MESSAGES).length > 100);
		for (const [english, chinese] of Object.entries(UI_MESSAGES)) {
			assert.ok(chinese.trim(), `empty translation: ${english}`);
			assert.deepEqual(parameters(chinese), parameters(english), `placeholder mismatch: ${english}`);
		}
	});
	it("covers literal translation calls throughout the component tree", () => {
		const directory = new URL("../components/", import.meta.url).pathname;
		const paths: string[] = [];
		function collect(dir: string) {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) collect(path);
				else if (/\.tsx?$/.test(path)) paths.push(path);
			}
		}
		collect(directory);
		const missing: string[] = [];
		for (const path of paths) {
			const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
			function visit(node: ts.Node) {
				if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
					const key = node.arguments[0];
					if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && !Object.hasOwn(UI_MESSAGES, key.text)) {
						missing.push(`${path.slice(directory.length)}: ${key.text}`);
					}
				}
				ts.forEachChild(node, visit);
			}
			visit(file);
		}
		assert.deepEqual(missing, [], "every static UI message must have a Chinese translation");
	});
	it("renders the server-selected language immediately while leaving user content intact", () => {
		const content = "My own unchanged English note";
		const chinese = renderToStaticMarkup(<I18nProvider initialLocale="zh-CN" initialPreference="zh-CN"><LanguageSetting /><p>{content}</p></I18nProvider>);
		assert.match(chinese, /界面语言/);
		assert.match(chinese, /跟随系统/);
		assert.match(chinese, /value="zh-CN" selected=""/);
		assert.ok(chinese.includes(content));
		const english = renderToStaticMarkup(<LanguageSetting />);
		assert.match(english, /Interface language/);
		assert.match(english, /Follow system/);
	});
});
