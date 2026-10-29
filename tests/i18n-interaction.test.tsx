import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { I18nProvider, useI18n } from "../components/i18n.tsx";
import { LOCALE_CHANGE_SIGNAL } from "../src/core/i18n.ts";

const dom = parseHTML("<html lang='en'><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
});
let languages = ["en-US"];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
	get languages() { return languages; }, get language() { return languages[0]; },
} });
let cookie = "";
Object.defineProperty(document, "cookie", {
	configurable: true, get: () => cookie,
	set: (value: string) => { cookie = value.split(";")[0]!; },
});
let storedSignal: string | null = null;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
	setItem(key: string, value: string) { assert.equal(key, LOCALE_CHANGE_SIGNAL); storedSignal = value; },
} });
let root: Root | undefined;
let host: HTMLDivElement | undefined;

function Surface() {
	const { t, preference, setPreference } = useI18n();
	return <div>
		<span data-testid="label">{t("Interface language")}</span>
		<span data-testid="preference">{preference}</span>
		<button onClick={() => setPreference("zh-CN")}>Chinese</button>
		<button onClick={() => setPreference("en")}>English</button>
		<button onClick={() => setPreference("system")}>System</button>
		<textarea defaultValue="My question in progress" />
	</div>;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined; host?.remove(); host = undefined;
	cookie = ""; storedSignal = null; languages = ["en-US"];
});

async function mount() {
	host = document.createElement("div"); document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<I18nProvider><Surface /></I18nProvider>));
}
const label = () => host!.querySelector('[data-testid="label"]')!.textContent;
async function click(index: number) {
	await act(async () => host!.querySelectorAll("button")[index]!.dispatchEvent(new Event("click", { bubbles: true })));
}

describe("live interface language", () => {
	it("switches, persists and broadcasts without remounting a draft", async () => {
		await mount();
		const draft = host!.querySelector("textarea")!;
		draft.value = "A draft I have edited";
		await click(0);
		assert.equal(label(), "界面语言");
		assert.equal(document.documentElement.lang, "zh-CN");
		assert.equal(cookie, "lh-locale=zh-CN");
		assert.ok(storedSignal);
		assert.equal(host!.querySelector("textarea"), draft);
		assert.equal(draft.value, "A draft I have edited");
		await click(1);
		assert.equal(label(), "Interface language");
		assert.equal(document.documentElement.lang, "en");
	});
	it("follows system changes only in automatic mode and receives other-window changes", async () => {
		await mount();
		languages = ["zh-CN"];
		await act(async () => window.dispatchEvent(new Event("languagechange")));
		assert.equal(label(), "界面语言");
		await click(1);
		await act(async () => window.dispatchEvent(new Event("languagechange")));
		assert.equal(label(), "Interface language");
		await click(2);
		assert.equal(label(), "界面语言");
		cookie = "lh-locale=en";
		const event = new Event("storage"); Object.assign(event, { key: LOCALE_CHANGE_SIGNAL });
		await act(async () => window.dispatchEvent(event));
		assert.equal(label(), "Interface language");
		cookie = "lh-locale=invalid";
		await act(async () => window.dispatchEvent(new Event("focus")));
		assert.equal(host!.querySelector('[data-testid="preference"]')!.textContent, "system");
		assert.equal(label(), "界面语言");
	});
	it("hydrates server-selected Chinese without mismatches or replacing content", async () => {
		cookie = "lh-locale=zh-CN";
		const tree = <I18nProvider initialLocale="zh-CN" initialPreference="zh-CN"><Surface /></I18nProvider>;
		host = document.createElement("div"); host.innerHTML = renderToString(tree); document.body.appendChild(host);
		const draft = host.querySelector("textarea");
		const errors: unknown[] = [];
		await act(async () => { root = hydrateRoot(host!, tree, { onRecoverableError: (error) => errors.push(error) }); });
		assert.deepEqual(errors, []);
		assert.equal(label(), "界面语言");
		assert.equal(host.querySelector("textarea"), draft);
	});
});
