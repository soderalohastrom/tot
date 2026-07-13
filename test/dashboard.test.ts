import type { Server } from "node:http";
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

		const [page, api, missing] = await Promise.all([
			fetch(`${instance.url}/`),
			fetch(`${instance.url}/api/tots`),
			fetch(`${instance.url}/does-not-exist`),
		]);
		const payload: unknown = await api.json();
		if (
			typeof payload !== "object" ||
			payload === null ||
			!("count" in payload) ||
			!("tots" in payload) ||
			!Array.isArray(payload.tots)
		) {
			throw new Error("unexpected dashboard API response");
		}

		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Tot <em>Index</em>");
		expect(page.headers.get("content-security-policy")).toContain("frame-src https:");
		expect(api.headers.get("cache-control")).toBe("no-store");
		expect(payload.count).toBe(1);
		expect(payload.tots[0]?.title).toBe("Report");
		expect(JSON.stringify(payload)).not.toContain("private-workspace-id");
		expect(missing.status).toBe(404);
	});

	it("exposes a reusable request handler for other Node hosts", () => {
		expect(createDashboardHandler(() => ({}))).toBeTypeOf("function");
	});
});
