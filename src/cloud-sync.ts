import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { RegistryEntry } from "./config.js";
import { dashboardTitleFromFile } from "./dashboard.js";
import { isProjectSlug, normalizeProjects } from "./projects.js";

const KEYCHAIN_SERVICE = "tot-dashboard-sync";
const ACCESS_KEYCHAIN_SERVICE = "tot-dashboard-access";
const SETTINGS_FILE = path.join(os.homedir(), ".tot-dashboard");
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;

/** MIME guess by extension for locally-sourced sync content. */
const MIME_BY_EXT: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".pdf": "application/pdf",
};

function guessContentType(filePath: string, fallback?: string): string {
	const ext = path.extname(filePath).toLowerCase();
	return MIME_BY_EXT[ext] ?? fallback ?? "application/octet-stream";
}

/**
 * Resolve a registry key (which may be relative) to an absolute file path
 * by scanning candidate CWDs. Returns null if the file cannot be found.
 *
 * Tries the current process CWD first, then a curated list of tot-known
 * project directories. Extend the list as new project roots are added.
 */
const LOCAL_FILE_SEARCH_DIRS: string[] = (() => {
	const home = os.homedir();
	return [
		// Common tot project roots; keep alphabetised.
		path.join(home, "PROJECTS", "go-happy-cab-demo"),
		path.join(home, "PROJECTS", "gohappy"),
		path.join(home, "PROJECTS", "gohappy-www"),
		path.join(home, "PROJECTS", "huihui"),
		path.join(home, "PROJECTS", "mise-august"),
		path.join(home, "PROJECTS", "mise-july"),
		path.join(home, "PROJECTS", "mise-june"),
		path.join(home, "PROJECTS", "mise-spring"),
		path.join(home, "PROJECTS", "tot"),
		home,
	];
})();

export function resolveLocalFilePath(fileKey: string, extraDirs: string[] = []): string | null {
	if (path.isAbsolute(fileKey)) {
		return fs.existsSync(fileKey) ? fileKey : null;
	}
	const candidates = [process.cwd(), ...extraDirs, ...LOCAL_FILE_SEARCH_DIRS];
	for (const cwd of candidates) {
		const candidate = path.join(cwd, fileKey);
		try {
			fs.accessSync(candidate, fs.constants.R_OK);
			return candidate;
		} catch {
			// try next
		}
	}
	return null;
}

async function downloadFromFile(
	localPath: string,
	hintContentType?: string,
): Promise<DownloadedObject> {
	const bytes = await fsp.readFile(localPath);
	const contentType = hintContentType ?? guessContentType(localPath);
	return { bytes, contentType };
}

export interface CloudSyncSettings {
	endpoint: string;
}

export interface CloudAccessCredentials {
	clientId: string;
	clientSecret: string;
}

export interface CloudSyncOptions {
	endpoint: string;
	token: string;
	access?: CloudAccessCredentials;
	registry: Record<string, RegistryEntry>;
	/**
	 * Skip entries whose source document can't be obtained (no local file,
	 * remote download failed). Defaults to true. When false, the first
	 * unavailable source throws and aborts the sync.
	 */
	skipOnMissing?: boolean;
	/**
	 * Never attempt to download from the upstream tot.page edge. Tots whose
	 * local source file is missing are skipped (or fall back to a metadata-only
	 * entry if a previous manifest entry exists).
	 */
	localOnly?: boolean;
}

export interface CloudBackupOptions {
	endpoint: string;
	token: string;
	access?: CloudAccessCredentials;
	directory: string;
}

export interface CloudRestoreOptions extends CloudBackupOptions {}

export interface CloudSyncResult {
	count: number;
	objectsUploaded: number;
	manifestUpdated: boolean;
	manifestUrl: string;
	skipped: string[];
}

export interface CloudSyncDeps {
	fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	now: () => Date;
	log: (message: string) => void;
}

interface PublicPala {
	id: string;
	title: string;
	file: string;
	url: string;
	originalUrl: string;
	slug: string;
	kind: RegistryEntry["kind"];
	docPath: string;
	docContentType: string;
	bytes: number;
	createdAt: string;
	contentHash: string;
	docSha256: string;
	assetCount: number;
	assetPaths: string[];
	assetHashes: Record<string, string>;
	assetContentTypes: Record<string, string>;
	syncedAt: string;
	/** Project slugs for scoped client reading rooms. Always set by the sync
	 *  builder; manifests synced before this field existed are treated as []. */
	projects: string[];
}

interface PublicManifest {
	tots: PublicPala[];
	count: number;
	generatedAt: string;
}

interface DownloadedObject {
	bytes: Uint8Array;
	contentType: string;
}

interface MirroredAsset {
	path: string;
	object: DownloadedObject;
	sha256: string;
}

function syncRequestHeaders(
	token: string,
	access: CloudAccessCredentials | undefined,
	initial?: NonNullable<RequestInit["headers"]>,
): Headers {
	const headers = new Headers(initial);
	headers.set("authorization", `Bearer ${token}`);
	if (access) {
		headers.set("cf-access-client-id", access.clientId);
		headers.set("cf-access-client-secret", access.clientSecret);
	}
	return headers;
}

function normalizedEndpoint(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
		throw new Error("cloud sync endpoint must use HTTPS");
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

function safeWorkspacePath(value: string): string {
	if (value.includes("\\")) throw new Error(`unsafe workspace path: ${value}`);
	const normalized = path.posix.normalize(value.replace(/^\/+/, ""));
	if (
		!normalized ||
		normalized === "." ||
		normalized.startsWith("../") ||
		normalized.includes("/../")
	) {
		throw new Error(`unsafe workspace path: ${value}`);
	}
	return normalized;
}

function encodedPath(value: string): string {
	return value.split("/").map(encodeURIComponent).join("/");
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function totContentHash(documentHash: string, assets: MirroredAsset[]): string {
	const hash = createHash("sha256");
	hash.update("tot-dashboard-v1\0");
	hash.update(documentHash);
	for (const asset of assets) {
		hash.update("\0");
		hash.update(asset.path);
		hash.update("\0");
		hash.update(asset.sha256);
	}
	return hash.digest("hex");
}

function decodeHtmlText(value: string): string {
	return value
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#(?:39|x27);/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function titleFromHtml(html: string): string | null {
	const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	return match?.[1] ? decodeHtmlText(match[1].replace(/<[^>]+>/g, "")) : null;
}

function rewriteAssetUrls(html: string, entry: RegistryEntry, assetPaths: string[]): string {
	const documentDirectory = path.posix.dirname(entry.docPath);
	let rewritten = html;
	for (const assetPath of assetPaths) {
		const remote = new URL(`/${entry.slug}/${encodedPath(assetPath)}`, entry.url).href;
		const relative =
			path.posix.relative(documentDirectory, assetPath) || path.posix.basename(assetPath);
		rewritten = rewritten.replaceAll(remote, relative);
	}
	return rewritten;
}

async function download(url: string, deps: CloudSyncDeps): Promise<DownloadedObject> {
	const response = await deps.fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
	const bytes = await limitedResponseBytes(response, MAX_DOWNLOAD_BYTES, `download: ${url}`);
	return {
		bytes,
		contentType: response.headers.get("content-type") ?? "application/octet-stream",
	};
}

/**
 * Read the cloud manifest (same auth as the sync) and return it, or null if
 * the endpoint is not configured or the manifest can't be reached. Used by
 * the local dashboard to look up working cloud mirror URLs when the local
 * source file is missing.
 */
export async function fetchCloudManifest(
	deps: Partial<CloudSyncDeps> = {},
): Promise<PublicPala[] | null> {
	const fetchFn = deps.fetch ?? fetch;
	const settings = loadCloudSyncSettings();
	if (!settings) return null;
	const token = cloudSyncToken(settings.endpoint);
	if (!token) return null;
	const access = cloudAccessCredentials(settings.endpoint);
	try {
		const response = await fetchFn(`${settings.endpoint}/api/sync/manifest`, {
			headers: syncRequestHeaders(token, access ?? undefined),
		});
		if (!response.ok) return null;
		const value = await response.json();
		return isPublicManifest(value) ? value.tots : null;
	} catch {
		return null;
	}
}

async function uploadObject(
	endpoint: string,
	token: string,
	access: CloudAccessCredentials | undefined,
	key: string,
	object: DownloadedObject,
	deps: CloudSyncDeps,
): Promise<boolean> {
	const digest = sha256(object.bytes);
	const response = await deps.fetch(
		`${endpoint}/api/sync/object?key=${encodeURIComponent(key)}`,
		{
			method: "PUT",
			headers: syncRequestHeaders(token, access, {
				"content-length": String(object.bytes.byteLength),
				"content-type": object.contentType,
				"x-tot-sha256": digest,
			}),
			body: Buffer.from(object.bytes),
		},
	);
	if (response.status === 204) return false;
	if (!response.ok) throw new Error(`upload failed (${response.status}): ${key}`);
	return true;
}

async function syncOnePala(
	file: string,
	entry: RegistryEntry,
	endpoint: string,
	token: string,
	access: CloudAccessCredentials | undefined,
	syncedAt: string,
	deps: CloudSyncDeps,
	options: { localOnly?: boolean } = {},
): Promise<{ pala: PublicPala; objectsUploaded: number }> {
	const docPath = safeWorkspacePath(entry.docPath);
	const assetPaths = Object.keys(entry.assets ?? {})
		.map(safeWorkspacePath)
		.sort();

	// Prefer the local source file when available. This lets sync proceed
	// even when the upstream tot.page edge is degraded or offline, and
	// avoids re-downloading bytes we already have on disk.
	const localDocPath = resolveLocalFilePath(file);
	let document: DownloadedObject;
	let localBaseDir: string | null = null;
	if (localDocPath) {
		document = await downloadFromFile(localDocPath);
		localBaseDir = path.dirname(path.resolve(localDocPath));
		deps.log(`    ↳ local: ${path.relative(os.homedir(), localDocPath)}`);
	} else if (options.localOnly) {
		throw new Error(`local source not found and --local-only is set: ${file}`);
	} else {
		document = await download(entry.url, deps);
		deps.log(`    ↳ remote: ${entry.url}`);
	}

	let documentBytes = document.bytes;
	let documentTitle: string | null = null;

	if (entry.kind === "html") {
		const html = new TextDecoder().decode(document.bytes);
		documentTitle = titleFromHtml(html);
		documentBytes = new TextEncoder().encode(rewriteAssetUrls(html, entry, assetPaths));
	}

	const assets = (
		await Promise.all(
			assetPaths.map(async (assetPath): Promise<MirroredAsset | null> => {
				let object: DownloadedObject | null = null;
				if (localBaseDir) {
					const candidate = path.join(localBaseDir, assetPath);
					if (fs.existsSync(candidate)) {
						object = await downloadFromFile(
							candidate,
							entry.assets?.[assetPath]?.contentType,
						);
					}
				}
				if (object === null) {
					try {
						const assetUrl = new URL(
							`/${entry.slug}/${encodedPath(assetPath)}`,
							entry.url,
						).href;
						object = await download(assetUrl, deps);
					} catch (error) {
						// Asset unavailable (tot.page edge broken, missing local,
						// etc.). Don't fail the whole entry — the document still
						// syncs, the manifest records the asset as missing.
						deps.log(
							`    ↳ asset skipped: ${assetPath} (${error instanceof Error ? error.message : String(error)})`,
						);
						return null;
					}
				}
				return { path: assetPath, object, sha256: sha256(object.bytes) };
			}),
		)
	).filter((a): a is MirroredAsset => a !== null);
	const docSha256 = sha256(documentBytes);
	const contentHash = totContentHash(docSha256, assets);
	const baseKey = `tots/${entry.slug}/${contentHash}`;
	let objectsUploaded = 0;
	if (
		await uploadObject(
			endpoint,
			token,
			access,
			`${baseKey}/${docPath}`,
			{ ...document, bytes: documentBytes },
			deps,
		)
	) {
		objectsUploaded++;
	}

	const assetUploads = await Promise.all(
		assets.map(async (asset) => {
			return uploadObject(
				endpoint,
				token,
				access,
				`${baseKey}/${asset.path}`,
				asset.object,
				deps,
			);
		}),
	);
	objectsUploaded += assetUploads.filter(Boolean).length;
	const availableAssetPaths = assets.map((a) => a.path);

	const mirrorPath = `/mirror/${encodeURIComponent(entry.slug)}/${contentHash}/${encodedPath(docPath)}`;
	return {
		pala: {
			id: entry.slug,
			title:
				entry.displayTitle ||
				documentTitle ||
				dashboardTitleFromFile(file, docPath) ||
				"Untitled Pala",
			file: path.basename(file),
			// Same-origin path, not `${endpoint}${mirrorPath}`: the dashboard iframes
			// this under whatever host serves it (workers.dev or the palapala.me
			// custom domain), and its CSP frame-src is 'self'. An absolute
			// workers.dev URL is cross-origin from palapala.me and gets blocked.
			url: mirrorPath,
			originalUrl: entry.url,
			slug: entry.slug,
			kind: entry.kind,
			docPath,
			docContentType: document.contentType,
			bytes: documentBytes.byteLength,
			createdAt: entry.createdAt,
			contentHash,
			docSha256,
			assetCount: availableAssetPaths.length,
			assetPaths: availableAssetPaths,
			assetHashes: Object.fromEntries(assets.map((asset) => [asset.path, asset.sha256])),
			assetContentTypes: Object.fromEntries(
				assets.map((asset) => [asset.path, asset.object.contentType]),
			),
			syncedAt,
			projects: normalizeProjects(entry.projects ?? []),
		},
		objectsUploaded,
	};
}

export async function syncCloudDashboard(
	options: CloudSyncOptions,
	deps: CloudSyncDeps = {
		fetch,
		now: () => new Date(),
		log: (message) => console.log(message),
	},
): Promise<CloudSyncResult> {
	const endpoint = normalizedEndpoint(options.endpoint);
	if (!options.token) throw new Error("cloud sync token is required");
	const skipOnMissing = options.skipOnMissing !== false;
	const localOnly = options.localOnly === true;
	const entries = Object.entries(options.registry).filter(([, entry]) => entry.hidden !== true);
	const generatedAt = deps.now().toISOString();
	const previousResponse = await deps.fetch(`${endpoint}/api/sync/manifest`, {
		headers: syncRequestHeaders(options.token, options.access),
	});
	if (!previousResponse.ok) {
		throw new Error(`could not read current cloud manifest (${previousResponse.status})`);
	}
	const previousValue: unknown = await previousResponse.json();
	const previous = isPublicManifest(previousValue) ? previousValue : null;
	const previousById = new Map<string, PublicPala>(
		(previous?.tots ?? []).map((pala) => [pala.id, pala]),
	);
	const results: Array<{ pala: PublicPala; objectsUploaded: number } | null> = new Array(
		entries.length,
	);
	const skipped: string[] = [];
	let cursor = 0;

	async function worker(): Promise<void> {
		const index = cursor++;
		const pair = entries[index];
		if (!pair) return;
		const [file, entry] = pair;
		deps.log(`syncing ${index + 1}/${entries.length}  ${entry.slug}`);
		try {
			results[index] = await syncOnePala(
				file,
				entry,
				endpoint,
				options.token,
				options.access,
				generatedAt,
				deps,
				{ localOnly },
			);
		} catch (error) {
			if (!skipOnMissing) throw error;
			const message = error instanceof Error ? error.message : String(error);
			deps.log(`  ↳ warn: ${message}`);
			const fallback = buildMetadataOnlyEntry(file, entry, generatedAt, previousById);
			if (fallback) {
				results[index] = fallback;
				deps.log(`  ↳ metadata-only update (previous content retained)`);
			} else {
				results[index] = null;
				skipped.push(entry.slug);
				deps.log(`  ↳ skipped (no source, no previous manifest entry)`);
			}
		}
		return worker();
	}

	await Promise.all(Array.from({ length: Math.min(4, Math.max(entries.length, 1)) }, worker));
	let palas = results
		.filter((r): r is { pala: PublicPala; objectsUploaded: number } => r !== null)
		.map((r) => r.pala)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	if (previous) {
		const previousById = new Map(previous.tots.map((pala) => [pala.id, pala]));
		palas = palas.map((pala) => {
			const previousPala = previousById.get(pala.id);
			if (!previousPala || previousPala.contentHash !== pala.contentHash) return pala;
			const candidate = { ...pala, syncedAt: previousPala.syncedAt };
			return JSON.stringify(candidate) === JSON.stringify(previousPala) ? candidate : pala;
		});
	}
	const objectsUploaded = results
		.filter((r): r is { pala: PublicPala; objectsUploaded: number } => r !== null)
		.reduce((sum, result) => sum + result.objectsUploaded, 0);
	if (previous && JSON.stringify(previous.tots) === JSON.stringify(palas)) {
		return {
			count: palas.length,
			objectsUploaded,
			manifestUpdated: false,
			manifestUrl: `${endpoint}/api/tots`,
			skipped,
		};
	}
	const manifest = { tots: palas, count: palas.length, generatedAt };
	const manifestBody = JSON.stringify(manifest);
	const manifestResponse = await deps.fetch(`${endpoint}/api/sync/manifest`, {
		method: "PUT",
		headers: syncRequestHeaders(options.token, options.access, {
			"content-length": String(Buffer.byteLength(manifestBody)),
			"content-type": "application/json; charset=utf-8",
		}),
		body: manifestBody,
	});
	if (!manifestResponse.ok) {
		throw new Error(`manifest upload failed (${manifestResponse.status})`);
	}

	return {
		count: palas.length,
		objectsUploaded,
		manifestUpdated: true,
		manifestUrl: `${endpoint}/api/tots`,
		skipped,
	};
}

/**
 * Build a manifest entry from local registry metadata plus the previous
 * cloud manifest's content fields. Used when the source document is no
 * longer available (e.g. a /tmp file was cleaned up) so that local edits
 * like project tags still propagate to the cloud manifest.
 */
function buildMetadataOnlyEntry(
	file: string,
	entry: RegistryEntry,
	syncedAt: string,
	previousById: Map<string, PublicPala>,
): { pala: PublicPala; objectsUploaded: number } | null {
	const previous = previousById.get(entry.slug);
	if (!previous) return null;
	const docPath = safeWorkspacePath(entry.docPath);
	const assetPaths = Object.keys(entry.assets ?? {})
		.map(safeWorkspacePath)
		.sort();
	const displayTitle = entry.displayTitle ?? previous.title;
	const projects = normalizeProjects(entry.projects ?? []);
	const pala: PublicPala = {
		...previous,
		title: displayTitle,
		file: path.basename(file),
		slug: entry.slug,
		kind: entry.kind,
		docPath,
		bytes: previous.bytes,
		createdAt: entry.createdAt,
		contentHash: previous.contentHash,
		docSha256: previous.docSha256,
		assetCount: assetPaths.length,
		assetPaths,
		assetHashes: previous.assetHashes,
		assetContentTypes: previous.assetContentTypes,
		syncedAt,
		projects,
	};
	return { pala, objectsUploaded: 0 };
}

export function loadCloudSyncSettings(file = SETTINGS_FILE): CloudSyncSettings | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CloudSyncSettings>;
		return typeof parsed.endpoint === "string"
			? { endpoint: normalizedEndpoint(parsed.endpoint) }
			: null;
	} catch {
		return null;
	}
}

export function saveCloudSyncSettings(endpoint: string, file = SETTINGS_FILE): CloudSyncSettings {
	const settings = { endpoint: normalizedEndpoint(endpoint) };
	const temporary = `${file}.tmp.${process.pid}.${Date.now()}`;
	fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
	fs.chmodSync(temporary, 0o600);
	fs.renameSync(temporary, file);
	return settings;
}

export function cloudSyncToken(endpoint: string): string | null {
	if (process.env.TOT_DASHBOARD_SYNC_TOKEN) return process.env.TOT_DASHBOARD_SYNC_TOKEN;
	if (process.platform !== "darwin") return null;
	const account = new URL(normalizedEndpoint(endpoint)).host;
	const result = spawnSync(
		"security",
		["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	);
	return result.status === 0 ? result.stdout.trim() || null : null;
}

function keychainValue(service: string, account: string): string | null {
	if (process.platform !== "darwin") return null;
	const result = spawnSync(
		"security",
		["find-generic-password", "-s", service, "-a", account, "-w"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	);
	return result.status === 0 ? result.stdout?.trim() || null : null;
}

export function cloudAccessCredentials(endpoint: string): CloudAccessCredentials | null {
	const environmentId = process.env.CF_ACCESS_CLIENT_ID?.trim();
	const environmentSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();
	if (environmentId || environmentSecret) {
		if (!environmentId || !environmentSecret) {
			throw new Error("both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required");
		}
		return { clientId: environmentId, clientSecret: environmentSecret };
	}

	const host = new URL(normalizedEndpoint(endpoint)).host;
	const clientId = keychainValue(ACCESS_KEYCHAIN_SERVICE, `${host}:client-id`);
	const clientSecret = keychainValue(ACCESS_KEYCHAIN_SERVICE, `${host}:client-secret`);
	if (clientId || clientSecret) {
		if (!clientId || !clientSecret) {
			throw new Error("Cloudflare Access credentials are incomplete in Keychain");
		}
		return { clientId, clientSecret };
	}
	return null;
}

export function saveCloudSyncToken(endpoint: string, token: string): void {
	if (process.platform !== "darwin") {
		throw new Error("saving the sync token is only supported in macOS Keychain");
	}
	const account = new URL(normalizedEndpoint(endpoint)).host;
	const result = spawnSync(
		"security",
		["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
		{ encoding: "utf8", input: `${token}\n`, stdio: ["pipe", "ignore", "pipe"] },
	);
	if (result.status !== 0) {
		throw new Error(`could not save sync token in Keychain: ${result.stderr.trim()}`);
	}
}

function isPublicPala(value: unknown): value is PublicPala {
	if (typeof value !== "object" || value === null) return false;
	const pala = value as Partial<PublicPala>;
	return (
		typeof pala.id === "string" &&
		typeof pala.title === "string" &&
		typeof pala.file === "string" &&
		typeof pala.url === "string" &&
		typeof pala.originalUrl === "string" &&
		typeof pala.slug === "string" &&
		pala.id === pala.slug &&
		SLUG_PATTERN.test(pala.slug) &&
		(pala.kind === "html" || pala.kind === "markdown") &&
		typeof pala.contentHash === "string" &&
		HASH_PATTERN.test(pala.contentHash) &&
		typeof pala.docSha256 === "string" &&
		HASH_PATTERN.test(pala.docSha256) &&
		typeof pala.docPath === "string" &&
		isSafeWorkspacePath(pala.docPath) &&
		typeof pala.docContentType === "string" &&
		pala.docContentType.length > 0 &&
		typeof pala.bytes === "number" &&
		Number.isFinite(pala.bytes) &&
		pala.bytes >= 0 &&
		typeof pala.createdAt === "string" &&
		isIsoTimestamp(pala.createdAt) &&
		typeof pala.assetCount === "number" &&
		Array.isArray(pala.assetPaths) &&
		pala.assetCount === pala.assetPaths.length &&
		pala.assetPaths.every(
			(assetPath) => typeof assetPath === "string" && isSafeWorkspacePath(assetPath),
		) &&
		typeof pala.assetHashes === "object" &&
		pala.assetHashes !== null &&
		!Array.isArray(pala.assetHashes) &&
		Object.keys(pala.assetHashes).length === pala.assetPaths.length &&
		pala.assetPaths.every((assetPath) => HASH_PATTERN.test(pala.assetHashes![assetPath] ?? "")) &&
		typeof pala.assetContentTypes === "object" &&
		pala.assetContentTypes !== null &&
		!Array.isArray(pala.assetContentTypes) &&
		Object.keys(pala.assetContentTypes).length === pala.assetPaths.length &&
		pala.assetPaths.every(
			(assetPath) =>
				typeof pala.assetContentTypes![assetPath] === "string" &&
				pala.assetContentTypes![assetPath]!.length > 0,
		) &&
		typeof pala.syncedAt === "string" &&
		isIsoTimestamp(pala.syncedAt) &&
		// Optional for backward compatibility with pre-projects manifests;
		// readers treat a missing field as [].
		(pala.projects === undefined ||
			(Array.isArray(pala.projects) &&
				pala.projects.every((slug) => typeof slug === "string" && isProjectSlug(slug))))
	);
}

function isSafeWorkspacePath(value: string): boolean {
	try {
		return safeWorkspacePath(value) === value;
	} catch {
		return false;
	}
}

function isIsoTimestamp(value: string): boolean {
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function isPublicManifest(value: unknown): value is PublicManifest {
	if (typeof value !== "object" || value === null) return false;
	const manifest = value as Partial<PublicManifest>;
	return (
		Array.isArray(manifest.tots) &&
		manifest.tots.every(isPublicPala) &&
		manifest.count === manifest.tots.length &&
		typeof manifest.generatedAt === "string" &&
		isIsoTimestamp(manifest.generatedAt)
	);
}

function safeBackupPath(root: string, ...segments: string[]): string {
	const output = path.resolve(root, ...segments);
	if (output !== root && !output.startsWith(`${root}${path.sep}`)) {
		throw new Error("cloud manifest contains a path outside the backup directory");
	}
	return output;
}

function atomicWriteFile(file: string, body: string | Uint8Array): void {
	const temporary = `${file}.tmp.${process.pid}.${Date.now()}`;
	fs.writeFileSync(temporary, body, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

async function limitedResponseBytes(
	response: Response,
	maximum: number,
	label: string,
): Promise<Uint8Array> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength && Number(declaredLength) > maximum) {
		throw new Error(`${label} exceeds ${maximum} bytes`);
	}
	if (!response.body) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	const reader = response.body.getReader();
	let total = 0;
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- streams are consumed sequentially.
		const result = await reader.read();
		if (result.done) break;
		total += result.value.byteLength;
		if (total > maximum) {
			// oxlint-disable-next-line no-await-in-loop -- cancellation belongs to this read.
			await reader.cancel();
			throw new Error(`${label} exceeds ${maximum} bytes`);
		}
		chunks.push(result.value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function manifestObjects(manifest: PublicManifest) {
	return manifest.tots.flatMap((pala, index) => [
		{
			index,
			objectPath: pala.docPath,
			expectedHash: pala.docSha256,
			contentType: pala.docContentType,
			pala,
		},
		...pala.assetPaths.map((objectPath) => ({
			index,
			objectPath,
			expectedHash: pala.assetHashes[objectPath]!,
			contentType: pala.assetContentTypes[objectPath]!,
			pala,
		})),
	]);
}

export async function backupCloudDashboard(
	options: CloudBackupOptions,
	deps: Pick<CloudSyncDeps, "fetch" | "log"> = {
		fetch,
		log: (message) => console.log(message),
	},
): Promise<{ count: number; downloaded: number; directory: string }> {
	const endpoint = normalizedEndpoint(options.endpoint);
	const manifestResponse = await deps.fetch(`${endpoint}/api/sync/manifest`, {
		headers: syncRequestHeaders(options.token, options.access),
	});
	if (!manifestResponse.ok) {
		throw new Error(`could not download cloud manifest (${manifestResponse.status})`);
	}
	const manifestBytes = await limitedResponseBytes(
		manifestResponse,
		MAX_MANIFEST_BYTES,
		"cloud manifest",
	);
	let manifest: unknown;
	try {
		manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
	} catch {
		throw new Error("cloud manifest must be valid JSON");
	}
	if (!isPublicManifest(manifest)) {
		throw new Error("cloud manifest has an invalid shape");
	}

	const root = path.resolve(options.directory);
	const totCount = manifest.tots.length;
	let downloaded = 0;
	const objects = manifestObjects(manifest);
	let cursor = 0;
	async function backupWorker(): Promise<void> {
		const object = objects[cursor++];
		if (!object) return;
		const safePath = safeWorkspacePath(object.objectPath);
		const relativeKey = `tots/${object.pala.slug}/${object.pala.contentHash}/${safePath}`;
		const output = safeBackupPath(root, relativeKey);
		const existingIsValid =
			fs.existsSync(output) &&
			fs.statSync(output).size <= MAX_DOWNLOAD_BYTES &&
			sha256(fs.readFileSync(output)) === object.expectedHash;
		if (!existingIsValid) {
			deps.log(`backing up ${object.index + 1}/${totCount}  ${relativeKey}`);
			const response = await deps.fetch(
				`${endpoint}/api/sync/object?key=${encodeURIComponent(relativeKey)}`,
				{ headers: syncRequestHeaders(options.token, options.access) },
			);
			if (!response.ok) {
				throw new Error(`backup download failed (${response.status}): ${relativeKey}`);
			}
			const bytes = await limitedResponseBytes(response, MAX_DOWNLOAD_BYTES, relativeKey);
			if (sha256(bytes) !== object.expectedHash) {
				throw new Error(`backup digest mismatch: ${relativeKey}`);
			}
			fs.mkdirSync(path.dirname(output), { recursive: true });
			const temporary = `${output}.tmp.${process.pid}.${Date.now()}`;
			fs.writeFileSync(temporary, bytes, { mode: 0o600 });
			fs.renameSync(temporary, output);
			downloaded++;
		}
		return backupWorker();
	}
	await Promise.all(
		Array.from({ length: Math.min(4, Math.max(objects.length, 1)) }, backupWorker),
	);

	const manifestDirectory = safeBackupPath(root, "manifest");
	fs.mkdirSync(safeBackupPath(manifestDirectory, "snapshots"), { recursive: true });
	const body = JSON.stringify(manifest, null, 2);
	atomicWriteFile(safeBackupPath(manifestDirectory, "current.json"), body);
	atomicWriteFile(
		safeBackupPath(
			manifestDirectory,
			"snapshots",
			`${manifest.generatedAt.replace(/[:.]/g, "-")}.json`,
		),
		body,
	);
	return { count: totCount, downloaded, directory: root };
}

export async function restoreCloudDashboard(
	options: CloudRestoreOptions,
	deps: Pick<CloudSyncDeps, "fetch" | "log" | "now"> = {
		fetch,
		log: (message) => console.log(message),
		now: () => new Date(),
	},
): Promise<{ count: number; uploaded: number; directory: string }> {
	const endpoint = normalizedEndpoint(options.endpoint);
	const root = path.resolve(options.directory);
	const manifestFile = safeBackupPath(root, "manifest", "current.json");
	if (!fs.existsSync(manifestFile) || fs.statSync(manifestFile).size > MAX_MANIFEST_BYTES) {
		throw new Error("backup manifest is missing or too large");
	}
	let manifest: unknown;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
	} catch {
		throw new Error("backup manifest must be valid JSON");
	}
	if (!isPublicManifest(manifest)) throw new Error("backup manifest has an invalid shape");

	const objects = manifestObjects(manifest);
	const totCount = manifest.tots.length;
	let cursor = 0;
	let uploaded = 0;
	async function restoreWorker(): Promise<void> {
		const object = objects[cursor++];
		if (!object) return;
		const relativeKey = `tots/${object.pala.slug}/${object.pala.contentHash}/${object.objectPath}`;
		const input = safeBackupPath(root, relativeKey);
		if (!fs.existsSync(input) || fs.statSync(input).size > MAX_DOWNLOAD_BYTES) {
			throw new Error(`backup object is missing or too large: ${relativeKey}`);
		}
		const bytes = fs.readFileSync(input);
		if (sha256(bytes) !== object.expectedHash) {
			throw new Error(`backup digest mismatch: ${relativeKey}`);
		}
		deps.log(`restoring ${object.index + 1}/${totCount}  ${relativeKey}`);
		const response = await deps.fetch(
			`${endpoint}/api/sync/object?key=${encodeURIComponent(relativeKey)}`,
			{
				method: "PUT",
				headers: syncRequestHeaders(options.token, options.access, {
					"content-length": String(bytes.byteLength),
					"content-type": object.contentType,
					"x-tot-sha256": object.expectedHash,
				}),
				body: bytes,
			},
		);
		if (!response.ok)
			throw new Error(`restore upload failed (${response.status}): ${relativeKey}`);
		if (response.status !== 204) uploaded++;
		return restoreWorker();
	}
	await Promise.all(
		Array.from({ length: Math.min(4, Math.max(objects.length, 1)) }, restoreWorker),
	);

	const restoredManifest: PublicManifest = {
		...manifest,
		tots: manifest.tots.map((pala) => ({
			...pala,
			// Same-origin path (see the sync builder): the dashboard frames this and
			// its CSP frame-src is 'self', so an absolute cross-origin URL is blocked.
			url: `/mirror/${encodeURIComponent(pala.slug)}/${pala.contentHash}/${encodedPath(pala.docPath)}`,
		})),
		generatedAt: deps.now().toISOString(),
	};
	const manifestBody = JSON.stringify(restoredManifest);
	const response = await deps.fetch(`${endpoint}/api/sync/manifest`, {
		method: "PUT",
		headers: syncRequestHeaders(options.token, options.access, {
			"content-length": String(Buffer.byteLength(manifestBody)),
			"content-type": "application/json; charset=utf-8",
		}),
		body: manifestBody,
	});
	if (!response.ok) throw new Error(`restore manifest upload failed (${response.status})`);
	return { count: totCount, uploaded, directory: root };
}
