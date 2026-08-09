import { describe, expect, it } from "vitest";

import { truncateOutput } from "../../src/runtime/truncate.js";

describe("truncateOutput", () => {
	it("returns short text unchanged", () => {
		const result = truncateOutput("hello", 1024);
		expect(result).toEqual({ text: "hello", truncated: false, originalBytes: 5 });
	});

	it("passes text that exactly fills the budget", () => {
		const text = "x".repeat(100);
		expect(truncateOutput(text, 100).truncated).toBe(false);
	});

	it("truncates oversized text and says so", () => {
		const result = truncateOutput("x".repeat(5000), 1024);

		expect(result.truncated).toBe(true);
		expect(result.originalBytes).toBe(5000);
		expect(result.text).toMatch(/\[truncated: 4\.9 KB of output, capped at 1\.0 KB\]$/);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(1024);
	});

	it("measures bytes rather than characters", () => {
		// Each CJK character is 3 bytes in UTF-8.
		const text = "文".repeat(100); // 300 bytes, 100 chars
		expect(truncateOutput(text, 400).truncated).toBe(false);
		expect(truncateOutput(text, 200).truncated).toBe(true);
	});

	it("never emits a replacement character from a split multi-byte sequence", () => {
		// 201 is deliberately not a multiple of 3, so the cut lands mid-character.
		const result = truncateOutput("文".repeat(300), 201);

		expect(result.truncated).toBe(true);
		expect(result.text).not.toContain("�");
	});

	it("keeps emoji intact rather than splitting a surrogate pair", () => {
		const result = truncateOutput("👩‍🔬".repeat(200), 300);

		expect(result.truncated).toBe(true);
		expect(result.text).not.toContain("�");
		// No lone surrogate survived the cut.
		expect(/[\uD800-\uDFFF]/.test(result.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(
			false,
		);
	});
});
