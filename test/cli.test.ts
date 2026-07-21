import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isCliEntrypoint, main } from "../src/cli.js";
import { Config, type RegistryEntry } from "../src/config.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tot-cli-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cli entrypoint detection", () => {
	it("treats npm bin symlinks as CLI invocation", () => {
		const realCli = path.join(tmpDir, "real-cli.js");
		const binShim = path.join(tmpDir, "tot");
		fs.writeFileSync(realCli, "#!/usr/bin/env node\n");
		fs.symlinkSync(realCli, binShim);

		expect(isCliEntrypoint(pathToFileURL(realCli).href, binShim)).toBe(true);
	});

	it("does not run when imported from another module", () => {
		const realCli = path.join(tmpDir, "real-cli.js");
		const importer = path.join(tmpDir, "test-runner.js");
		fs.writeFileSync(realCli, "");
		fs.writeFileSync(importer, "");

		expect(isCliEntrypoint(pathToFileURL(realCli).href, importer)).toBe(false);
	});
});

describe("tot dashboard tag/untag/tags", () => {
	function seedRegistry(): void {
		process.env.TOT_CONFIG = path.join(tmpDir, ".tot");
		const cfg = Config.load();
		const entry: RegistryEntry = {
			wsId: "ws_1",
			docId: "doc_1",
			slug: "slug1",
			url: "https://tot.page/slug1",
			kind: "markdown",
			docPath: "index.md",
			bytes: 7,
			createdAt: "2026-07-20T00:00:00.000Z",
		};
		cfg.addEntry("notes.md", entry);
		cfg.save();
	}

	function projects(): string[] | undefined {
		return Config.load().getEntryBySlug("slug1")?.projects;
	}

	it("tags, lists, and untags projects on a registry entry", async () => {
		seedRegistry();
		const lines: string[] = [];
		const originalLog = console.log;
		console.log = (message?: unknown) => lines.push(String(message));
		try {
			expect(await main(["dashboard", "tag", "slug1", "Canlis"])).toBe(0);
			expect(await main(["dashboard", "tag", "https://tot.page/slug1", "go-happy"])).toBe(0);
			expect(projects()).toEqual(["canlis", "go-happy"]);

			expect(await main(["dashboard", "tags", "slug1"])).toBe(0);
			expect(lines.at(-1)).toBe("slug1  canlis, go-happy");

			expect(await main(["dashboard", "untag", "slug1", "canlis"])).toBe(0);
			expect(projects()).toEqual(["go-happy"]);
			expect(await main(["dashboard", "untag", "slug1", "go-happy"])).toBe(0);
			expect(projects()).toBeUndefined();
		} finally {
			console.log = originalLog;
		}
	});

	it("rejects an invalid project slug and an unknown target", async () => {
		seedRegistry();
		await expect(main(["dashboard", "tag", "slug1", "not a slug"])).rejects.toThrow(
			/invalid project slug/,
		);
		await expect(main(["dashboard", "tag", "missing", "canlis"])).rejects.toThrow(
			/no published page matches/,
		);
		expect(projects()).toBeUndefined();
	});
});
