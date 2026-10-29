import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { pdfReadingPages } from "../src/agent/subagents/pdf-ops.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");

/** Real PDF objects with computed xref offsets. The image-only page has
 * no hidden text layer, as in a scanned PDF without OCR. */
function pdfWithPages(contents: string[]): Uint8Array {
	const objects: string[] = [];
	const pageIds = contents.map((_, i) => 3 + i * 2);
	const fontId = 3 + contents.length * 2;
	const imageId = fontId + 1;
	objects[1] = "<</Type/Catalog/Pages 2 0 R>>";
	objects[2] = `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(" ")}]/Count ${contents.length}>>`;
	contents.forEach((stream, i) => {
		const pageId = pageIds[i]!;
		const contentId = pageId + 1;
		objects[pageId] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentId} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>/XObject<</Scan ${imageId} 0 R>>>>>>`;
		objects[contentId] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
	});
	objects[fontId] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
	objects[imageId] = "<</Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/ASCIIHexDecode/Length 7>>\nstream\n000000>\nendstream";
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let id = 1; id < objects.length; id++) {
		offsets[id] = pdf.length;
		pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]!).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<</Size ${objects.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}

function textPage(text: string): string {
	return `BT /F1 12 Tf 72 720 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`;
}

const SCANNED_PAGE = "q 200 0 0 200 72 500 cm /Scan Do Q";

describe("PDF reading sources", () => {
	it("extracts all real fixture pages without changing the archival bytes", async () => {
		const bytes = new Uint8Array(await readFile(FIXTURE));
		const original = bytes.slice();
		const pages = await pdfReadingPages(bytes);
		assert.deepEqual(pages.map((page) => page.page), [1, 2, 3]);
		assert.match(pages[0]!.text, /Calculus/);
		assert.match(pages[1]!.text, /force/);
		assert.match(pages[2]!.text, /Chemistry/);
		assert.ok(pages.every((page) => !page.text.startsWith("--- Page")));
		assert.deepEqual(bytes, original);
	});

	it("preserves line boundaries reported by the PDF text layer", async () => {
		const bytes = pdfWithPages(["BT /F1 12 Tf 72 720 Td (First line) Tj 0 -20 Td (Second line) Tj ET"]);
		assert.deepEqual(await pdfReadingPages(bytes), [{ page: 1, text: "First line\nSecond line" }]);
	});

	it("returns empty text for an image-only scan instead of inventing page-title content", async () => {
		assert.deepEqual(await pdfReadingPages(pdfWithPages([SCANNED_PAGE]), { maxChars: 0 }), [{ page: 1, text: "" }]);
	});

	it("retains scanned and blank pages between text pages with their actual page numbers", async () => {
		const bytes = pdfWithPages([textPage("Opening"), SCANNED_PAGE, "", textPage("Conclusion")]);
		assert.deepEqual(await pdfReadingPages(bytes), [
			{ page: 1, text: "Opening" },
			{ page: 2, text: "" },
			{ page: 3, text: "" },
			{ page: 4, text: "Conclusion" },
		]);
	});

	it("enforces the character limit across pages without returning a truncated source", async () => {
		const bytes = pdfWithPages([textPage("abc"), textPage("def")]);
		assert.deepEqual(await pdfReadingPages(bytes, { maxChars: 6 }), [{ page: 1, text: "abc" }, { page: 2, text: "def" }]);
		await assert.rejects(pdfReadingPages(bytes, { maxChars: 5 }), /exceeds the 5 character limit/);
	});

	it("rejects extraction when the caller already cancelled", async () => {
		const controller = new AbortController();
		const reason = new Error("Reading cancelled");
		controller.abort(reason);
		await assert.rejects(pdfReadingPages(pdfWithPages([textPage("Source")]), { signal: controller.signal }), (error) => error === reason);
	});

	it("honors cancellation after extraction has started", async () => {
		const controller = new AbortController();
		const reason = new Error("Reading cancelled after starting");
		const pending = pdfReadingPages(pdfWithPages([textPage("Source")]), { signal: controller.signal });
		controller.abort(reason);
		await assert.rejects(pending, (error) => error === reason);
	});

	it("rejects invalid PDF bytes instead of treating them as plain text", async () => {
		await assert.rejects(pdfReadingPages(new TextEncoder().encode("This is not a PDF.")), /Invalid PDF/);
	});
});
