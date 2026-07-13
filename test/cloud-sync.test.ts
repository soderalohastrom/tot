import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	backupCloudDashboard,
	cloudAccessCredentials,
	loadCloudSyncSettings,
	restoreCloudDashboard,
	saveCloudSyncSettings,
	syncCloudDashboard,
	type CloudAccessCredentials,
	type CloudSyncDeps,
} from "../src/cloud-sync.js";
import type { RegistryEntry } from "../src/config.js";

const temporaryDirectories: string[] = [];
const access: CloudAccessCredentials = {
	clientId: "service-token.access",
	clientSecret: "service-token-secret",
};

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
	delete process.env.CF_ACCESS_CLIENT_ID;
	delete process.env.CF_ACCESS_CLIENT_SECRET;
});

function registryEntry(): RegistryEntry {
	return {
		wsId: "private-workspace",
		docId: "private-document",
		slug: "slug-123",
		url: "https://tot.page/slug-123/report.html",
		kind: "html",
		docPath: "report.html",
		bytes: 100,
		createdAt: "2026-07-12T12:00:00.000Z",
		assets: {
			"preview.png": { sha256: "source-hash", contentType: "image/png", size: 3 },
		},
	};
}

function digest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("cloud dashboard sync", () => {
	it("mirrors documents and assets before publishing a sanitized manifest", async () => {
		const uploads: Array<{ url: string; body: string; contentType: string | null }> = [];
		const manifests: Array<Record<string, unknown>> = [];
		const syncHeaders: Headers[] = [];
		const sourceHtml =
			'<html><head><title>Field Notes</title><meta property="og:image" content="https://tot.page/slug-123/preview.png"></head><body><img src="preview.png"></body></html>';
		const fetchStub: CloudSyncDeps["fetch"] = async (input, init) => {
			const url = String(input);
			if (url.includes("/api/sync/")) syncHeaders.push(new Headers(init?.headers));
			if (url === "https://tot.page/slug-123/report.html") {
				expect(new Headers(init?.headers).has("cf-access-client-secret")).toBe(false);
				return new Response(sourceHtml, { headers: { "content-type": "text/html" } });
			}
			if (url === "https://tot.page/slug-123/preview.png") {
				expect(new Headers(init?.headers).has("cf-access-client-secret")).toBe(false);
				return new Response(new Uint8Array([1, 2, 3]), {
					headers: { "content-type": "image/png" },
				});
			}
			if (url.includes("/api/sync/object?")) {
				const body = init?.body;
				if (typeof body !== "string" && !(body instanceof Uint8Array)) {
					throw new Error("unexpected upload body");
				}
				const bytes = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
				uploads.push({
					url,
					body: bytes,
					contentType: new Headers(init?.headers).get("content-type"),
				});
				return Response.json({ ok: true }, { status: 201 });
			}
			if (url.endsWith("/api/sync/manifest")) {
				if (init?.method !== "PUT") {
					return Response.json({
						tots: [],
						count: 0,
						generatedAt: new Date(0).toISOString(),
					});
				}
				manifests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return Response.json({ ok: true });
			}
			throw new Error(`unexpected request: ${url}`);
		};

		const result = await syncCloudDashboard(
			{
				endpoint: "https://dashboard.example.com/",
				token: "sync-secret",
				access,
				registry: {
					"/private/tmp/report.html": {
						...registryEntry(),
						displayTitle: "Renamed Field Notes",
					},
				},
			},
			{
				fetch: fetchStub,
				now: () => new Date("2026-07-13T01:00:00.000Z"),
				log: () => {},
			},
		);

		expect(result).toMatchObject({ count: 1, objectsUploaded: 2, manifestUpdated: true });
		expect(syncHeaders.length).toBeGreaterThan(0);
		for (const headers of syncHeaders) {
			expect(headers.get("authorization")).toBe("Bearer sync-secret");
			expect(headers.get("cf-access-client-id")).toBe(access.clientId);
			expect(headers.get("cf-access-client-secret")).toBe(access.clientSecret);
		}
		expect(uploads).toHaveLength(2);
		expect(uploads[0]?.body).not.toContain("https://tot.page/slug-123/preview.png");
		expect(uploads[0]?.body).toContain('content="preview.png"');
		expect(uploads[1]?.contentType).toBe("image/png");
		const manifest = manifests[0];
		expect(JSON.stringify(manifest)).not.toContain("private-workspace");
		expect(JSON.stringify(manifest)).not.toContain("private-document");
		expect(JSON.stringify(manifest)).not.toContain("/private/tmp");

		const tots = manifest?.["tots"];
		if (!Array.isArray(tots) || typeof tots[0] !== "object" || tots[0] === null) {
			throw new Error("manifest did not contain a tot");
		}
		expect(tots[0]).toMatchObject({
			title: "Renamed Field Notes",
			file: "report.html",
			originalUrl: "https://tot.page/slug-123/report.html",
			assetCount: 1,
			assetPaths: ["preview.png"],
			docSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			docContentType: "text/html",
			assetHashes: { "preview.png": digest(new Uint8Array([1, 2, 3])) },
			assetContentTypes: { "preview.png": "image/png" },
		});
		expect(String(tots[0].url)).toMatch(
			/^https:\/\/dashboard\.example\.com\/mirror\/slug-123\/[a-f0-9]{64}\/report\.html$/,
		);
	});

	it("advances the content version when only an asset changes", async () => {
		let assetByte = 1;
		let currentManifest: Record<string, unknown> = {
			tots: [],
			count: 0,
			generatedAt: new Date(0).toISOString(),
		};
		const versions: string[] = [];
		const fetchStub: CloudSyncDeps["fetch"] = async (input, init) => {
			const url = String(input);
			if (url === "https://tot.page/slug-123/report.html") {
				return new Response("<html><title>Stable</title></html>");
			}
			if (url === "https://tot.page/slug-123/preview.png") {
				return new Response(new Uint8Array([assetByte]));
			}
			if (url.includes("/api/sync/object?"))
				return Response.json({ ok: true }, { status: 201 });
			if (url.endsWith("/api/sync/manifest") && init?.method === "PUT") {
				currentManifest = JSON.parse(String(init.body)) as Record<string, unknown>;
				const tots = currentManifest["tots"];
				if (Array.isArray(tots) && typeof tots[0] === "object" && tots[0] !== null) {
					versions.push(String((tots[0] as Record<string, unknown>)["contentHash"]));
				}
				return Response.json({ ok: true });
			}
			if (url.endsWith("/api/sync/manifest")) return Response.json(currentManifest);
			throw new Error(`unexpected request: ${url}`);
		};
		const deps: CloudSyncDeps = {
			fetch: fetchStub,
			now: () => new Date(`2026-07-13T0${versions.length + 1}:00:00.000Z`),
			log: () => {},
		};
		const options = {
			endpoint: "https://dashboard.example.com",
			token: "secret",
			access,
			registry: { "/tmp/report.html": registryEntry() },
		};

		await syncCloudDashboard(options, deps);
		assetByte = 2;
		await syncCloudDashboard(options, deps);

		expect(versions).toHaveLength(2);
		expect(versions[0]).not.toBe(versions[1]);
	});

	it("requires HTTPS for non-local sync targets", async () => {
		await expect(
			syncCloudDashboard({
				endpoint: "http://dashboard.example.com",
				token: "secret",
				registry: {},
			}),
		).rejects.toThrow("must use HTTPS");
	});

	it("omits locally hidden Tots without downloading their content", async () => {
		const sourceRequests: string[] = [];
		const result = await syncCloudDashboard(
			{
				endpoint: "https://dashboard.example.com",
				token: "secret",
				access,
				registry: {
					"/tmp/hidden.html": { ...registryEntry(), hidden: true },
				},
			},
			{
				fetch: async (input) => {
					const url = String(input);
					if (url.includes("tot.page")) sourceRequests.push(url);
					return Response.json({
						tots: [],
						count: 0,
						generatedAt: new Date(0).toISOString(),
					});
				},
				now: () => new Date("2026-07-13T03:00:00.000Z"),
				log: () => {},
			},
		);

		expect(result).toMatchObject({ count: 0, objectsUploaded: 0, manifestUpdated: false });
		expect(sourceRequests).toEqual([]);
	});
});

describe("cloud dashboard backup", () => {
	it("downloads content-addressed objects and keeps manifest snapshots", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tot-cloud-backup-"));
		temporaryDirectories.push(directory);
		const contentHash = "a".repeat(64);
		const documentKey = `tots/slug-123/${contentHash}/report.html`;
		const assetKey = `tots/slug-123/${contentHash}/preview.png`;
		const manifest = {
			tots: [
				{
					id: "slug-123",
					title: "Field Notes",
					file: "report.html",
					url: `https://dashboard.example.com/mirror/slug-123/${contentHash}/report.html`,
					originalUrl: "https://tot.page/slug-123/report.html",
					slug: "slug-123",
					kind: "html",
					contentHash,
					docSha256: digest(`backup:${documentKey}`),
					docPath: "report.html",
					docContentType: "text/html; charset=utf-8",
					bytes: 100,
					createdAt: "2026-07-12T12:00:00.000Z",
					assetCount: 1,
					assetPaths: ["preview.png"],
					assetHashes: { "preview.png": digest(`backup:${assetKey}`) },
					assetContentTypes: { "preview.png": "image/png" },
					syncedAt: "2026-07-13T01:00:00.000Z",
				},
			],
			count: 1,
			generatedAt: "2026-07-13T01:00:00.000Z",
		};
		const requestHeaders: Headers[] = [];
		const fetchStub: CloudSyncDeps["fetch"] = async (input, init) => {
			requestHeaders.push(new Headers(init?.headers));
			const url = new URL(String(input));
			if (url.pathname === "/api/sync/manifest") return Response.json(manifest);
			if (url.pathname === "/api/sync/object") {
				return new Response(`backup:${url.searchParams.get("key")}`);
			}
			throw new Error(`unexpected request: ${url}`);
		};

		const first = await backupCloudDashboard(
			{
				endpoint: "https://dashboard.example.com",
				token: "secret",
				access,
				directory,
			},
			{ fetch: fetchStub, log: () => {} },
		);
		const second = await backupCloudDashboard(
			{
				endpoint: "https://dashboard.example.com",
				token: "secret",
				access,
				directory,
			},
			{ fetch: fetchStub, log: () => {} },
		);

		expect(first).toMatchObject({ count: 1, downloaded: 2 });
		expect(second).toMatchObject({ count: 1, downloaded: 0 });
		fs.writeFileSync(path.join(directory, documentKey), "corrupt");
		const repaired = await backupCloudDashboard(
			{
				endpoint: "https://dashboard.example.com",
				token: "secret",
				access,
				directory,
			},
			{ fetch: fetchStub, log: () => {} },
		);
		expect(repaired).toMatchObject({ count: 1, downloaded: 1 });
		for (const headers of requestHeaders) {
			expect(headers.get("authorization")).toBe("Bearer secret");
			expect(headers.get("cf-access-client-id")).toBe(access.clientId);
			expect(headers.get("cf-access-client-secret")).toBe(access.clientSecret);
		}
		expect(
			fs.readFileSync(
				path.join(directory, "tots", "slug-123", contentHash, "report.html"),
				"utf8",
			),
		).toContain("report.html");
		expect(
			fs.existsSync(
				path.join(directory, "manifest", "snapshots", "2026-07-13T01-00-00-000Z.json"),
			),
		).toBe(true);

		const restoredObjects: string[] = [];
		let restoredManifest: Record<string, unknown> | null = null;
		const restored = await restoreCloudDashboard(
			{
				endpoint: "https://replacement.example.com",
				token: "secret",
				access,
				directory,
			},
			{
				fetch: async (input, init) => {
					const url = new URL(String(input));
					const headers = new Headers(init?.headers);
					expect(headers.get("cf-access-client-id")).toBe(access.clientId);
					if (url.pathname === "/api/sync/object") {
						restoredObjects.push(url.searchParams.get("key") ?? "");
						expect(headers.get("x-tot-sha256")).toMatch(/^[a-f0-9]{64}$/);
						return Response.json({ ok: true }, { status: 201 });
					}
					if (url.pathname === "/api/sync/manifest") {
						restoredManifest = JSON.parse(String(init?.body)) as Record<
							string,
							unknown
						>;
						return Response.json({ ok: true });
					}
					throw new Error(`unexpected restore request: ${url}`);
				},
				log: () => {},
				now: () => new Date("2026-07-14T01:00:00.000Z"),
			},
		);
		expect(restored).toMatchObject({ count: 1, uploaded: 2 });
		expect(restoredObjects).toEqual([documentKey, assetKey]);
		expect(restoredManifest?.["generatedAt"]).toBe("2026-07-14T01:00:00.000Z");
		const restoredTots = restoredManifest?.["tots"];
		expect(Array.isArray(restoredTots) ? restoredTots[0] : null).toMatchObject({
			url: `https://replacement.example.com/mirror/slug-123/${contentHash}/report.html`,
		});
	});

	it("rejects Windows-style traversal paths from a cloud manifest", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tot-cloud-backup-"));
		temporaryDirectories.push(directory);
		const contentHash = "a".repeat(64);
		const manifest = {
			tots: [
				{
					id: "slug-123",
					title: "Unsafe",
					file: "unsafe.html",
					url: "https://dashboard.example.com/mirror/unsafe",
					originalUrl: "https://tot.page/unsafe",
					slug: "slug-123",
					kind: "html",
					contentHash,
					docSha256: "b".repeat(64),
					docPath: "..\\outside.html",
					docContentType: "text/html",
					bytes: 1,
					createdAt: "2026-07-12T12:00:00.000Z",
					assetCount: 0,
					assetPaths: [],
					assetHashes: {},
					assetContentTypes: {},
					syncedAt: "2026-07-13T01:00:00.000Z",
				},
			],
			count: 1,
			generatedAt: "2026-07-13T01:00:00.000Z",
		};

		await expect(
			backupCloudDashboard(
				{
					endpoint: "https://dashboard.example.com",
					token: "secret",
					directory,
				},
				{ fetch: async () => Response.json(manifest), log: () => {} },
			),
		).rejects.toThrow("invalid shape");
		expect(fs.existsSync(path.join(directory, "outside.html"))).toBe(false);
	});
});

describe("cloud sync settings", () => {
	it("writes endpoint-only settings with owner permissions", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tot-cloud-settings-"));
		temporaryDirectories.push(directory);
		const file = path.join(directory, "settings.json");

		saveCloudSyncSettings("https://dashboard.example.com/", file);

		expect(loadCloudSyncSettings(file)).toEqual({ endpoint: "https://dashboard.example.com" });
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(file, "utf8")).not.toContain("token");
	});

	it("loads Cloudflare Access service credentials from the environment", () => {
		process.env.CF_ACCESS_CLIENT_ID = access.clientId;
		process.env.CF_ACCESS_CLIENT_SECRET = access.clientSecret;

		expect(cloudAccessCredentials("https://dashboard.example.com")).toEqual(access);
	});

	it("rejects incomplete Cloudflare Access service credentials", () => {
		process.env.CF_ACCESS_CLIENT_ID = access.clientId;

		expect(() => cloudAccessCredentials("https://dashboard.example.com")).toThrow(
			"both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET",
		);
	});
});
