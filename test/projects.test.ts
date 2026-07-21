import { describe, expect, it } from "vitest";
import { isProjectSlug, normalizeProjectSlug, normalizeProjects } from "../src/projects.js";

describe("isProjectSlug", () => {
	it("accepts lowercase slugs with digits and hyphens", () => {
		expect(isProjectSlug("canlis")).toBe(true);
		expect(isProjectSlug("go-happy-2")).toBe(true);
		expect(isProjectSlug("a")).toBe(true);
	});

	it("rejects empty, uppercase, leading hyphen, and over-length slugs", () => {
		expect(isProjectSlug("")).toBe(false);
		expect(isProjectSlug("Canlis")).toBe(false);
		expect(isProjectSlug("-canlis")).toBe(false);
		expect(isProjectSlug("canlis_")).toBe(false);
		expect(isProjectSlug(`a${"b".repeat(63)}`)).toBe(true);
		expect(isProjectSlug(`a${"b".repeat(64)}`)).toBe(false);
	});
});

describe("normalizeProjectSlug", () => {
	it("trims and lowercases valid input", () => {
		expect(normalizeProjectSlug("  Canlis ")).toBe("canlis");
	});

	it("returns null for input that stays invalid", () => {
		expect(normalizeProjectSlug("not a slug")).toBeNull();
		expect(normalizeProjectSlug("")).toBeNull();
	});
});

describe("normalizeProjects", () => {
	it("lowercases, drops empties, dedupes, and sorts", () => {
		expect(normalizeProjects([" GoHappy ", "canlis", "", "canlis", "Canlis"])).toEqual([
			"canlis",
			"gohappy",
		]);
	});

	it("throws on an invalid slug", () => {
		expect(() => normalizeProjects(["ok", "not ok"])).toThrow(/invalid project slug/);
	});
});
