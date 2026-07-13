import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const MANIFEST_KEY = "manifest/current.json";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_OBJECT_BYTES = 100 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const OBJECT_KEY_PATTERN = /^tots\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\/[A-Za-z0-9._~!$&'()+,;=:@%/-]+$/;

interface PublicTot {
	id: string;
	title: string;
	file: string;
	url: string;
	originalUrl: string;
	slug: string;
	kind: "markdown" | "html";
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

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
	return Response.json(body, {
		status,
		headers: {
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			...headers,
		},
	});
}

function errorResponse(status: number, message: string): Response {
	return jsonResponse({ error: message }, status);
}

function contentLength(request: Request): number | null {
	const value = request.headers.get("content-length");
	if (value === null || !/^\d+$/.test(value)) return null;
	return Number(value);
}

async function readRequestBytes(request: Request, maximum: number): Promise<Uint8Array> {
	if (!request.body) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	const reader = request.body.getReader();
	let total = 0;
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- request streams are consumed sequentially.
		const result = await reader.read();
		if (result.done) break;
		total += result.value.byteLength;
		if (total > maximum) {
			// oxlint-disable-next-line no-await-in-loop -- cancellation belongs to this read.
			await reader.cancel();
			throw new Error("BODY_TOO_LARGE");
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

async function secretsMatch(provided: string, expected: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [providedHash, expectedHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(provided)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	const providedBytes = new Uint8Array(providedHash);
	const expectedBytes = new Uint8Array(expectedHash);
	let difference = 0;
	for (let index = 0; index < providedBytes.length; index++) {
		difference |= providedBytes[index]! ^ expectedBytes[index]!;
	}
	return difference === 0;
}

async function authenticateSync(request: Request, env: Env): Promise<boolean> {
	const authorization = request.headers.get("authorization");
	if (!authorization?.startsWith("Bearer ")) return false;
	return secretsMatch(authorization.slice(7), env.SYNC_SECRET);
}

async function authenticateAccess(request: Request, env: Env): Promise<boolean> {
	if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
	const token = request.headers.get("cf-access-jwt-assertion");
	if (!token) return false;
	const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
	try {
		const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
		await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD });
		return true;
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "Access JWT validation failed",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
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
		/^[A-Za-z0-9_-]+$/.test(tot.slug) &&
		(tot.kind === "markdown" || tot.kind === "html") &&
		typeof tot.docPath === "string" &&
		typeof tot.docContentType === "string" &&
		tot.docContentType.length > 0 &&
		typeof tot.bytes === "number" &&
		Number.isFinite(tot.bytes) &&
		tot.bytes >= 0 &&
		typeof tot.createdAt === "string" &&
		isIsoTimestamp(tot.createdAt) &&
		typeof tot.contentHash === "string" &&
		HASH_PATTERN.test(tot.contentHash) &&
		typeof tot.docSha256 === "string" &&
		HASH_PATTERN.test(tot.docSha256) &&
		typeof tot.assetCount === "number" &&
		Array.isArray(tot.assetPaths) &&
		tot.assetCount === tot.assetPaths.length &&
		tot.assetPaths.every((assetPath) => typeof assetPath === "string") &&
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

function isPublicManifest(value: unknown): value is PublicManifest {
	if (typeof value !== "object" || value === null) return false;
	const manifest = value as Partial<PublicManifest>;
	return (
		Array.isArray(manifest.tots) &&
		manifest.tots.length <= 10_000 &&
		manifest.tots.every(isPublicTot) &&
		manifest.count === manifest.tots.length &&
		typeof manifest.generatedAt === "string" &&
		isIsoTimestamp(manifest.generatedAt)
	);
}

async function serveManifest(env: Env): Promise<Response> {
	const object = await env.TOTS_BUCKET.get(MANIFEST_KEY);
	if (!object) {
		return jsonResponse({ tots: [], count: 0, generatedAt: new Date(0).toISOString() });
	}
	return new Response(object.body, {
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

async function storeManifest(request: Request, env: Env): Promise<Response> {
	const length = contentLength(request);
	if (length === null) return errorResponse(411, "content-length is required");
	if (length > MAX_MANIFEST_BYTES) return errorResponse(413, "manifest is too large");

	let bytes: Uint8Array;
	try {
		bytes = await readRequestBytes(request, MAX_MANIFEST_BYTES);
	} catch (error) {
		if (error instanceof Error && error.message === "BODY_TOO_LARGE") {
			return errorResponse(413, "manifest is too large");
		}
		throw error;
	}
	if (bytes.byteLength !== length) {
		return errorResponse(422, "manifest body does not match its declared length");
	}
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return errorResponse(400, "manifest must be valid JSON");
	}
	if (!isPublicManifest(value)) return errorResponse(422, "manifest shape is invalid");

	const body = JSON.stringify(value);
	const snapshotKey = `manifest/snapshots/${value.generatedAt.replace(/[:.]/g, "-")}.json`;
	const options: R2PutOptions = {
		httpMetadata: { contentType: "application/json; charset=utf-8" },
		customMetadata: { generatedAt: value.generatedAt },
	};
	const current = await env.TOTS_BUCKET.head(MANIFEST_KEY);
	const currentGeneratedAt = current?.customMetadata?.generatedAt;
	if (currentGeneratedAt && currentGeneratedAt >= value.generatedAt) {
		return errorResponse(409, "a newer or identical manifest already exists");
	}
	await env.TOTS_BUCKET.put(snapshotKey, body, options);
	const updated = await env.TOTS_BUCKET.put(MANIFEST_KEY, body, {
		...options,
		onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
	});
	if (!updated) return errorResponse(409, "manifest changed during sync; retry reconciliation");
	console.log(JSON.stringify({ message: "manifest synced", count: value.count, snapshotKey }));
	return jsonResponse({ ok: true, count: value.count, snapshotKey });
}

async function storeObject(request: Request, env: Env, url: URL): Promise<Response> {
	const key = url.searchParams.get("key");
	const sha256 = request.headers.get("x-tot-sha256");
	if (!key || !OBJECT_KEY_PATTERN.test(key) || key.includes("..")) {
		return errorResponse(400, "invalid object key");
	}
	if (!sha256 || !HASH_PATTERN.test(sha256)) {
		return errorResponse(400, "x-tot-sha256 must be a SHA-256 hex digest");
	}
	const length = contentLength(request);
	if (length === null) return errorResponse(411, "content-length is required");
	if (length > MAX_OBJECT_BYTES) return errorResponse(413, "object is too large");
	if (!request.body) return errorResponse(400, "object body is required");

	const existing = await env.TOTS_BUCKET.head(key);
	if (existing?.customMetadata?.sha256 === sha256) {
		return new Response(null, { status: 204 });
	}
	if (existing) return errorResponse(409, "object key already exists with a different digest");

	const hash = createHash("sha256");
	let actualLength = 0;
	const verifiedBody = request.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				actualLength += chunk.byteLength;
				if (actualLength > MAX_OBJECT_BYTES) throw new Error("OBJECT_TOO_LARGE");
				hash.update(chunk);
				controller.enqueue(chunk);
			},
		}),
	);
	const stagingKey = `staging/${crypto.randomUUID()}`;
	try {
		try {
			await env.TOTS_BUCKET.put(stagingKey, verifiedBody);
		} catch (error) {
			if (error instanceof Error && error.message === "OBJECT_TOO_LARGE") {
				return errorResponse(413, "object is too large");
			}
			throw error;
		}
		const actualSha256 = hash.digest("hex");
		if (actualLength !== length || actualSha256 !== sha256) {
			return errorResponse(422, "object body does not match its declared length or digest");
		}
		const staged = await env.TOTS_BUCKET.get(stagingKey);
		if (!staged) return errorResponse(500, "staged object could not be read");
		const stored = await env.TOTS_BUCKET.put(key, staged.body, {
			httpMetadata: {
				contentType: request.headers.get("content-type") ?? "application/octet-stream",
			},
			customMetadata: { sha256 },
			onlyIf: { etagDoesNotMatch: "*" },
		});
		if (stored) return jsonResponse({ ok: true, key }, 201);
		const winner = await env.TOTS_BUCKET.head(key);
		return winner?.customMetadata?.sha256 === sha256
			? new Response(null, { status: 204 })
			: errorResponse(409, "object key already exists with a different digest");
	} finally {
		await env.TOTS_BUCKET.delete(stagingKey);
	}
}

async function readSyncObject(env: Env, url: URL): Promise<Response> {
	const key = url.searchParams.get("key");
	if (!key || !OBJECT_KEY_PATTERN.test(key) || key.includes("..")) {
		return errorResponse(400, "invalid object key");
	}
	const object = await env.TOTS_BUCKET.get(key);
	if (!object) return errorResponse(404, "not found");
	const headers = new Headers({ "cache-control": "no-store" });
	object.writeHttpMetadata(headers);
	headers.set("etag", object.httpEtag);
	return new Response(object.body, { headers });
}

async function serveMirror(request: Request, env: Env, url: URL): Promise<Response> {
	let relativePath: string;
	try {
		relativePath = decodeURIComponent(url.pathname.slice("/mirror/".length));
	} catch {
		return errorResponse(400, "invalid mirror path");
	}
	const key = `tots/${relativePath}`;
	if (!OBJECT_KEY_PATTERN.test(key) || key.includes("..")) return errorResponse(404, "not found");
	const object = await env.TOTS_BUCKET.get(key);
	if (!object) return errorResponse(404, "not found");

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("cache-control", "private, max-age=31536000, immutable");
	headers.set("etag", object.httpEtag);
	headers.set("x-content-type-options", "nosniff");
	if (headers.get("content-type")?.toLowerCase().includes("text/html")) {
		headers.set(
			"content-security-policy",
			"sandbox allow-scripts allow-forms; base-uri 'none'",
		);
	}
	return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

function withDashboardSecurity(response: Response): Response {
	const secured = new Response(response.body, response);
	secured.headers.set(
		"content-security-policy",
		"default-src 'self'; frame-src 'self' https://tot.page; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
	);
	secured.headers.set("referrer-policy", "no-referrer");
	secured.headers.set("x-content-type-options", "nosniff");
	secured.headers.set("x-frame-options", "DENY");
	return secured;
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === "/health") {
		return jsonResponse({
			ok: true,
			authConfigured: Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD),
		});
	}

	if (url.pathname.startsWith("/api/sync/")) {
		if (!(await authenticateSync(request, env))) return errorResponse(401, "unauthorized");
		if (request.method === "GET" && url.pathname === "/api/sync/manifest") {
			return serveManifest(env);
		}
		if (request.method === "GET" && url.pathname === "/api/sync/object") {
			return readSyncObject(env, url);
		}
		if (request.method === "PUT" && url.pathname === "/api/sync/object") {
			return storeObject(request, env, url);
		}
		if (request.method === "PUT" && url.pathname === "/api/sync/manifest") {
			return storeManifest(request, env);
		}
		return errorResponse(404, "not found");
	}

	if (!(await authenticateAccess(request, env))) {
		return errorResponse(
			env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD ? 401 : 503,
			env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD
				? "Cloudflare Access authentication required"
				: "Cloudflare Access is not configured",
		);
	}

	if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/tots") {
		return serveManifest(env);
	}
	if (
		(request.method === "GET" || request.method === "HEAD") &&
		url.pathname.startsWith("/mirror/")
	) {
		return serveMirror(request, env, url);
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return errorResponse(405, "method not allowed");
	}
	return withDashboardSecurity(await env.ASSETS.fetch(request));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			return await handleRequest(request, env);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "unhandled request error",
					path: new URL(request.url).pathname,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			return errorResponse(500, "internal server error");
		}
	},
} satisfies ExportedHandler<Env>;
