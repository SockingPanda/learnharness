import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { I18nProvider, useI18n } from "../components/i18n.tsx";
import { DeleteSessionDialog } from "../components/delete-session-dialog.tsx";
import { DeleteNodeDialog } from "../components/delete-node-dialog.tsx";
import { NotesImportErrors, useNotesImport } from "../components/notes-import.tsx";
import type { LocalePreference } from "../src/core/i18n.ts";

// Exercise real request handlers, portals, and saved failure state. No request
// leaves this fixture, and language switches must never repeat a mutation.
const dom = parseHTML("<html lang='en'><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
	languages: ["en-US"], language: "en-US",
} });
let cookie = "";
Object.defineProperty(document, "cookie", {
	configurable: true, get: () => cookie,
	set: (value: string) => { cookie = value.split(";")[0]!; },
});
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem() {} } });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let switchLanguage: (preference: LocalePreference) => void;
let importer: ReturnType<typeof useNotesImport>;

function LanguageBridge() {
	switchLanguage = useI18n().setPreference;
	return null;
}

function ImportSurface() {
	importer = useNotesImport();
	return <NotesImportErrors errors={importer.errors} />;
}

async function mount(children: React.ReactNode) {
	host = document.createElement("div"); document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<I18nProvider><LanguageBridge />{children}</I18nProvider>));
}

async function selectLanguage(preference: LocalePreference) {
	await act(async () => switchLanguage(preference));
}

async function click(testid: string) {
	const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
	assert.ok(button, `missing ${testid}`);
	await act(async () => button.dispatchEvent(new Event("click", { bubbles: true })));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined; host?.remove(); host = undefined;
	cookie = "";
	globalThis.fetch = originalFetch;
});

describe("settled failures follow interface language", () => {
	for (const kind of ["session", "node"] as const) {
		it(`updates a ${kind} deletion fallback without repeating DELETE`, async () => {
			let requests = 0;
			globalThis.fetch = async (_url, init) => {
				assert.equal(init?.method, "DELETE");
				requests++;
				return Response.json({}, { status: 502 });
			};
			const noSuccess = () => assert.fail("a rejected deletion cannot succeed");
			await mount(kind === "session"
				? <DeleteSessionDialog chat={{ id: "fixture", title: "Settings" }} onClose={() => {}} onDeleted={noSuccess} />
				: <DeleteNodeDialog nodes={[{ id: "fixture", name: "Settings" }]} onClose={() => {}} onDeleted={noSuccess} />);
			await click(kind === "session" ? "delete-confirm" : "node-delete-confirm");
			const error = () => document.querySelector('[role="alert"]')!.textContent;
			assert.match(error()!, /Delete failed \(502\)/);
			await selectLanguage("zh-CN");
			assert.match(error()!, /删除失败（502）/);
			assert.equal(document.querySelector("code")!.textContent, "Settings", "the entity name is user content");
			await selectLanguage("en");
			assert.match(error()!, /Delete failed \(502\)/);
			assert.equal(requests, 1);
		});
	}

	it("retranslates an HTTP import failure and preserves filename and raw diagnostic details", async () => {
		let requests = 0;
		globalThis.fetch = async (_url, init) => {
			assert.equal(init?.method, "POST"); requests++;
			return Response.json({ error: "Unknown provider detail {name}" }, { status: 503 });
		};
		await mount(<ImportSurface />);
		const files = [new File(["notes"], "Settings.md")];
		await act(async () => importer.onImportFiles(files as unknown as FileList));
		const english = "Settings.md: Import request failed (HTTP 503): Unknown provider detail {name}. Please retry the file.";
		assert.deepEqual(importer.errors, [english]);
		await selectLanguage("zh-CN");
		assert.deepEqual(importer.errors, ["Settings.md: 导入请求失败（HTTP 503）: Unknown provider detail {name}。请重新导入该文件。"]);
		assert.equal(host!.querySelector('[role="alert"]')!.textContent, importer.errors[0]);
		await selectLanguage("en");
		assert.deepEqual(importer.errors, [english]);
		assert.equal(requests, 1);
	});

	it("uses the current language when a pending import settles after switching", async () => {
		let respond!: (response: Response) => void;
		let requests = 0;
		globalThis.fetch = async () => {
			requests++;
			return new Promise<Response>((resolve) => { respond = resolve; });
		};
		await mount(<ImportSurface />);
		await act(async () => importer.onImportFiles([new File(["notes"], "notes.md")] as unknown as FileList));
		assert.equal(importer.importing, true);
		await selectLanguage("zh-CN");
		await act(async () => respond(new Response("invalid JSON")));
		assert.equal(importer.importing, false);
		assert.deepEqual(importer.errors, ["notes.md: 导入响应无效，请重新导入该文件。"]);
		await selectLanguage("en");
		assert.deepEqual(importer.errors, ["notes.md: Invalid import response. Please retry the file."]);
		assert.equal(requests, 1);
	});
});
