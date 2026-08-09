import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkCitations, formatCitationReport } from "../../src/checks/citations.js";

let workspace: string;

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-cite-"));
	fs.mkdirSync(path.join(workspace, "corpus", "text"), { recursive: true });
	fs.mkdirSync(path.join(workspace, "final"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
});

function corpus(name: string, body: string): void {
	fs.writeFileSync(path.join(workspace, "corpus", "text", name), body);
}

function manuscript(body: string): void {
	fs.writeFileSync(path.join(workspace, "final", "paper.md"), body);
}

const check = () =>
	checkCitations({
		workspace,
		manuscript: "final/paper.md",
		sources: ["corpus/text", "analysis/papers", "source"],
	});

describe("checkCitations", () => {
	it("accepts a citation whose author and year both appear in the corpus", () => {
		corpus("era5.md", "Hersbach, H. et al. (2020). The ERA5 global reanalysis.");
		manuscript("We use reanalysis data [Hersbach 2020].");

		const report = check();
		expect(report.citations).toHaveLength(1);
		expect(report.citations[0]?.verdict).toBe("supported");
		expect(report.unsupported).toEqual([]);
	});

	// The failure this whole check exists for.
	it("flags a citation that appears nowhere in the workspace", () => {
		corpus("era5.md", "Hersbach, H. et al. (2020). The ERA5 global reanalysis.");
		manuscript("Prior work established this [Fictitious 2019].");

		const report = check();
		expect(report.unsupported).toHaveLength(1);
		expect(report.unsupported[0]?.raw).toBe("[Fictitious 2019]");
	});

	it("separates a wrong year from an invented author", () => {
		corpus("era5.md", "Hersbach, H. et al. (2020). The ERA5 global reanalysis.");
		manuscript("One [Hersbach 1999] and one [Nobody 2019].");

		const report = check();
		expect(report.yearMismatches.map((c) => c.surname)).toEqual(["Hersbach"]);
		expect(report.unsupported.map((c) => c.surname)).toEqual(["Nobody"]);
	});

	it.each([
		["[Clough et al. 2005]", "Clough"],
		["[Smith and Jones 2021]", "Smith"],
		["[Ito 2024b]", "Ito"],
	])("parses the citation form %s", (citation, surname) => {
		corpus("index.md", "Clough 2005. Smith and Jones 2021. Ito 2024.");
		manuscript(`Text ${citation} more text.`);

		const report = check();
		expect(report.citations[0]?.surname).toBe(surname);
		expect(report.citations[0]?.verdict).toBe("supported");
	});

	it("counts each distinct citation once however often it appears", () => {
		corpus("index.md", "Hersbach 2020");
		manuscript("[Hersbach 2020] and again [Hersbach 2020] and once more [Hersbach 2020].");
		expect(check().citations).toHaveLength(1);
	});

	it("draws on the author's own material as well as the corpus", () => {
		fs.mkdirSync(path.join(workspace, "source"), { recursive: true });
		fs.writeFileSync(path.join(workspace, "source", "notes.md"), "Following Zhang 2023 we...");
		manuscript("As shown previously [Zhang 2023].");

		expect(check().unsupported).toEqual([]);
	});

	it("does not accept guidance files as evidence", () => {
		corpus("_README.md", "Nobody 2019 is mentioned only in the guidance file.");
		manuscript("A claim [Nobody 2019].");

		expect(check().unsupported).toHaveLength(1);
	});

	// Markers are the author's declared to-do list. Treating them as defects
	// would punish exactly the honesty the rest of the pipeline encourages.
	it("collects outstanding markers without counting them as failures", () => {
		manuscript(
			[
				"# Paper",
				"EVIDENCE NEEDED: RMSE against the LBLRTM baseline",
				"Some prose.",
				"CITATION NEEDED: the claim about polar profiles",
				"SECTION MISSING: ablation was not drafted.",
			].join("\n"),
		);

		const report = check();
		expect(report.unsupported).toEqual([]);
		expect(report.markers.map((m) => m.kind)).toEqual([
			"EVIDENCE NEEDED",
			"CITATION NEEDED",
			"SECTION MISSING",
		]);
		expect(report.markers[0]?.line).toBe(2);
		expect(report.markers[0]?.text).toMatch(/RMSE/);
	});

	it("ignores bracketed text that is not a citation", () => {
		manuscript("A list [1] and [see below] and [Table 2] and [TODO].");
		expect(check().citations).toEqual([]);
	});
});

describe("formatCitationReport", () => {
	it("leads with the unsupported citations and explains both causes", () => {
		corpus("index.md", "nothing relevant");
		manuscript("A claim [Invented 2020].");

		const text = formatCitationReport(check());
		expect(text).toContain("## Unsupported citations");
		expect(text).toContain("[Invented 2020]");
		expect(text).toMatch(/fabricated|missing from the/);
	});

	it("says so plainly when everything traces", () => {
		corpus("index.md", "Hersbach 2020");
		manuscript("[Hersbach 2020]");

		expect(formatCitationReport(check())).toContain("Every citation traces to a document");
	});
});
