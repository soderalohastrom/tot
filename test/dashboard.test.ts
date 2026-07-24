import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createDashboardHandler, dashboardTots, startDashboard } from "../src/dashboard.js";
import type { RegistryEntry } from "../src/config.js";

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
	return {
		wsId: "private-workspace-id",
		docId: "private-document-id",
		slug: "abc123",
		url: "https://tot.page/abc123/report.html",
		kind: "html",
		docPath: "report.html",
		bytes: 2048,
		createdAt: "2026-07-12T18:00:00.000Z",
		...overrides,
	};
}

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

describe("dashboard registry projection", () => {
	it("sorts newest first, derives titles, and omits private API identifiers", () => {
		const tots = dashboardTots({
			"/tmp/older-report.html": entry({
				slug: "older",
				createdAt: "2026-07-11T18:00:00.000Z",
			}),
			"/tmp/mise-recap/index.html": entry({
				slug: "newer",
				createdAt: "2026-07-12T18:00:00.000Z",
			}),
		});

		expect(tots.map((tot) => tot.id)).toEqual(["newer", "older"]);
		expect(tots[0]?.title).toBe("Mise Recap");
		expect(tots[1]?.title).toBe("Older Report");
		expect(JSON.stringify(tots)).not.toContain("private-workspace-id");
		expect(JSON.stringify(tots)).not.toContain("private-document-id");
	});

	it("projects custom display names and hidden state", () => {
		const tots = dashboardTots({
			"/tmp/report.html": entry({ displayTitle: "Quarterly Field Notes", hidden: true }),
		});

		expect(tots[0]).toMatchObject({ title: "Quarterly Field Notes", hidden: true });
	});

	it("exposes project tags (empty array when untagged) for the tagging UI", () => {
		const tots = dashboardTots({
			"/tmp/tagged.html": entry({ slug: "tag1", projects: ["mise", "gohappy"] }),
			"/tmp/untagged.html": entry({ slug: "tag2", createdAt: "2026-07-11T18:00:00.000Z" }),
		});

		expect(tots.find((tot) => tot.slug === "tag1")?.projects).toEqual(["mise", "gohappy"]);
		expect(tots.find((tot) => tot.slug === "tag2")?.projects).toEqual([]);
	});
});

describe("dashboard server", () => {
	it("serves the app and a no-store JSON API on an ephemeral port", async () => {
		const instance = await startDashboard({
			host: "127.0.0.1",
			port: 0,
			open: false,
			registry: () => ({ "/tmp/report.html": entry() }),
		});
		servers.push(instance.server);

		const address = instance.server.address() as AddressInfo;
		expect(instance.url).toBe(`http://127.0.0.1:${address.port}`);

		const [page, app, layout, api, missing] = await Promise.all([
			fetch(`${instance.url}/`),
			fetch(`${instance.url}/app.js`),
			fetch(`${instance.url}/reader-layout.js`),
			fetch(`${instance.url}/api/tots`),
			fetch(`${instance.url}/does-not-exist`),
		]);
		const payload: unknown = await api.json();
		if (
			typeof payload !== "object" ||
			payload === null ||
			!("count" in payload) ||
			!("tots" in payload) ||
			!("capabilities" in payload) ||
			!Array.isArray(payload.tots)
		) {
			throw new Error("unexpected dashboard API response");
		}

		expect(page.status).toBe(200);
		const pageText = await page.text();
		const appText = await app.text();
		expect(pageText).toContain("Tot <em>Index</em>");
		expect(pageText).toContain('id="reader-resizer"');
		expect(pageText).toContain('role="separator"');
		expect(appText).toContain('"x-tot-dashboard-token"');
		expect(appText).toContain("tot-dashboard-reader-width");
		expect(appText).toContain('addEventListener("pointerdown"');
		expect(layout.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("frame-src https:");
		expect(api.headers.get("cache-control")).toBe("no-store");
		expect(payload.count).toBe(1);
		expect(payload.tots[0]?.title).toBe("Report");
		expect(payload.capabilities).toEqual({ manage: false });
		expect(JSON.stringify(payload)).not.toContain("private-workspace-id");
		expect(missing.status).toBe(404);
	});

	it("exposes a reusable request handler for other Node hosts", () => {
		expect(createDashboardHandler(() => ({}))).toBeTypeOf("function");
	});

	it("allows token-protected rename, hide, restore, and permanent delete mutations", async () => {
		const updates: Array<{ slug: string; patch: unknown }> = [];
		const removals: string[] = [];
		const instance = await startDashboard({
			host: "127.0.0.1",
			port: 0,
			open: false,
			registry: () => ({
				"/tmp/report.html": entry(),
				"/tmp/hidden.html": entry({ slug: "hidden", hidden: true }),
			}),
			admin: {
				update: (slug, patch) => {
					updates.push({ slug, patch });
					return Promise.resolve(slug !== "missing");
				},
				remove: (slug) => {
					removals.push(slug);
					return Promise.resolve(slug !== "missing");
				},
			},
		});
		servers.push(instance.server);

		const api = await fetch(`${instance.url}/api/tots`);
		const payload = (await api.json()) as {
			count: number;
			hiddenCount: number;
			capabilities: { manage: boolean; token: string };
		};
		expect(payload).toMatchObject({
			count: 1,
			hiddenCount: 1,
			capabilities: { manage: true },
		});
		expect(payload.capabilities.token).toMatch(/^[a-f0-9]{64}$/);
		const address = instance.server.address() as AddressInfo;
		const reboundPayload = await new Promise<unknown>((resolve, reject) => {
			const request = httpRequest(
				{
					hostname: "127.0.0.1",
					port: address.port,
					path: "/api/tots",
					headers: { host: "attacker.example" },
				},
				(response) => {
					let body = "";
					response.setEncoding("utf8");
					response.on("data", (chunk) => (body += chunk));
					response.on("end", () => resolve(JSON.parse(body)));
				},
			);
			request.on("error", reject);
			request.end();
		});
		expect(reboundPayload).toMatchObject({ capabilities: { manage: false } });

		const unauthorized = await fetch(`${instance.url}/api/tots/abc123`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Nope" }),
		});
		expect(unauthorized.status).toBe(403);

		const headers = {
			"content-type": "application/json",
			"x-tot-dashboard-token": payload.capabilities.token,
		};
		for (const patch of [{ title: "A clearer name" }, { hidden: true }, { hidden: false }]) {
			// oxlint-disable-next-line no-await-in-loop -- preserve mutation ordering in this API test.
			const response = await fetch(`${instance.url}/api/tots/abc123`, {
				method: "PATCH",
				headers,
				body: JSON.stringify(patch),
			});
			expect(response.status).toBe(200);
		}
		expect(updates).toEqual([
			{ slug: "abc123", patch: { displayTitle: "A clearer name" } },
			{ slug: "abc123", patch: { hidden: true } },
			{ slug: "abc123", patch: { hidden: false } },
		]);

		const removed = await fetch(`${instance.url}/api/tots/abc123`, {
			method: "DELETE",
			headers: { "x-tot-dashboard-token": payload.capabilities.token },
		});
		expect(removed.status).toBe(200);
		expect(removals).toEqual(["abc123"]);
	});

	it("accepts project tag patches and rejects malformed ones", async () => {
		const updates: Array<{ slug: string; patch: unknown }> = [];
		const instance = await startDashboard({
			host: "127.0.0.1",
			port: 0,
			open: false,
			registry: () => ({ "/tmp/report.html": entry() }),
			admin: {
				update: (slug, patch) => {
					updates.push({ slug, patch });
					return Promise.resolve(true);
				},
				remove: () => Promise.resolve(true),
			},
		});
		servers.push(instance.server);

		const api = await fetch(`${instance.url}/api/tots`);
		const payload = (await api.json()) as { capabilities: { token: string } };
		const headers = {
			"content-type": "application/json",
			"x-tot-dashboard-token": payload.capabilities.token,
		};
		const patch = (body: unknown) =>
			fetch(`${instance.url}/api/tots/abc123`, {
				method: "PATCH",
				headers,
				body: JSON.stringify(body),
			});

		// Slug normalization happens in Config.updateDashboardEntry, not here —
		// the handler forwards a validated shape.
		expect((await patch({ projects: ["Canlis", "go-happy"] })).status).toBe(200);
		expect((await patch({ projects: null })).status).toBe(200);
		expect(updates).toEqual([
			{ slug: "abc123", patch: { projects: ["Canlis", "go-happy"] } },
			{ slug: "abc123", patch: { projects: null } },
		]);

		expect((await patch({ projects: "canlis" })).status).toBe(400);
		expect((await patch({ projects: ["canlis", 42] })).status).toBe(400);
		expect((await patch({ tags: ["canlis"] })).status).toBe(400);
	});

	it("disables management entirely when explicitly bound beyond loopback", async () => {
		const instance = await startDashboard({
			host: "0.0.0.0",
			port: 0,
			open: false,
			registry: () => ({ "/tmp/report.html": entry() }),
			admin: {
				update: () => Promise.resolve(true),
				remove: () => Promise.resolve(true),
			},
		});
		servers.push(instance.server);

		const response = await fetch(`${instance.url}/api/tots`);
		expect(await response.json()).toMatchObject({ capabilities: { manage: false } });
	});
});
