/**
 * Filesystem-safe identifiers.
 *
 * One implementation, because these ids have to agree across module boundaries:
 * ingest names `text/<slug>.md` from a filename, a fan-out derives its item id
 * from that same stem, and the search layer names a downloaded paper the same
 * way. Two slug functions that differ by one character produce a fan-out whose
 * cache never hits and whose resume cannot match an output to its source.
 *
 * NFKD folds accents onto ASCII, but scripts without a Latin decomposition —
 * Chinese, Japanese, Korean, Cyrillic — are stripped entirely and fall back to
 * `fallback`. Anything user-supplied that names a directory therefore needs a
 * separate ASCII handle rather than being slugged from prose.
 */

/** Long enough for a descriptive filename, short enough for every filesystem. */
const MAX_SLUG_LENGTH = 80;

export function slug(value: string, fallback = "item", maxLength = MAX_SLUG_LENGTH): string {
	const cleaned = value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (cleaned.length === 0) return fallback;
	// Trim to the limit, then drop a trailing hyphen the cut may have exposed.
	return cleaned.slice(0, maxLength).replace(/-+$/g, "") || fallback;
}

/**
 * Disambiguate a slug against those already used, deterministically.
 *
 * Suffixes depend on the order slugs are offered, so callers must feed them in a
 * stable order — sorted filenames, or a sorted record list — or adding one item
 * would silently rebind every later id.
 */
export function uniqueSlug(candidate: string, used: Set<string>): string {
	if (!used.has(candidate)) {
		used.add(candidate);
		return candidate;
	}
	let attempt = 2;
	while (used.has(`${candidate}-${attempt}`)) attempt += 1;
	const result = `${candidate}-${attempt}`;
	used.add(result);
	return result;
}
