/**
 * Build a valid single- or multi-page PDF containing known text.
 *
 * Generating the fixture keeps a binary blob out of the repository and lets a
 * test assert on text it chose itself, so extraction is verified end to end
 * through the real pdf.js pipeline rather than against a mock.
 */
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

		const stream = `BT /F1 24 Tf 72 700 Td (${escapePdfText(text)}) Tj ET`;
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

function escapePdfText(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
