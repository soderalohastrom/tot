// palapala-publisher — the new publishing Worker
//
// Path B replacement for the upstream @plannotator/tot edge.
// Lives at the Worker name `palapala-publisher`; the dashboard
// Worker (`tot-dashboard`) is a separate, kept Worker for clearer
// audit trail.
//
// Anonymous-by-link is the access model: link-is-the-key, anyone
// with the URL can view/update/delete — same as the current
// upstream model. The CLI uses /v1/documents and /v1/workspaces;
// the read surface is /<slug>/<path> on the new content origin.

const MAX_OBJECT_BYTES = 10 * 1024 * 1024; // 10 MB per the upstream contract
const MAX_BODY_BYTES = 1_500_000; // 1.5 MB for the bare publish
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SLUG_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const DOC_PATH_PATTERN = /^[A-Za-z0-9._~!$&'()+,;=:@%/-]+$/;

const R2_KEY_TEMPLATE = (slug: string, hash: string, docPath: string) =>
	`pages/${slug}/${hash}/${docPath}`;

const R2_ASSET_KEY_TEMPLATE = (hash: string) => `assets/${hash}`;

// D1 schema, declarative. Bootstrap with:
//   wrangler d1 execute palapala-registry --command "
//     CREATE TABLE IF NOT EXISTS documents (
//       id TEXT PRIMARY KEY,
//       workspace_id TEXT NOT NULL,
//       slug TEXT NOT NULL,
//       doc_path TEXT NOT NULL,
//       kind TEXT NOT NULL,
//       head_hash TEXT NOT NULL,
//       deleted_at TEXT,
//       created_at TEXT NOT NULL,
//       updated_at TEXT NOT NULL
//     );
//     CREATE INDEX IF NOT EXISTS idx_documents_slug ON documents(slug);
//     CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id);
//   "
//
// Versioning is synchronous. The CLI does not need to poll —
// the write returns with the new head hash.

interface Env {
	R2: R2Bucket;
	D1: D1Database;
	WORKER_NAME: string;
	WORKER_VERSION: string;
}

interface Document {
	id: string;
	workspaceId: string;
	slug: string;
	docPath: string;
	kind: "markdown" | "html";
	headHash: string;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
}

interface DocumentResponse {
	id: string;
	slug: string;
	docPath: string;
	version: string;
	url: string;
	shareUrl: string;
	fileUrl: string | null;
	createdAt: string;
}

function jsonError(status: number, message: string, code?: string): Response {
	return new Response(JSON.stringify({ error: { message, code: code ?? "ERR" } }), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function slugify(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 22);
}

async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
	let buf: ArrayBuffer;
	if (typeof input === "string") {
		buf = new TextEncoder().encode(input).buffer as ArrayBuffer;
	} else if (input instanceof Uint8Array) {
		buf = input.buffer as ArrayBuffer;
	} else {
		buf = input;
	}
	const hash = await crypto.subtle.digest("SHA-256", buf);
	return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function docHash(body: string): Promise<string> {
	return sha256Hex(body);
}

async function docContentType(kind: "markdown" | "html"): Promise<string> {
	return kind === "markdown" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8";
}

async function readBodyWithLimit(req: Request, max: number): Promise<string> {
	const len = req.headers.get("content-length");
	if (len) {
		const n = Number(len);
		if (Number.isFinite(n) && n > max) {
			throw new Error("body_too_large");
		}
	}
	const ab = await req.arrayBuffer();
	if (ab.byteLength > max) {
		throw new Error("body_too_large");
	}
	return new TextDecoder().decode(ab);
}

function nowIso(): string {
	return new Date().toISOString();
}

function buildVersionedKey(slug: string, hash: string, docPath: string): string {
	return R2_KEY_TEMPLATE(slug, hash, docPath);
}

async function readDocumentHead(env: Env, slug: string, docPath: string): Promise<Document | null> {
	const row = await env.D1.prepare(
		"SELECT id, workspace_id, slug, doc_path, kind, head_hash, created_at, updated_at, deleted_at FROM documents WHERE slug = ? AND doc_path = ? AND deleted_at IS NULL"
	).bind(slug, docPath).first<Document>();
	if (!row) return null;
	return row;
}

async function writeDocumentHead(env: Env, doc: Document): Promise<void> {
	await env.D1.prepare(
		"INSERT OR REPLACE INTO documents (id, workspace_id, slug, doc_path, kind, head_hash, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
	).bind(
		doc.id,
		doc.workspaceId,
		doc.slug,
		doc.docPath,
		doc.kind,
		doc.headHash,
		doc.createdAt,
		doc.updatedAt,
		doc.deletedAt,
	).run();
}

async function finalizeObject(env: Env, hash: string, body: string, contentType: string, slug: string, docPath: string): Promise<void> {
	const buf = new TextEncoder().encode(body);
	const versionedKey = buildVersionedKey(slug, hash, docPath);
	await env.R2.put(versionedKey, buf, {
		httpMetadata: { contentType },
	});
}

async function uploadAsset(env: Env, assetPath: string, body: ArrayBuffer, contentType: string): Promise<{ hash: string; path: string }> {
	const bytes = new Uint8Array(body);
	const hash = await sha256Hex(bytes);
	const key = R2_ASSET_KEY_TEMPLATE(hash);
	const existing = await env.R2.get(key);
	if (!existing) {
		await env.R2.put(key, bytes, { httpMetadata: { contentType } });
	}
	return { hash, path: assetPath };
}

function pathFromUrl(url: URL): string {
	const pathname = url.pathname;
	if (pathname.startsWith("/")) return pathname.slice(1);
	return pathname;
}

function parsePathComponents(slug: string, rest: string[]): { docPath: string } | null {
	if (rest.length === 0) {
		return { docPath: "index.html" };
	}
	const docPath = rest.join("/");
	if (!DOC_PATH_PATTERN.test(docPath)) {
		return null;
	}
	return { docPath };
}

function isAdminRequest(req: Request, env: Env): boolean {
	return req.url.includes("/v1/");
}

async function handleAdmin(req: Request, env: Env, path: string, _slug: string): Promise<Response> {
	if (path === "v1/documents" && req.method === "POST") {
		let body: string;
		try {
			body = await readBodyWithLimit(req, MAX_BODY_BYTES);
		} catch {
			return jsonError(413, "Body too large", "ERR_BODY_TOO_LARGE");
		}

		let parsed: { kind?: "markdown" | "html"; body?: string; slug?: string };
		try {
			parsed = JSON.parse(body);
		} catch {
			return jsonError(400, "Invalid JSON", "ERR_JSON");
		}
		if (!parsed.kind || !parsed.body) {
			return jsonError(400, "Missing kind or body", "ERR_MISSING");
		}
		if (parsed.kind !== "markdown" && parsed.kind !== "html") {
			return jsonError(400, "Invalid kind", "ERR_KIND");
		}
		if (parsed.body.length === 0) {
			return jsonError(400, "Empty body", "ERR_EMPTY");
		}
		if (parsed.body.length > MAX_BODY_BYTES) {
			return jsonError(413, "Body too large", "ERR_BODY_TOO_LARGE");
		}

		const bodyText: string = parsed.body;
		const slug: string = parsed.slug ?? slugify();
		if (!SLUG_PATTERN.test(slug)) {
			return jsonError(400, "Invalid slug", "ERR_SLUG");
		}

		const contentType = await docContentType(parsed.kind);
		const hash = await docHash(bodyText);
		const id = `doc_${hash.slice(0, 12)}`;
		const now = nowIso();

		const existing = await readDocumentHead(env, slug, "index.html");
		const doc: Document = {
			id: existing?.id ?? id,
			workspaceId: existing?.workspaceId ?? "default",
			slug,
			docPath: "index.html",
			kind: parsed.kind,
			headHash: hash,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			deletedAt: null,
		};
		await finalizeObject(env, hash, parsed.body, contentType, slug, "index.html");
		await writeDocumentHead(env, doc);

		const response: DocumentResponse = {
			id: doc.id,
			slug: doc.slug,
			docPath: doc.docPath,
			version: doc.headHash,
			url: `https://palapala.me/${doc.slug}/${doc.docPath}`,
			shareUrl: `https://palapala.me/${doc.slug}/${doc.docPath}`,
			fileUrl: `https://palapala.me/${doc.slug}/${doc.docPath}`,
			createdAt: doc.createdAt,
		};
		return new Response(JSON.stringify({ workspace: { id: "default", slug: doc.slug }, document: response }), {
			headers: { "content-type": "application/json" },
		});
	}

	if (path === "v1/workspaces" && req.method === "POST") {
		let body: string;
		try {
			body = await readBodyWithLimit(req, MAX_BODY_BYTES);
		} catch {
			return jsonError(413, "Body too large", "ERR_BODY_TOO_LARGE");
		}
		let parsed: { kind?: "markdown" | "html"; slug?: string };
		try {
			parsed = JSON.parse(body);
		} catch {
			return jsonError(400, "Invalid JSON", "ERR_JSON");
		}
		if (parsed.kind !== "markdown" && parsed.kind !== "html") {
			return jsonError(400, "Invalid kind", "ERR_KIND");
		}

		const slug: string = parsed.slug ?? slugify();
		if (!SLUG_PATTERN.test(slug)) {
			return jsonError(400, "Invalid slug", "ERR_SLUG");
		}

		const response: DocumentResponse = {
			id: `ws_${slug}`,
			slug,
			docPath: "index.html",
			version: "",
			url: `https://palapala.me/${slug}/index.html`,
			shareUrl: `https://palapala.me/${slug}/index.html`,
			fileUrl: null,
			createdAt: nowIso(),
		};
		return new Response(JSON.stringify({ workspace: { id: "default", slug }, document: response }), {
			headers: { "content-type": "application/json" },
		});
	}

	const assetMatch = path.match(/^v1\/workspaces\/([^/]+)\/assets\/(.+)$/);
	if (assetMatch && req.method === "PUT") {
		const assetPath = assetMatch[2];
		if (!DOC_PATH_PATTERN.test(assetPath)) {
			return jsonError(400, "Invalid asset path", "ERR_PATH");
		}
		const len = req.headers.get("content-length");
		if (len) {
			const n = Number(len);
			if (Number.isFinite(n) && n > MAX_OBJECT_BYTES) {
				return jsonError(413, "Asset too large", "ERR_TOO_LARGE");
			}
		}
		const ab = await req.arrayBuffer();
		if (ab.byteLength > MAX_OBJECT_BYTES) {
			return jsonError(413, "Asset too large", "ERR_TOO_LARGE");
		}
		const contentType = req.headers.get("content-type") ?? "application/octet-stream";
		const result = await uploadAsset(env, assetPath, ab, contentType);
		return new Response(JSON.stringify(result), {
			headers: { "content-type": "application/json" },
		});
	}

	const docMatch = path.match(/^v1\/workspaces\/([^/]+)\/documents$/);
	if (docMatch && req.method === "POST") {
		let body: string;
		try {
			body = await readBodyWithLimit(req, MAX_BODY_BYTES);
		} catch {
			return jsonError(413, "Body too large", "ERR_BODY_TOO_LARGE");
		}
		let parsed: { kind?: "markdown" | "html"; body?: string; slug?: string; docPath?: string };
		try {
			parsed = JSON.parse(body);
		} catch {
			return jsonError(400, "Invalid JSON", "ERR_JSON");
		}
		if (parsed.kind !== "markdown" && parsed.kind !== "html") {
			return jsonError(400, "Invalid kind", "ERR_KIND");
		}
		const slug: string = parsed.slug ?? slugify();
		if (!SLUG_PATTERN.test(slug)) {
			return jsonError(400, "Invalid slug", "ERR_SLUG");
		}
		const docPath: string = parsed.docPath ?? "index.html";
		if (!DOC_PATH_PATTERN.test(docPath)) {
			return jsonError(400, "Invalid docPath", "ERR_PATH");
		}

		const bodyText: string = parsed.body;
		const contentType = await docContentType(parsed.kind);
		const hash = await docHash(bodyText);
		const id = `doc_${hash.slice(0, 12)}`;
		const now = nowIso();

		const existing = await readDocumentHead(env, slug, docPath);
		const doc: Document = {
			id: existing?.id ?? id,
			workspaceId: existing?.workspaceId ?? "default",
			slug,
			docPath,
			kind: parsed.kind,
			headHash: hash,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			deletedAt: existing?.deletedAt ?? null,
		};
		await finalizeObject(env, hash, bodyText, contentType, slug, docPath);
		await writeDocumentHead(env, doc);

		const response: DocumentResponse = {
			id: doc.id,
			slug: doc.slug,
			docPath: doc.docPath,
			version: doc.headHash,
			url: `https://palapala.me/${doc.slug}/${doc.docPath}`,
			shareUrl: `https://palapala.me/${doc.slug}/${doc.docPath}`,
			fileUrl: `https://palapala.me/${doc.slug}/${doc.docPath}`,
			createdAt: doc.createdAt,
		};
		return new Response(JSON.stringify({ workspace: { id: "default", slug: doc.slug }, document: response }), {
			headers: { "content-type": "application/json" },
		});
	}

	const readMatch = path.match(/^v1\/workspaces\/([^/]+)\/documents\/([^/]+)$/);
	if (readMatch && req.method === "GET") {
		const docId = readMatch[2];
		const row = await env.D1.prepare(
			"SELECT id, workspace_id, slug, doc_path, kind, head_hash, created_at, updated_at, deleted_at FROM documents WHERE id = ? AND deleted_at IS NULL"
		).bind(docId).first<Document>();
		if (!row) {
			return jsonError(404, "Document not found", "ERR_NOT_FOUND");
		}
		const response: DocumentResponse = {
			id: row.id,
			slug: row.slug,
			docPath: row.docPath,
			version: row.headHash,
			url: `https://palapala.me/${row.slug}/${row.docPath}`,
			shareUrl: `https://palapala.me/${row.slug}/${row.docPath}`,
			fileUrl: `https://palapala.me/${row.slug}/${row.docPath}`,
			createdAt: row.createdAt,
		};
		return new Response(JSON.stringify({ workspace: { id: row.workspaceId, slug: row.slug }, document: response }), {
			headers: { "content-type": "application/json" },
		});
	}

	if (readMatch && req.method === "PUT") {
		const docId = readMatch[2];
		let body: string;
		try {
			body = await readBodyWithLimit(req, MAX_BODY_BYTES);
		} catch {
			return jsonError(413, "Body too large", "ERR_BODY_TOO_LARGE");
		}
		let parsed: { kind?: "markdown" | "html"; body?: string; docPath?: string };
		try {
			parsed = JSON.parse(body);
		} catch {
			return jsonError(400, "Invalid JSON", "ERR_JSON");
		}
		if (parsed.kind !== "markdown" && parsed.kind !== "html") {
			return jsonError(400, "Invalid kind", "ERR_KIND");
		}

		const bodyText: string = parsed.body;
		const existing = await env.D1.prepare(
			"SELECT id, workspace_id, slug, doc_path, kind, head_hash, created_at, updated_at, deleted_at FROM documents WHERE id = ? AND deleted_at IS NULL"
		).bind(docId).first<Document>();
		if (!existing) {
			return jsonError(404, "Document not found", "ERR_NOT_FOUND");
		}
		const contentType = await docContentType(parsed.kind);
		const hash = await docHash(bodyText);
		const now = nowIso();
		const doc: Document = {
			id: existing.id,
			workspaceId: existing.workspaceId,
			slug: existing.slug,
			docPath: parsed.docPath ?? existing.docPath,
			kind: parsed.kind,
			headHash: hash,
			createdAt: existing.createdAt,
			updatedAt: now,
			deletedAt: existing.deletedAt,
		};
		await finalizeObject(env, hash, bodyText, contentType, doc.slug, doc.docPath);
		await writeDocumentHead(env, doc);

		const response: DocumentResponse = {
			id: doc.id,
			slug: doc.slug,
			docPath: doc.docPath,
			version: doc.headHash,
			url: `https://palapala.me/${doc.slug}/${doc.docPath}`,
			shareUrl: `https://palapala.me/${doc.slug}/${doc.docPath}`,
			fileUrl: `https://palapala.me/${doc.slug}/${doc.docPath}`,
			createdAt: doc.createdAt,
		};
		return new Response(JSON.stringify({ workspace: { id: doc.workspaceId, slug: doc.slug }, document: response }), {
			headers: { "content-type": "application/json" },
		});
	}

	if (readMatch && req.method === "DELETE") {
		const docId = readMatch[2];
		const existing = await env.D1.prepare(
			"SELECT id, slug, doc_path FROM documents WHERE id = ? AND deleted_at IS NULL"
		).bind(docId).first<{ id: string; slug: string; doc_path: string }>();
		if (!existing) {
			return jsonError(404, "Document not found", "ERR_NOT_FOUND");
		}
		const now = nowIso();
		await env.D1.prepare(
			"UPDATE documents SET deleted_at = ?, head_hash = '', updated_at = ? WHERE id = ?"
		).bind(now, now, docId).run();
		return new Response(JSON.stringify({ ok: true, id: docId }), {
			headers: { "content-type": "application/json" },
		});
	}

	if (path === "v1/me") {
		return new Response(JSON.stringify({ user: null, anonymous: true }), {
			headers: { "content-type": "application/json" },
		});
	}

	return jsonError(404, "Not found", "ERR_NOT_FOUND");
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		const path = pathFromUrl(url);
		const slug = path.split("/")[0];

		// Read paths (palapala.me/<slug>/<docPath> or
		// palapala.me/<slug>/<docPath>@<hash>)
		if (req.method === "GET" && slug && SLUG_PATTERN.test(slug) && !isAdminRequest(req, env)) {
			const rest = path.split("/").slice(1);
			const parsed = parsePathComponents(slug, rest);
			if (!parsed) {
				return jsonError(400, "Invalid path", "ERR_PATH");
			}

			const hashMatch = parsed.docPath.match(/^(.+)@([a-f0-9]{64})$/);
			let r2Key: string;
			let cacheControl: string;

			if (hashMatch) {
				const baseDocPath = hashMatch[1];
				const hash = hashMatch[2];
				if (!HASH_PATTERN.test(hash)) {
					return jsonError(400, "Invalid hash", "ERR_HASH");
				}
				r2Key = buildVersionedKey(slug, hash, baseDocPath);
				cacheControl = "public, max-age=31536000, immutable";
			} else {
				const doc = await readDocumentHead(env, slug, parsed.docPath);
				if (!doc) {
					return new Response("Not found", { status: 404 });
				}
				r2Key = buildVersionedKey(slug, doc.headHash, parsed.docPath);
				cacheControl = "public, max-age=60";
			}

			const obj = await env.R2.get(r2Key);
			if (!obj) {
				return new Response("Not found", { status: 404 });
			}

			const headers = new Headers();
			headers.set("content-type", obj.httpMetadata?.contentType ?? "text/html; charset=utf-8");
			headers.set("cache-control", cacheControl);
			headers.set("cache-tag", `ws:${slug}`);
			return new Response(obj.body, { headers });
		}

		if (path.startsWith("v1/")) {
			return await handleAdmin(req, env, path, slug);
		}

		return new Response("Not found", { status: 404 });
	},
};
