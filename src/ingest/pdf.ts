import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * Corpus ingestion.
 *
 * pi's `read` tool has no PDF path — it handles images, but a PDF reaches the
 * model as unusable bytes (CLAUDE.md gotcha #15). Since the corpus stage is the
 * very first fan-out, a deterministic non-LLM pass converts every source
 * document to Markdown first. Extraction is pure code: no model, no cost, and
 * reproducible, which also makes the expensive analysis stage cacheable.
 *
 * Text is emitted one page at a time behind `<!-- page N -->` markers so that
 * later stages, and the M4 citation checker, can cite a page rather than a file.
 */

export type IngestStatus = "extracted" | "copied" | "skipped" | "failed";

export interface IngestedFile {
	status: IngestStatus;
	sourcePath: string;
	outputPath: string;
	totalPages?: number;
	characters?: number;
	/** 1-based pages with no usable text layer. Present even when extraction succeeded. */
	textlessPages?: number[];
	error?: string;
}

/**
 * Below this many characters, a page carries no usable text.
 *
 * Measured against a real corpus of 22 CVPR papers: 237 pages, of which the
 * thinnest genuine page held 65 characters and the median page held 4 766. A
 * hundred therefore sits an order of magnitude below any real body page while
 * still catching a scan whose only extractable text is a page number — which is
 * the failure that otherwise reaches an analysis agent looking like a paper.
 */
export const MIN_PAGE_CHARACTERS = 100;

/**
 * Above this fraction of textless pages, the document is a scan, not a paper
 * with figures. Below it, textless pages are reported but extraction proceeds:
 * a full-page figure is ordinary, and 1 page in 237 of the measured corpus is
 * legitimately near-empty.
 */
export const MAX_TEXTLESS_FRACTION = 0.5;

export interface IngestResult {
	files: IngestedFile[];
	get succeeded(): number;
	get failed(): number;
}

export interface IngestOptions {
	/** Source files. `.pdf` is extracted; `.md`/`.txt`/`.tex` are copied through. */
	inputs: readonly string[];
	/** Directory to write Markdown into. Created if absent. */
	outDir: string;
	/** Re-extract even when the output is newer than the source. */
	force?: boolean;
	onProgress?: (file: IngestedFile) => void;
}

// `.tex` is passed through as-is: it is already text, and the markup carries
// real signal about structure (\section, \cite) that is worth keeping rather
// than stripping.
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".markdown", ".tex"]);

/**
 * Files that live in a corpus directory but are not corpus documents.
 *
 * `scribarium init` drops guidance files into corpus/ and source/, and without
 * this they are ingested and analysed as if they were papers from the target
 * journal — quietly contaminating the profile the whole pipeline is built on.
 */
function isNotADocument(name: string): boolean {
	return name.startsWith(".") || name.startsWith("_") || /^readme\.[a-z]+$/i.test(name);
}

/** Filesystem-safe, stable identifier derived from a file name. */
export function slugify(filePath: string): string {
	const base = path.basename(filePath, path.extname(filePath));
	const slug = base
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "document";
}

/**
 * pdf.js calls `Math.sumPrecise`, a TC39 proposal that Node does not yet
 * implement. Without it every page logs "TypeError: Math.sumPrecise is not a
 * function" and glyph positioning falls back to a less accurate path. Neumaier
 * summation gives the compensated result the proposal specifies.
 */
function ensureSumPrecise(): void {
	const math = Math as unknown as { sumPrecise?: (values: Iterable<number>) => number };
	if (typeof math.sumPrecise === "function") return;

	math.sumPrecise = (values: Iterable<number>): number => {
		let sum = 0;
		let compensation = 0;
		for (const value of values) {
			const next = sum + value;
			compensation +=
				Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
			sum = next;
		}
		return sum + compensation;
	};
}

/** Extract per-page text from one PDF. */
export async function extractPdfPages(pdfPath: string): Promise<string[]> {
	ensureSumPrecise();
	// Imported lazily: unpdf pulls in a pdf.js build, which is far too heavy to
	// load for commands that never touch a PDF.
	const { extractText } = await import("unpdf");
	const data = new Uint8Array(await fsp.readFile(pdfPath));
	const { text } = await extractText(data, { mergePages: false });
	return text;
}

/**
 * Convert a corpus of source documents into Markdown under `outDir`.
 *
 * One unreadable or corrupt file is recorded as a failure and does not stop the
 * rest, matching how the pipeline treats fan-out items generally.
 */
export async function ingestCorpus(options: IngestOptions): Promise<IngestResult> {
	await fsp.mkdir(options.outDir, { recursive: true });

	const files: IngestedFile[] = [];
	const usedSlugs = new Map<string, number>();

	for (const sourcePath of options.inputs) {
		const slug = uniqueSlug(slugify(sourcePath), usedSlugs);
		const outputPath = path.join(options.outDir, `${slug}.md`);

		let record: IngestedFile;
		try {
			record = await ingestOne(sourcePath, outputPath, options.force === true);
		} catch (error) {
			record = {
				status: "failed",
				sourcePath,
				outputPath,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		files.push(record);
		options.onProgress?.(record);
	}

	return {
		files,
		get succeeded() {
			return files.filter((f) => f.status !== "failed").length;
		},
		get failed() {
			return files.filter((f) => f.status === "failed").length;
		},
	};
}

async function ingestOne(
	sourcePath: string,
	outputPath: string,
	force: boolean,
): Promise<IngestedFile> {
	if (!force && (await isUpToDate(sourcePath, outputPath))) {
		return { status: "skipped", sourcePath, outputPath };
	}

	const extension = path.extname(sourcePath).toLowerCase();

	if (TEXT_EXTENSIONS.has(extension)) {
		const body = await fsp.readFile(sourcePath, "utf-8");
		const document = renderDocument(sourcePath, [body], { paginated: false });
		await fsp.writeFile(outputPath, document, "utf-8");
		return { status: "copied", sourcePath, outputPath, characters: body.length };
	}

	if (extension !== ".pdf") {
		return {
			status: "failed",
			sourcePath,
			outputPath,
			error: `unsupported extension "${extension}" (expected .pdf, .md, .txt, or .tex)`,
		};
	}

	const pages = await extractPdfPages(sourcePath);
	const characters = pages.reduce((sum, page) => sum + page.length, 0);

	// Per page, not in total. A ten-page scan with one readable page still sums
	// to a plausible-looking character count, and the nine lost pages would
	// never be mentioned again — the analysis agent is told to read the paper
	// start to finish and has no way to know it received a tenth of one.
	const textlessPages = pages
		.map((page, index) => ({ chars: page.trim().length, page: index + 1 }))
		.filter(({ chars }) => chars < MIN_PAGE_CHARACTERS)
		.map(({ page }) => page);

	const scanned = pages.length === 0 || textlessPages.length === pages.length;
	const mostlyScanned = textlessPages.length > pages.length * MAX_TEXTLESS_FRACTION;

	if (scanned || mostlyScanned) {
		return {
			status: "failed",
			sourcePath,
			outputPath,
			totalPages: pages.length,
			characters,
			textlessPages,
			error: scanned
				? `no text layer on any of ${pages.length} page(s); ` +
					"the PDF is a scan and needs OCR (try `ocrmypdf in.pdf out.pdf`) " +
					"before it can be analysed"
				: `no text layer on ${textlessPages.length} of ${pages.length} page(s) ` +
					`(${formatPageRanges(textlessPages)}); the PDF is partly scanned, and analysing ` +
					"the readable fraction would misrepresent the paper — OCR it first",
		};
	}

	await fsp.writeFile(
		outputPath,
		renderDocument(sourcePath, pages, { paginated: true, textlessPages }),
		"utf-8",
	);
	return {
		status: "extracted",
		sourcePath,
		outputPath,
		totalPages: pages.length,
		characters,
		...(textlessPages.length > 0 ? { textlessPages } : {}),
	};
}

/** `[3, 4, 5, 9]` as `3-5, 9`, so a long list stays readable in one line. */
export function formatPageRanges(pages: readonly number[]): string {
	const ranges: string[] = [];
	for (let i = 0; i < pages.length; ) {
		const start = pages[i] as number;
		let end = start;
		while (i + 1 < pages.length && pages[i + 1] === end + 1) {
			end = pages[++i] as number;
		}
		ranges.push(start === end ? `${start}` : `${start}-${end}`);
		i++;
	}
	return ranges.join(", ");
}

function renderDocument(
	sourcePath: string,
	pages: readonly string[],
	options: { paginated: boolean; textlessPages?: readonly number[] },
): string {
	const frontmatter = [
		"---",
		`source: ${JSON.stringify(path.resolve(sourcePath))}`,
		`pages: ${options.paginated ? pages.length : 1}`,
		// Recorded in the document itself, not only in the run log: an agent
		// reading this file is the one that would otherwise report on a figure
		// page as though it had been blank in the original.
		...(options.textlessPages !== undefined && options.textlessPages.length > 0
			? [`textless_pages: [${options.textlessPages.join(", ")}]`]
			: []),
		"---",
		"",
	].join("\n");

	if (!options.paginated) {
		return `${frontmatter}${pages.join("")}\n`;
	}

	const body = pages
		.map((page, index) => `<!-- page ${index + 1} -->\n\n${page.trim()}`)
		.join("\n\n");
	return `${frontmatter}${body}\n`;
}

async function isUpToDate(sourcePath: string, outputPath: string): Promise<boolean> {
	try {
		const [source, output] = await Promise.all([fsp.stat(sourcePath), fsp.stat(outputPath)]);
		return output.mtimeMs >= source.mtimeMs;
	} catch {
		return false;
	}
}

/**
 * Disambiguate identical basenames coming from different directories.
 *
 * The generated name has to be registered too, and checked against the names
 * already taken: `a/paper.pdf` and `b/paper.pdf` yield `paper` and `paper-2`,
 * and a real `paper-2.pdf` in the same batch would otherwise be handed `paper-2`
 * as well — two papers written to one file, the second silently overwriting the
 * first, both reported as extracted.
 */
function uniqueSlug(slug: string, used: Map<string, number>): string {
	if (!used.has(slug)) {
		used.set(slug, 1);
		return slug;
	}
	let attempt = (used.get(slug) ?? 1) + 1;
	let candidate = `${slug}-${attempt}`;
	while (used.has(candidate)) {
		attempt++;
		candidate = `${slug}-${attempt}`;
	}
	used.set(slug, attempt);
	used.set(candidate, 1);
	return candidate;
}

/**
 * Expand a list of files and directories into concrete source documents.
 *
 * `only` narrows the accepted extensions. `source/` uses it to extract PDFs
 * without also copying the author's Markdown into `source/text/`: those files
 * are already readable where they are, and duplicating them would put the same
 * material in front of a writing agent twice.
 */
export function collectCorpusInputs(
	paths: readonly string[],
	only?: ReadonlySet<string>,
): string[] {
	const accepts = (extension: string): boolean =>
		only !== undefined
			? only.has(extension)
			: extension === ".pdf" || TEXT_EXTENSIONS.has(extension);

	const found: string[] = [];
	for (const entry of paths) {
		let stats: fs.Stats;
		try {
			stats = fs.statSync(entry);
		} catch {
			continue;
		}
		if (stats.isDirectory()) {
			let children: fs.Dirent[];
			try {
				children = fs.readdirSync(entry, { withFileTypes: true });
			} catch {
				// An unreadable directory is skipped, not fatal. This runs for every
				// configured directory before any extraction starts, so an optional
				// `references/` on a stale mount would otherwise take down the
				// required `corpus/` with it, before a single document was read.
				continue;
			}
			for (const child of children) {
				if (!child.isFile()) continue;
				if (isNotADocument(child.name)) continue;
				if (accepts(path.extname(child.name).toLowerCase())) {
					found.push(path.join(entry, child.name));
				}
			}
		} else if (only === undefined || only.has(path.extname(entry).toLowerCase())) {
			// A file named explicitly is passed through even when unsupported, so
			// it fails with "unsupported extension .docx" rather than vanishing
			// into "no documents found".
			found.push(entry);
		}
	}
	return found.sort();
}

/** Parse an `only:` value — `pdf`, `.pdf`, `pdf, md`, or a YAML list. */
export function parseExtensionFilter(value: unknown): ReadonlySet<string> | undefined {
	const raw = Array.isArray(value)
		? value.map(String)
		: typeof value === "string"
			? value.split(",")
			: undefined;
	if (raw === undefined) return undefined;

	const set = new Set(
		raw
			.map((entry) => entry.trim().toLowerCase())
			.filter((entry) => entry.length > 0)
			.map((entry) => (entry.startsWith(".") ? entry : `.${entry}`)),
	);
	return set.size > 0 ? set : undefined;
}
