import { describe, expect, it } from "vitest";
import { BANNER_HEIGHT, BANNER_WIDTH, bannerSvg, renderBannerPng } from "../src/banner.js";

function pngDimensions(png: Buffer): { width: number; height: number } {
	// IHDR is always the first chunk: signature(8) + length(4) + "IHDR"(4) + width(4) + height(4).
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("bannerSvg", () => {
	it("includes the title and description, escaped", () => {
		const svg = bannerSvg({ title: `<script>alert(1)</script>`, description: `A & B "quoted"` });
		expect(svg).not.toContain("<script>alert");
		expect(svg).toContain("&lt;script&gt;");
		expect(svg).toContain("A &amp; B &quot;quoted&quot;");
	});

	it("omits the description text node when none is given", () => {
		const svg = bannerSvg({ title: "Solo Title" });
		expect(svg).toContain("Solo Title");
		expect(svg.match(/<text/g)?.length).toBe(2); // title + footer only, no description line
	});

	it("truncates an overly long title instead of overflowing the canvas", () => {
		const svg = bannerSvg({ title: "x".repeat(200) });
		expect(svg).toContain("…");
		expect(svg).not.toContain("x".repeat(200));
	});

	it("picks the same color palette for the same title every time", () => {
		const a = bannerSvg({ title: "Common Dog Breeds" });
		const b = bannerSvg({ title: "Common Dog Breeds" });
		expect(a).toBe(b);
	});

	it("can pick different palettes for different titles", () => {
		const svgs = new Set(
			["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].map(
				(title) => bannerSvg({ title }).match(/stop-color="(#[0-9a-f]+)"/)?.[1],
			),
		);
		expect(svgs.size).toBeGreaterThan(1);
	});

	// Regression: a 127-char description at font-size 28 ran off the 1200px
	// canvas edge when truncation was by raw character count instead of an
	// actual word-wrap — every line must stay within the per-line budget.
	it("wraps a long description across multiple lines with no line overflowing", () => {
		const longDesc =
			"A quick guide to birds you're likely to spot in a North American backyard: robins, cardinals, blue jays, chickadees, and doves.";
		const svg = bannerSvg({ title: "Common Backyard Birds", description: longDesc });
		const lines = [...svg.matchAll(/font-size="28"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(68);
	});

	it("wraps a long title across multiple lines with no line overflowing", () => {
		const svg = bannerSvg({ title: "A Surprisingly Long Title About Backyard Birdwatching Basics" });
		const lines = [...svg.matchAll(/font-size="64"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.length).toBeLessThanOrEqual(2);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(27);
	});
});

describe("renderBannerPng", () => {
	it("renders a 1200x630 PNG", () => {
		const png = renderBannerPng({ title: "Common Cat Breeds", description: "A quick guide" });
		expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		expect(pngDimensions(png)).toEqual({ width: BANNER_WIDTH, height: BANNER_HEIGHT });
	});
});
