import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { RegistryEntry } from "./config.js";
import { dashboardTitleFromFile } from "./dashboard.js";

const KEYCHAIN_SERVICE = "tot-dashboard-sync";
const ACCESS_KEYCHAIN_SERVICE = "tot-dashboard-access";
const SETTINGS_FILE = path.join(os.homedir(), ".tot-dashboard");
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;

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
}

export interface CloudSyncDeps {
	fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	now: () => Date;
	log: (message: string) => void;
}

interface PublicTot {
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
}

interface PublicManifest {
	tots: PublicTot[];
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

async function syncOneTot(
	file: string,
	entry: RegistryEntry,
	endpoint: string,
	token: string,
	access: CloudAccessCredentials | undefined,
	syncedAt: string,
	deps: CloudSyncDeps,
): Promise<{ tot: PublicTot; objectsUploaded: number }> {
	const docPath = safeWorkspacePath(entry.docPath);
	const assetPaths = Object.keys(entry.assets ?? {})
		.map(safeWorkspacePath)
		.sort();
	const document = await download(entry.url, deps);
	let documentBytes = document.bytes;
	let documentTitle: string | null = null;

	if (entry.kind === "html") {
		const html = new TextDecoder().decode(document.bytes);
		documentTitle = titleFromHtml(html);
		documentBytes = new TextEncoder().encode(rewriteAssetUrls(html, entry, assetPaths));
	}

	const assets = await Promise.all(
		assetPaths.map(async (assetPath): Promise<MirroredAsset> => {
			const assetUrl = new URL(`/${entry.slug}/${encodedPath(assetPath)}`, entry.url).href;
			const object = await download(assetUrl, deps);
			return { path: assetPath, object, sha256: sha256(object.bytes) };
		}),
	);
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

	const mirrorPath = `/mirror/${encodeURIComponent(entry.slug)}/${contentHash}/${encodedPath(docPath)}`;
	return {
		tot: {
			id: entry.slug,
			title: documentTitle || dashboardTitleFromFile(file, docPath) || "Untitled Tot",
			file: path.basename(file),
			url: `${endpoint}${mirrorPath}`,
			originalUrl: entry.url,
			slug: entry.slug,
			kind: entry.kind,
			docPath,
			docContentType: document.contentType,
			bytes: documentBytes.byteLength,
			createdAt: entry.createdAt,
			contentHash,
			docSha256,
			assetCount: assetPaths.length,
			assetPaths,
			assetHashes: Object.fromEntries(assets.map((asset) => [asset.path, asset.sha256])),
			assetContentTypes: Object.fromEntries(
				assets.map((asset) => [asset.path, asset.object.contentType]),
			),
			syncedAt,
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
	const entries = Object.entries(options.registry);
	const generatedAt = deps.now().toISOString();
	const previousResponse = await deps.fetch(`${endpoint}/api/sync/manifest`, {
		headers: syncRequestHeaders(options.token, options.access),
	});
	if (!previousResponse.ok) {
		throw new Error(`could not read current cloud manifest (${previousResponse.status})`);
	}
	const previousValue: unknown = await previousResponse.json();
	const previous = isPublicManifest(previousValue) ? previousValue : null;
	const results: Array<{ tot: PublicTot; objectsUploaded: number }> = new Array(entries.length);
	let cursor = 0;

	async function worker(): Promise<void> {
		const index = cursor++;
		const pair = entries[index];
		if (!pair) return;
		const [file, entry] = pair;
		deps.log(`syncing ${index + 1}/${entries.length}  ${entry.slug}`);
		results[index] = await syncOneTot(
			file,
			entry,
			endpoint,
			options.token,
			options.access,
			generatedAt,
			deps,
		);
		return worker();
	}

	await Promise.all(Array.from({ length: Math.min(4, Math.max(entries.length, 1)) }, worker));
	let tots = results
		.map((result) => result.tot)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	if (previous) {
		const previousById = new Map(previous.tots.map((tot) => [tot.id, tot]));
		tots = tots.map((tot) => {
			const previousTot = previousById.get(tot.id);
			if (!previousTot || previousTot.contentHash !== tot.contentHash) return tot;
			const candidate = { ...tot, syncedAt: previousTot.syncedAt };
			return JSON.stringify(candidate) === JSON.stringify(previousTot) ? candidate : tot;
		});
	}
	const objectsUploaded = results.reduce((sum, result) => sum + result.objectsUploaded, 0);
	if (previous && JSON.stringify(previous.tots) === JSON.stringify(tots)) {
		return {
			count: tots.length,
			objectsUploaded,
			manifestUpdated: false,
			manifestUrl: `${endpoint}/api/tots`,
		};
	}
	const manifest = { tots, count: tots.length, generatedAt };
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
		count: tots.length,
		objectsUploaded,
		manifestUpdated: true,
		manifestUrl: `${endpoint}/api/tots`,
	};
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

function isPublicTot(value: unknown): value is PublicTot {
	if (typeof value !== "object" || value === null) return false;
	const tot = value as Partial<PublicTot>;
	return (
		typeof tot.id === "string" &&
		typeof tot.title === "string" &&
		typeof tot.file === "string" &&
		typeof tot.url === "string" &&
		typeof tot.originalUrl === "string" &&
		typeof tot.slug === "string" &&
		tot.id === tot.slug &&
		SLUG_PATTERN.test(tot.slug) &&
		(tot.kind === "html" || tot.kind === "markdown") &&
		typeof tot.contentHash === "string" &&
		HASH_PATTERN.test(tot.contentHash) &&
		typeof tot.docSha256 === "string" &&
		HASH_PATTERN.test(tot.docSha256) &&
		typeof tot.docPath === "string" &&
		isSafeWorkspacePath(tot.docPath) &&
		typeof tot.docContentType === "string" &&
		tot.docContentType.length > 0 &&
		typeof tot.bytes === "number" &&
		Number.isFinite(tot.bytes) &&
		tot.bytes >= 0 &&
		typeof tot.createdAt === "string" &&
		isIsoTimestamp(tot.createdAt) &&
		typeof tot.assetCount === "number" &&
		Array.isArray(tot.assetPaths) &&
		tot.assetCount === tot.assetPaths.length &&
		tot.assetPaths.every(
			(assetPath) => typeof assetPath === "string" && isSafeWorkspacePath(assetPath),
		) &&
		typeof tot.assetHashes === "object" &&
		tot.assetHashes !== null &&
		!Array.isArray(tot.assetHashes) &&
		Object.keys(tot.assetHashes).length === tot.assetPaths.length &&
		tot.assetPaths.every((assetPath) => HASH_PATTERN.test(tot.assetHashes![assetPath] ?? "")) &&
		typeof tot.assetContentTypes === "object" &&
		tot.assetContentTypes !== null &&
		!Array.isArray(tot.assetContentTypes) &&
		Object.keys(tot.assetContentTypes).length === tot.assetPaths.length &&
		tot.assetPaths.every(
			(assetPath) =>
				typeof tot.assetContentTypes![assetPath] === "string" &&
				tot.assetContentTypes![assetPath]!.length > 0,
		) &&
		typeof tot.syncedAt === "string" &&
		isIsoTimestamp(tot.syncedAt)
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
		manifest.tots.every(isPublicTot) &&
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
	return manifest.tots.flatMap((tot, index) => [
		{
			index,
			objectPath: tot.docPath,
			expectedHash: tot.docSha256,
			contentType: tot.docContentType,
			tot,
		},
		...tot.assetPaths.map((objectPath) => ({
			index,
			objectPath,
			expectedHash: tot.assetHashes[objectPath]!,
			contentType: tot.assetContentTypes[objectPath]!,
			tot,
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
		const relativeKey = `tots/${object.tot.slug}/${object.tot.contentHash}/${safePath}`;
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
		const relativeKey = `tots/${object.tot.slug}/${object.tot.contentHash}/${object.objectPath}`;
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
		tots: manifest.tots.map((tot) => ({
			...tot,
			url: `${endpoint}/mirror/${encodeURIComponent(tot.slug)}/${tot.contentHash}/${encodedPath(tot.docPath)}`,
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
