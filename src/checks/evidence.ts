import * as fs from "node:fs";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

/**
 * Group the analyst cards by the innovation point each one bears on.
 *
 * This is what lets the judge fan out. One session per candidate reading only
 * that candidate's evidence beats one session reading all hundred and fifty
 * cards: the context stays clean, a single verdict can be re-run without
 * redoing the rest, and the judgements are independent rather than drifting
 * toward whatever the last few cards happened to say.
 *
 * The header of each packet is the honest part. A verdict of "nobody has done
 * this" built on three abstracts and two failed downloads is a different claim
 * from one built on twenty full texts, and the difference has to reach the judge
 * as a number rather than as an impression.
 */

export interface EvidenceCard {
	file: string;
	title: string;
	year: string;
	venue: string;
	evidenceLevel: "full_text" | "abstract_only";
	citationCount?: number;
}

export interface EvidencePacket {
	point: string;
	title: string;
	cards: EvidenceCard[];
	fullText: number;
	abstractOnly: number;
	/** Papers relevant to this point that could not be fetched at all. */
	downloadFailed: number;
	markdown: string;
}

export interface EvidenceReport {
	packets: EvidencePacket[];
	/** Cards whose frontmatter could not be read. */
	unreadable: string[];
	/** Cards naming a point that is not in the candidate list. */
	orphaned: string[];
	/** Follow-ups collated but never fetched — pruned by a human or cut by the cap. */
	unchasedFollowups: number;
}

interface CardFrontmatter {
	title?: unknown;
	year?: unknown;
	venue?: unknown;
	citation_count?: unknown;
	evidence_level?: unknown;
	related_points?: unknown;
}

export interface CollateEvidenceOptions {
	workspace: string;
	/** Directory of analyst cards, relative to the workspace. */
	cards: string;
	/** `candidates.json`, relative to the workspace. */
	candidates: string;
	/** Fetch manifest, relative to the workspace. Optional but strongly wanted. */
	manifest?: string;
	/** Round-2 query list, to count what was proposed. */
	followups?: string;
	/** Round-2 results, to count what was actually fetched. */
	results?: string;
}

export function collateEvidence(options: CollateEvidenceOptions): EvidenceReport {
	const candidates = readCandidates(path.resolve(options.workspace, options.candidates));
	const root = path.resolve(options.workspace, options.cards);

	const unreadable: string[] = [];
	const orphaned: string[] = [];
	const known = new Set(candidates.map((candidate) => candidate.id));
	const byPoint = new Map<string, EvidenceCard[]>(candidates.map((c) => [c.id, []]));

	for (const file of listCards(root)) {
		const relative = path.relative(options.workspace, file).replaceAll("\\", "/");
		let frontmatter: CardFrontmatter;
		try {
			frontmatter = readFrontmatter(fs.readFileSync(file, "utf-8"));
		} catch {
			unreadable.push(relative);
			continue;
		}

		const card: EvidenceCard = {
			file: relative,
			title: text(frontmatter.title) || path.basename(file, ".md"),
			year: text(frontmatter.year) || "unknown",
			venue: text(frontmatter.venue) || "unknown",
			evidenceLevel: text(frontmatter.evidence_level) === "abstract_only" ? "abstract_only" : "full_text",
		};
		const citations = Number.parseInt(text(frontmatter.citation_count), 10);
		if (Number.isFinite(citations)) card.citationCount = citations;

		const points = stringList(frontmatter.related_points);
		for (const point of points) {
			const bucket = byPoint.get(point);
			if (bucket === undefined) {
				// A card naming a point the human pruned away is not an error — it is
				// the expected consequence of pruning — but it is worth reporting so a
				// typo in a point id does not silently discard evidence.
				orphaned.push(`${relative} -> ${point}`);
				continue;
			}
			bucket.push(card);
		}
	}

	const failedByPoint = readFailedByPoint(options);
	const unchased = countUnchased(options);

	const packets = candidates.map((candidate) => {
		const cards = (byPoint.get(candidate.id) ?? []).sort(
			(a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0) || a.title.localeCompare(b.title),
		);
		const fullText = cards.filter((card) => card.evidenceLevel === "full_text").length;
		const packet: EvidencePacket = {
			point: candidate.id,
			title: candidate.title,
			cards,
			fullText,
			abstractOnly: cards.length - fullText,
			downloadFailed: failedByPoint.get(candidate.id) ?? 0,
			markdown: "",
		};
		packet.markdown = render(packet, unchased, known.size);
		return packet;
	});

	return { packets, unreadable, orphaned, unchasedFollowups: unchased };
}

interface Candidate {
	id: string;
	title: string;
}

function readCandidates(file: string): Candidate[] {
	let parsed: { candidates?: unknown };
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { candidates?: unknown };
	} catch (cause) {
		throw new Error(`Cannot read candidate innovation points from ${file}: ${String(cause)}`);
	}
	if (!Array.isArray(parsed.candidates)) {
		throw new Error(`${file} must hold a "candidates" array`);
	}

	const out: Candidate[] = [];
	for (const entry of parsed.candidates) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const id = text(record["id"]);
		if (id === "") continue;
		out.push({ id, title: text(record["title"]) || id });
	}
	return out;
}

/** Papers that reached neither full text nor an abstract, per point. */
function readFailedByPoint(options: CollateEvidenceOptions): Map<string, number> {
	const counts = new Map<string, number>();
	if (options.manifest === undefined) return counts;

	let manifest: { papers?: unknown };
	try {
		manifest = JSON.parse(
			fs.readFileSync(path.resolve(options.workspace, options.manifest), "utf-8"),
		) as { papers?: unknown };
	} catch {
		return counts;
	}
	if (!Array.isArray(manifest.papers)) return counts;

	for (const entry of manifest.papers) {
		if (typeof entry !== "object" || entry === null) continue;
		const paper = entry as Record<string, unknown>;
		if (text(paper["status"]) !== "failed") continue;
		for (const point of stringList(paper["points"])) {
			counts.set(point, (counts.get(point) ?? 0) + 1);
		}
	}
	return counts;
}

/**
 * Follow-ups proposed for round two that no paper came back for.
 *
 * Either a human pruned them at the gate or round two found nothing under that
 * title. Both are legitimate; neither should be invisible to a judge about to
 * write "no precedent found".
 */
function countUnchased(options: CollateEvidenceOptions): number {
	if (options.followups === undefined) return 0;

	const proposed = readJsonArray(options.workspace, options.followups, "queries").length;
	if (proposed === 0) return 0;
	if (options.results === undefined) return proposed;

	const fetched = readJsonArray(options.workspace, options.results, "papers").length;
	return Math.max(0, proposed - fetched);
}

function readJsonArray(workspace: string, file: string, key: string): unknown[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.resolve(workspace, file), "utf-8")) as Record<
			string,
			unknown
		>;
		const value = parsed[key];
		return Array.isArray(value) ? value : [];
	} catch {
		return [];
	}
}

function render(packet: EvidencePacket, unchased: number, totalPoints: number): string {
	const total = packet.cards.length;
	const lines: string[] = [
		`# Evidence for ${packet.point}: ${packet.title}`,
		"",
		"## Coverage",
		"",
		`- **${total} analysed paper(s)** bear on this candidate` +
			(totalPoints > 1 ? " out of the whole searched corpus." : "."),
		`- ${packet.fullText} read in full text, ${packet.abstractOnly} from the abstract only.`,
		`- ${packet.downloadFailed} related paper(s) could not be fetched at all.`,
		`- ${unchased} follow-up reference(s) were proposed but never fetched.`,
		"",
		"State these numbers in your verdict. A judgement resting mostly on abstracts,",
		"or made while papers were missing, is a weaker claim than the same judgement",
		"over full texts, and the reader cannot tell the two apart unless you say so.",
		"",
	];

	if (total === 0) {
		// An empty packet is written rather than skipped: the judge must be able to
		// tell "the search found nothing" from "the packet was never built", and a
		// missing file looks like the second.
		lines.push(
			"## No evidence",
			"",
			"The search returned no analysed paper relevant to this candidate.",
			"",
			"That is weak evidence of novelty, not strong evidence: it is equally",
			"consistent with the queries having been wrong. Say which you think it is,",
			"and say what query would settle it.",
			"",
		);
		return `${lines.join("\n").trimEnd()}\n`;
	}

	lines.push(
		"## Cards",
		"",
		"Read every card listed here. Do not open the full papers — the cards are the",
		"contract, and re-reading the corpus would cost more than the analysis did.",
		"",
		"| Evidence | Year | Venue | Cited | Title | Card |",
		"|---|---|---|---|---|---|",
	);
	for (const card of packet.cards) {
		lines.push(
			`| ${card.evidenceLevel === "abstract_only" ? "abstract" : "full text"} ` +
				`| ${cell(card.year)} | ${cell(card.venue)} | ${card.citationCount ?? "?"} ` +
				`| ${cell(card.title)} | \`${card.file}\` |`,
		);
	}
	lines.push("");

	return `${lines.join("\n").trimEnd()}\n`;
}

function readFrontmatter(content: string): CardFrontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (match === null) return {};
	const parsed = parseYaml(match[1] ?? "") as unknown;
	return typeof parsed === "object" && parsed !== null ? (parsed as CardFrontmatter) : {};
}

function listCards(root: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.filter((entry) => !entry.name.startsWith(".") && !entry.name.startsWith("_"))
		.map((entry) => path.join(root, entry.name))
		.sort();
}

function stringList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value.map((entry) => text(entry)) : text(value).split(",");
	return raw.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

function text(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number") return String(value);
	return "";
}

function cell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}
