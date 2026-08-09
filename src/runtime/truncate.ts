export interface TruncationResult {
	text: string;
	truncated: boolean;
	/** Byte length of the original text, before any truncation. */
	originalBytes: number;
}

/**
 * Truncate text to a byte budget without splitting a multi-byte character.
 *
 * Stage output is handed back to the orchestrator and may be embedded in a
 * later prompt, so it is capped. The full text is always written to an artifact
 * file first; this only bounds what travels in memory.
 *
 * Cutting a UTF-8 buffer mid-character yields U+FFFD when decoded, so trailing
 * replacement characters are stripped rather than passed on.
 */
export function truncateOutput(text: string, limitBytes: number): TruncationResult {
	const buffer = Buffer.from(text, "utf8");
	const originalBytes = buffer.length;
	if (originalBytes <= limitBytes) {
		return { text, truncated: false, originalBytes };
	}

	const notice = `\n\n[truncated: ${formatBytes(originalBytes)} of output, capped at ${formatBytes(limitBytes)}]`;
	const budget = Math.max(0, limitBytes - Buffer.byteLength(notice, "utf8"));
	const head = buffer.subarray(0, budget).toString("utf8").replace(/�+$/, "");

	return { text: `${head}${notice}`, truncated: true, originalBytes };
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
