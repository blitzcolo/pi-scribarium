/**
 * Build a valid single- or multi-page PDF containing known text.
 *
 * Generating the fixture keeps a binary blob out of the repository and lets a
 * test assert on text it chose itself, so extraction is verified end to end
 * through the real pdf.js pipeline rather than against a mock.
 */
/**
 * A page marker padded out to the length of a real body page.
 *
 * Ingest rejects a PDF whose pages fall below `MIN_PAGE_CHARACTERS`, since that
 * is what a scan with only a page number extracted looks like. A fixture built
 * from a bare marker is indistinguishable from one, so tests that mean "an
 * ordinary paper" have to say so — otherwise they assert against input no real
 * corpus contains.
 */
export function bodyPage(marker: string, repeats = 12): string {
	const filler = "This sentence exists to give the page a realistic text density. ";
	return `${marker} ${filler.repeat(repeats)}`;
}

export function minimalPdf(pageTexts: readonly string[]): Uint8Array {
	const objects: string[] = [];

	const pageCount = pageTexts.length;
	// Object numbering: 1 catalog, 2 pages, 3 font, then per page a page object
	// and its content stream.
	const firstPageObject = 4;
	const pageObjectIds = pageTexts.map((_, i) => firstPageObject + i * 2);
	const contentObjectIds = pageTexts.map((_, i) => firstPageObject + i * 2 + 1);

	objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[2] =
		`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] ` +
		`/Count ${pageCount} >>`;
	objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

	pageTexts.forEach((text, index) => {
		const pageId = pageObjectIds[index] as number;
		const contentId = contentObjectIds[index] as number;
		objects[pageId] =
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
			`/Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;

		// Text must be wrapped into lines. A single over-wide Tj runs past the
		// MediaBox and pdf.js drops the overflowing glyphs, so a one-line fixture
		// silently truncates at ~80 characters and makes extraction look lossy
		// when it is not. Real PDFs always wrap; the fixture must too.
		const lines = wrapText(text, 70);
		const body = lines.map((line) => `(${escapePdfText(line)}) Tj T*`).join("\n");
		const stream = `BT\n/F1 11 Tf\n14 TL\n72 720 Td\n${body}\nET`;
		objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	});

	const chunks: string[] = ["%PDF-1.4\n"];
	const offsets: number[] = [];
	let position = chunks[0]!.length;

	for (let id = 1; id < objects.length; id++) {
		const body = objects[id];
		if (body === undefined) continue;
		offsets[id] = position;
		const serialized = `${id} 0 obj\n${body}\nendobj\n`;
		chunks.push(serialized);
		position += serialized.length;
	}

	const objectCount = objects.length;
	let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
	for (let id = 1; id < objectCount; id++) {
		xref += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
	}
	chunks.push(xref);
	chunks.push(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`);

	return new Uint8Array(Buffer.from(chunks.join(""), "latin1"));
}

/** Greedy word wrap, splitting any single word longer than the limit. */
function wrapText(text: string, limit: number): string[] {
	const lines: string[] = [];
	let current = "";

	for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
		let remaining = word;
		while (remaining.length > limit) {
			if (current.length > 0) {
				lines.push(current);
				current = "";
			}
			lines.push(remaining.slice(0, limit));
			remaining = remaining.slice(limit);
		}
		if (current.length === 0) current = remaining;
		else if (current.length + 1 + remaining.length <= limit) current += ` ${remaining}`;
		else {
			lines.push(current);
			current = remaining;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

function escapePdfText(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
