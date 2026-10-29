import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createReadingSourceStore } from "../src/store/reading-sources.ts";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-reading-store-"));
	return { root, store: createReadingSourceStore(root), clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const web = {
	kind: "web" as const,
	originalUrl: "https://example.test/article?lang=中文#argument",
	resolvedUrl: "https://example.test/articles/final",
	content: Buffer.from("# 原文\n\nAn argument, with [evidence](https://example.test/evidence).\n\n```ts\nconst n = 1;\n```\n", "utf8"),
};

describe("original reading source storage", () => {
	it("saves a standalone Markdown file and original link, readable after reopening", () => {
		const { root, store, clean } = fixture();
		try {
			const archive = store.save("chat_web", web);
			assert.deepEqual(fs.readFileSync(path.join(root, "chat_web", "source.md")), web.content);
			const manifest = JSON.parse(fs.readFileSync(path.join(root, "chat_web", "metadata.json"), "utf8"));
			assert.equal(manifest.originalUrl, web.originalUrl);
			assert.equal(manifest.resolvedUrl, web.resolvedUrl);
			assert.equal(manifest.byteLength, web.content.byteLength);
			assert.deepEqual(createReadingSourceStore(root).get("chat_web"), { archive, content: web.content });
			assert.deepEqual(fs.readdirSync(root), ["chat_web"]);
		} finally { clean(); }
	});

	it("copies original PDF bytes independently of the input file", () => {
		const { root, store, clean } = fixture();
		try {
			const pdf = fs.readFileSync(new URL("./fixtures/sample-3page.pdf", import.meta.url));
			const original = path.join(root, "输入文档.pdf");
			fs.writeFileSync(original, pdf);
			const archive = store.save("chat_pdf", { kind: "pdf", originalPath: original, content: fs.readFileSync(original) });
			fs.unlinkSync(original);
			assert.equal(archive.fileName, "source.pdf");
			assert.deepEqual(fs.readFileSync(path.join(root, "chat_pdf", "source.pdf")), pdf);
			assert.equal(store.get("chat_pdf")!.archive.originalPath, original);
			assert.deepEqual(store.get("chat_pdf")!.content, pdf);
			assert.equal(fs.existsSync(path.join(root, "chat_pdf", "source.md")), false);
		} finally { clean(); }
	});

	it("retries the same save without rewriting, and refuses another source or changed bytes", () => {
		const { root, store, clean } = fixture();
		try {
			const original = store.save("chat_same", web);
			const file = path.join(root, "chat_same", "metadata.json");
			const originalMetadata = fs.readFileSync(file);
			assert.deepEqual(store.save("chat_same", { ...web, content: Uint8Array.from(web.content) }), original);
			assert.deepEqual(store.save("chat_same", { ...web, resolvedUrl: "https://example.test/new-location" }), original);
			assert.deepEqual(fs.readFileSync(file), originalMetadata);
			assert.throws(() => store.save("chat_same", { ...web, originalUrl: "https://example.test/another" }), /different saved source/);
			assert.throws(() => store.save("chat_same", { ...web, content: Buffer.from("Changed page") }), /different saved source/);
			assert.deepEqual(store.get("chat_same")!.content, web.content);
		} finally { clean(); }
	});

	it("does not publish incomplete writes and removes its temporary files after failure", (t) => {
		const { root, store, clean } = fixture();
		try {
			t.mock.method(fs, "renameSync", () => { throw new Error("disk unavailable"); });
			assert.throws(() => store.save("chat_failed", web), /disk unavailable/);
			assert.equal(store.get("chat_failed"), null);
			assert.deepEqual(fs.readdirSync(root), []);
		} finally { clean(); }
	});

	it("refuses damaged or missing source bytes without overwriting the existing archive", () => {
		const { root, store, clean } = fixture();
		try {
			store.save("chat_corrupt", web);
			const file = path.join(root, "chat_corrupt", "source.md");
			const changed = Buffer.from(web.content);
			changed[0] = 33;
			fs.writeFileSync(file, changed);
			assert.throws(() => store.get("chat_corrupt"), /incomplete or damaged/);
			assert.throws(() => store.save("chat_corrupt", web), /incomplete or damaged/);
			assert.deepEqual(fs.readFileSync(file), changed);
			fs.unlinkSync(file);
			assert.throws(() => store.get("chat_corrupt"), /incomplete or damaged/);
		} finally { clean(); }
	});

	it("rejects unsafe ids and manifest paths and deletes only the selected session", () => {
		const { root, store, clean } = fixture();
		try {
			for (const id of ["", ".", "..", "../outside", "nested/session", "nested\\session", "/absolute"]) {
				assert.throws(() => store.get(id), /Invalid chat id/);
				assert.throws(() => store.save(id, web), /Invalid chat id/);
				assert.throws(() => store.delete(id), /Invalid chat id/);
			}
			store.save("chat_keep", web);
			store.save("chat_remove", web);
			const manifestPath = path.join(root, "chat_remove", "metadata.json");
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, fileName: "../chat_keep/source.md" }));
			assert.throws(() => store.get("chat_remove"), /incomplete or damaged/);
			store.delete("chat_remove");
			store.delete("chat_missing");
			assert.equal(store.get("chat_remove"), null);
			assert.deepEqual(store.get("chat_keep")!.content, web.content);
		} finally { clean(); }
	});

	it("does not follow session or artifact symlinks outside the archive", () => {
		const { root, store, clean } = fixture();
		try {
			store.save("chat_keep", web);
			fs.symlinkSync(path.join(root, "chat_keep"), path.join(root, "chat_link"), "dir");
			assert.throws(() => store.get("chat_link"), /incomplete or damaged/);
			store.delete("chat_link");
			assert.deepEqual(store.get("chat_keep")!.content, web.content);
			store.save("chat_filelink", web);
			const file = path.join(root, "chat_filelink", "source.md");
			fs.unlinkSync(file);
			fs.symlinkSync(path.join(root, "chat_keep", "source.md"), file, "file");
			assert.throws(() => store.get("chat_filelink"), /incomplete or damaged/);
		} finally { clean(); }
	});
});
