import { describe, expect, it } from "vitest";

// @ts-expect-error -- browser asset is intentionally plain JavaScript.
import * as readerLayout from "../dashboard/reader-layout.js";

const {
	clampReaderWidth,
	defaultReaderWidth,
	maximumReaderWidth,
	readerWidthFromKey,
	readerWidthFromPointer,
} = readerLayout;

describe("reader panel sizing", () => {
	it("clamps the reader while preserving the catalog minimum", () => {
		expect(maximumReaderWidth(1_440)).toBe(1_069);
		expect(clampReaderWidth(100, 1_440)).toBe(300);
		expect(clampReaderWidth(2_000, 1_440)).toBe(1_069);
		expect(defaultReaderWidth(1_440)).toBe(490);
	});

	it("grows when dragged left and shrinks when dragged right", () => {
		expect(readerWidthFromPointer(490, 1_000, 900, 1_440)).toBe(590);
		expect(readerWidthFromPointer(490, 1_000, 1_100, 1_440)).toBe(390);
	});

	it("supports arrow, Home, and End keyboard controls", () => {
		expect(readerWidthFromKey("ArrowLeft", 490, 1_440, false)).toBe(514);
		expect(readerWidthFromKey("ArrowRight", 490, 1_440, true)).toBe(426);
		expect(readerWidthFromKey("Home", 490, 1_440, false)).toBe(300);
		expect(readerWidthFromKey("End", 490, 1_440, false)).toBe(1_069);
		expect(readerWidthFromKey("Escape", 490, 1_440, false)).toBeNull();
	});
});
