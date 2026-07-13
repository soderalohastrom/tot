import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Config, type DashboardEntryPatch, type RegistryEntry } from "./config.js";

export const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 4173;

export interface DashboardTot {
	id: string;
	title: string;
	file: string;
	url: string;
	slug: string;
	kind: RegistryEntry["kind"];
	docPath: string;
	bytes: number;
	createdAt: string;
	hidden: boolean;
}

export interface DashboardAdmin {
	update: (slug: string, patch: DashboardEntryPatch) => Promise<boolean>;
	remove: (slug: string) => Promise<boolean>;
}

export interface DashboardOptions {
	host?: string;
	port?: number;
	open?: boolean;
	registry?: () => Record<string, RegistryEntry>;
	admin?: DashboardAdmin;
}

export interface DashboardInstance {
	server: http.Server;
	url: string;
}

const ASSET_DIR = fileURLToPath(new URL("../dashboard/", import.meta.url));
const STATIC_ROUTES: Record<string, { file: string; contentType: string }> = {
	"/": { file: "index.html", contentType: "text/html; charset=utf-8" },
	"/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
	"/app.css": { file: "app.css", contentType: "text/css; charset=utf-8" },
	"/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
};

export function dashboardTitleFromFile(file: string, docPath: string): string {
	let candidate = path.basename(file);
	if (candidate.toLowerCase() === "index.html" || candidate.toLowerCase() === "index.md") {
		candidate = path.basename(path.dirname(file));
	}
	if (!candidate || candidate === "." || candidate === path.sep) {
		candidate = path.basename(docPath);
	}
	return candidate
		.replace(/\.(?:html?|md)$/i, "")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Convert the private on-disk registry into the intentionally public browser shape. */
export function dashboardTots(registry: Record<string, RegistryEntry>): DashboardTot[] {
	return Object.entries(registry)
		.map(([file, entry]) => ({
			id: entry.slug,
			title:
				entry.displayTitle || dashboardTitleFromFile(file, entry.docPath) || "Untitled Tot",
			file,
			url: entry.url,
			slug: entry.slug,
			kind: entry.kind,
			docPath: entry.docPath,
			bytes: entry.bytes,
			createdAt: entry.createdAt,
			hidden: entry.hidden === true,
		}))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function securityHeaders(): Record<string, string> {
	return {
		"content-security-policy":
			"default-src 'self'; frame-src https:; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		"x-frame-options": "DENY",
	};
}

function send(
	res: ServerResponse,
	status: number,
	body: string | Buffer,
	contentType: string,
	extraHeaders: Record<string, string> = {},
): void {
	res.writeHead(status, {
		...securityHeaders(),
		"cache-control": "no-store",
		"content-type": contentType,
		...extraHeaders,
	});
	res.end(body);
}

export function createDashboardHandler(
	registry: () => Record<string, RegistryEntry> = () => Config.load().registry,
	admin?: DashboardAdmin,
): (req: IncomingMessage, res: ServerResponse) => void {
	const adminToken = admin ? randomBytes(32).toString("hex") : null;
	return async (req, res) => {
		const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
		const mutationMatch = pathname.match(/^\/api\/tots\/([A-Za-z0-9_-]+)$/);
		if (mutationMatch && (req.method === "PATCH" || req.method === "DELETE")) {
			if (!admin || !adminToken || !isLocalMutation(req, adminToken)) {
				send(
					res,
					403,
					JSON.stringify({ error: "local dashboard authorization required" }),
					"application/json; charset=utf-8",
				);
				return;
			}
			const slug = mutationMatch[1]!;
			try {
				let updated: boolean;
				if (req.method === "DELETE") {
					updated = await admin.remove(slug);
				} else {
					if (
						!req.headers["content-type"]?.toLowerCase().startsWith("application/json")
					) {
						send(
							res,
							415,
							JSON.stringify({ error: "content-type must be application/json" }),
							"application/json; charset=utf-8",
						);
						return;
					}
					const value = await readJsonBody(req);
					const patch = dashboardPatch(value);
					updated = await admin.update(slug, patch);
				}
				if (!updated) {
					send(
						res,
						404,
						JSON.stringify({ error: "Tot not found" }),
						"application/json; charset=utf-8",
					);
					return;
				}
				send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "dashboard mutation failed";
				send(
					res,
					400,
					JSON.stringify({ error: message }),
					"application/json; charset=utf-8",
				);
			}
			return;
		}
		if (req.method !== "GET") {
			send(res, 405, JSON.stringify({ error: "method not allowed" }), "application/json", {
				allow: "GET",
			});
			return;
		}

		if (pathname === "/api/tots") {
			try {
				const tots = dashboardTots(registry());
				const hiddenCount = tots.filter((tot) => tot.hidden).length;
				const canManage = adminToken !== null && isLocalDashboardRequest(req);
				send(
					res,
					200,
					JSON.stringify({
						tots,
						count: tots.length - hiddenCount,
						hiddenCount,
						generatedAt: new Date().toISOString(),
						capabilities: canManage
							? { manage: true, token: adminToken }
							: { manage: false },
					}),
					"application/json; charset=utf-8",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : "could not load registry";
				send(
					res,
					500,
					JSON.stringify({ error: message }),
					"application/json; charset=utf-8",
				);
			}
			return;
		}

		if (pathname === "/health") {
			send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
			return;
		}

		const asset = STATIC_ROUTES[pathname];
		if (!asset) {
			send(res, 404, "Not found", "text/plain; charset=utf-8");
			return;
		}
		try {
			const body = fs.readFileSync(path.join(ASSET_DIR, asset.file));
			send(res, 200, body, asset.contentType);
		} catch {
			send(
				res,
				500,
				"Dashboard assets are missing. Reinstall or run from the repository.",
				"text/plain; charset=utf-8",
			);
		}
	};
}

function isLocalMutation(req: IncomingMessage, expectedToken: string): boolean {
	if (!isLocalDashboardRequest(req)) return false;
	const provided = req.headers["x-tot-dashboard-token"];
	if (typeof provided !== "string") return false;
	const providedBytes = Buffer.from(provided);
	const expectedBytes = Buffer.from(expectedToken);
	return (
		providedBytes.length === expectedBytes.length &&
		timingSafeEqual(providedBytes, expectedBytes)
	);
}

function isLocalDashboardRequest(req: IncomingMessage): boolean {
	const address = req.socket.remoteAddress ?? "";
	const isLoopback =
		address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
	if (!isLoopback) return false;
	const host = req.headers.host;
	if (!host) return false;
	try {
		const hostname = new URL(`http://${host}`).hostname.toLowerCase();
		return (
			hostname === "localhost" ||
			hostname === "::1" ||
			hostname === "[::1]" ||
			hostname.startsWith("127.")
		);
	} catch {
		return false;
	}
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size > 16 * 1024) throw new Error("request body is too large");
		chunks.push(bytes);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("request body must be valid JSON");
	}
}

function dashboardPatch(value: unknown): DashboardEntryPatch {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("dashboard update must be an object");
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (!keys.length || keys.some((key) => key !== "title" && key !== "hidden")) {
		throw new Error("dashboard update contains unsupported fields");
	}
	const patch: DashboardEntryPatch = {};
	if ("title" in record) {
		if (record.title !== null && typeof record.title !== "string") {
			throw new Error("title must be text or null");
		}
		const title = typeof record.title === "string" ? record.title.trim() : "";
		if (title.length > 160) throw new Error("title must be 160 characters or fewer");
		patch.displayTitle = title || null;
	}
	if ("hidden" in record) {
		if (typeof record.hidden !== "boolean") throw new Error("hidden must be true or false");
		patch.hidden = record.hidden;
	}
	return patch;
}

function openBrowser(url: string): void {
	const command =
		process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.unref();
}

export async function startDashboard(options: DashboardOptions = {}): Promise<DashboardInstance> {
	const host = options.host ?? DEFAULT_DASHBOARD_HOST;
	const port = options.port ?? DEFAULT_DASHBOARD_PORT;
	const loopbackBind =
		host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
	const server = http.createServer(
		createDashboardHandler(options.registry, loopbackBind ? options.admin : undefined),
	);

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;
	const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	const url = `http://${browserHost.includes(":") ? `[${browserHost}]` : browserHost}:${actualPort}`;
	if (options.open !== false) openBrowser(url);
	return { server, url };
}
