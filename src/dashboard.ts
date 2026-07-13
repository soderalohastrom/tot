import { spawn } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Config, type RegistryEntry } from "./config.js";

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
}

export interface DashboardOptions {
	host?: string;
	port?: number;
	open?: boolean;
	registry?: () => Record<string, RegistryEntry>;
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
			title: dashboardTitleFromFile(file, entry.docPath) || "Untitled Tot",
			file,
			url: entry.url,
			slug: entry.slug,
			kind: entry.kind,
			docPath: entry.docPath,
			bytes: entry.bytes,
			createdAt: entry.createdAt,
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
): (req: IncomingMessage, res: ServerResponse) => void {
	return (req, res) => {
		const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
		if (req.method !== "GET") {
			send(res, 405, JSON.stringify({ error: "method not allowed" }), "application/json", {
				allow: "GET",
			});
			return;
		}

		if (pathname === "/api/tots") {
			try {
				const tots = dashboardTots(registry());
				send(
					res,
					200,
					JSON.stringify({
						tots,
						count: tots.length,
						generatedAt: new Date().toISOString(),
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
	const server = http.createServer(createDashboardHandler(options.registry));

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
