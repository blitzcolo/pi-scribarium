import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Citation verification.
 *
 * Deliberately deterministic code rather than an agent. A fabricated citation is
 * the one failure in this domain that destroys the author's credibility rather
 * than merely wasting their time, and a model asked to check its own citations
 * can be argued out of a finding — or can hallucinate the supporting evidence
 * just as easily as it hallucinated the reference. This pass can only compare
 * strings against files on disk, which is exactly the property that makes it
 * trustworthy.
 *
 * The check is intentionally conservative: it answers "does anything in the
 * corpus support this citation existing at all", not "is it cited correctly".
 * It catches the invented reference, which is what matters.
 */

export type CitationVerdict = "supported" | "year-mismatch" | "unsupported";

export interface CitationFinding {
	/** As written in the manuscript, e.g. `[Hersbach 2020]`. */
	raw: string;
	surname: string;
	year: string;
	verdict: CitationVerdict;
	/** Where in the source index the surname was found, when it was. */
	foundIn?: string;
}

export interface MarkerFinding {
	kind: "EVIDENCE NEEDED" | "CITATION NEEDED" | "SECTION MISSING";
	line: number;
	text: string;
}

export interface CitationReport {
	manuscript: string;
	citations: CitationFinding[];
	markers: MarkerFinding[];
	indexedFiles: number;
	get unsupported(): CitationFinding[];
	get yearMismatches(): CitationFinding[];
}

/**
 * Matches `[Surname 2020]`, `[Surname et al. 2020]`, `[Surname and Other 2020b]`.
 *
 * Deliberately shaped as "an author part, then a year": enumerating the ways
 * co-authors can be joined ("et al.", "and", "&", ",") is a losing game, and the
 * year is the reliable anchor. Requiring an uppercase first letter and no digits
 * in the author part keeps `[1]`, `[Table 2]`, and `[see below]` out.
 */
const CITATION = /\[\s*(\p{Lu}[^\]\d]*?)\s+(\d{4}[a-z]?)\s*\]/gu;

const MARKER = /\b(EVIDENCE NEEDED|CITATION NEEDED|SECTION MISSING)\b\s*:?\s*(.*)/;

export interface CheckOptions {
	workspace: string;
	/** Manuscript to check, relative to the workspace. */
	manuscript: string;
	/** Directories whose contents count as evidence a reference exists. */
	sources: readonly string[];
}

export function checkCitations(options: CheckOptions): CitationReport {
	const manuscriptPath = path.resolve(options.workspace, options.manuscript);
	const text = fs.readFileSync(manuscriptPath, "utf-8");

	const index = buildIndex(options.workspace, options.sources);
	const citations = extractCitations(text, index);
	const markers = extractMarkers(text);

	return {
		manuscript: options.manuscript,
		citations,
		markers,
		indexedFiles: index.fileCount,
		get unsupported() {
			return citations.filter((c) => c.verdict === "unsupported");
		},
		get yearMismatches() {
			return citations.filter((c) => c.verdict === "year-mismatch");
		},
	};
}

interface SourceIndex {
	/** Lowercased text of every indexed file, keyed by relative path. */
	documents: Array<{ path: string; text: string }>;
	fileCount: number;
}

function buildIndex(workspace: string, sources: readonly string[]): SourceIndex {
	const documents: Array<{ path: string; text: string }> = [];

	for (const source of sources) {
		const root = path.resolve(workspace, source);
		for (const file of walk(root)) {
			// Guidance files are not evidence; ingest skips them for the same reason.
			const name = path.basename(file);
			if (name.startsWith(".") || name.startsWith("_") || /^readme\./i.test(name)) continue;
			try {
				documents.push({
					path: path.relative(workspace, file),
					text: fs.readFileSync(file, "utf-8").toLowerCase(),
				});
			} catch {
				// Unreadable files simply provide no support.
			}
		}
	}

	return { documents, fileCount: documents.length };
}

function* walk(root: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (entry.isFile()) yield full;
	}
}

function extractCitations(text: string, index: SourceIndex): CitationFinding[] {
	const seen = new Map<string, CitationFinding>();

	for (const match of text.matchAll(CITATION)) {
		const raw = match[0];
		if (seen.has(raw)) continue;

		// The first token is the surname that will appear in a bibliography;
		// "et al." and co-author names are noise for this purpose.
		const surname = (match[1] ?? "").split(/\s+/)[0] ?? "";
		const year = match[2] ?? "";
		const surnameKey = surname.toLowerCase();
		// Strip a disambiguating suffix: 2020a and 2020b are both the year 2020.
		const yearKey = year.slice(0, 4);

		const withBoth = index.documents.find(
			(doc) => doc.text.includes(surnameKey) && doc.text.includes(yearKey),
		);
		if (withBoth !== undefined) {
			seen.set(raw, { raw, surname, year, verdict: "supported", foundIn: withBoth.path });
			continue;
		}

		const withSurname = index.documents.find((doc) => doc.text.includes(surnameKey));
		seen.set(
			raw,
			withSurname === undefined
				? { raw, surname, year, verdict: "unsupported" }
				: { raw, surname, year, verdict: "year-mismatch", foundIn: withSurname.path },
		);
	}

	return [...seen.values()];
}

function extractMarkers(text: string): MarkerFinding[] {
	const findings: MarkerFinding[] = [];
	text.split("\n").forEach((line, i) => {
		const match = MARKER.exec(line);
		if (match?.[1] === undefined) return;
		findings.push({
			kind: match[1] as MarkerFinding["kind"],
			line: i + 1,
			text: (match[2] ?? "").trim(),
		});
	});
	return findings;
}

export function formatCitationReport(report: CitationReport): string {
	const lines = [
		`# Citation check: ${report.manuscript}`,
		"",
		`Checked ${report.citations.length} distinct citation(s) against ${report.indexedFiles} indexed file(s).`,
		"",
	];

	if (report.unsupported.length > 0) {
		lines.push("## Unsupported citations", "");
		lines.push(
			"Nothing in the corpus or the author's material mentions these. Either the",
			"reference is fabricated, or the supporting document is missing from the",
			"workspace. Both need the author's attention before submission.",
			"",
		);
		for (const finding of report.unsupported) {
			lines.push(`- ${finding.raw} — no document mentions "${finding.surname}"`);
		}
		lines.push("");
	} else {
		lines.push("## Unsupported citations", "", "None. Every citation traces to a document.", "");
	}

	if (report.yearMismatches.length > 0) {
		lines.push("## Possible year errors", "");
		for (const finding of report.yearMismatches) {
			lines.push(`- ${finding.raw} — "${finding.surname}" appears in ${finding.foundIn}, ${finding.year} does not`);
		}
		lines.push("");
	}

	const byKind = new Map<string, MarkerFinding[]>();
	for (const marker of report.markers) {
		const bucket = byKind.get(marker.kind);
		if (bucket === undefined) byKind.set(marker.kind, [marker]);
		else bucket.push(marker);
	}

	lines.push("## Author's outstanding work", "");
	if (byKind.size === 0) {
		lines.push("No markers left in the manuscript.", "");
	} else {
		lines.push("These are known gaps the pipeline left deliberately, not defects.", "");
		for (const [kind, markers] of byKind) {
			lines.push(`### ${kind} (${markers.length})`, "");
			for (const marker of markers) {
				lines.push(`- line ${marker.line}: ${marker.text || "(no detail given)"}`);
			}
			lines.push("");
		}
	}

	return lines.join("\n");
}
