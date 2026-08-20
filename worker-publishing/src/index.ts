// palapala-publisher — the publishing Worker
//
// Path B replacement for the upstream @plannotator/tot edge.
// Lives at the Worker name `palapala-publisher`; the dashboard
// Worker (`tot-dashboard`) is a separate, kept Worker for clearer
// audit trail.
//
// Anonymous-by-link is the access model: link-is-the-key, anyone
// with the URL can view/update/delete — same as the current
// upstream model. The CLI uses /v1/documents and /v1/workspaces;
// the read surface is /<slug>/<path> on the content origin
// (docs.palapala.me).
//
// WIRE CONTRACT: this Worker speaks the upstream /v1 contract that
// src/http.ts was written against — snake_case entities, the exact
// response wrapping the CLI reads, raw-body PUT, 204 DELETE. Keep
// the shapes byte-faithful; the CLI's stubbed tests assert them.
//
// Simplifications vs upstream (deliberate, from docs/PALAPALA_TAKEOVER.md):
// - workspace id == slug. The CLI treats wsId as an opaque string, so
//   the minted slug doubles as the workspace id. That lets asset and
//   document writes route by path with no workspaces table.
// - assets live at R2 assets/<slug>/<assetPath> and are served as
//   living pointers (overwrite-in-place). Frozen @hash pages share
//   living assets — a frozen page pins only the document bytes.
// - versioning is synchronous: the write returns with the new head
//   hash, so the CLI's publish poll succeeds on the first check.

const CONTENT_ORIGIN = "https://docs.palapala.me";

const MAX_OBJECT_BYTES = 10 * 1024 * 1024; // 10 MB per the upstream contract
const MAX_BODY_BYTES = 1_500_000; // 1.5 MB for the bare publish
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SLUG_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const DOC_PATH_PATTERN = /^[A-Za-z0-9._~!$&'()+,;=:@%/-]+$/;

const R2_KEY_TEMPLATE = (slug: string, hash: string, docPath: string) =>
	`pages/${slug}/${hash}/${docPath}`;

const R2_ASSET_KEY_TEMPLATE = (slug: string, assetPath: string) => `assets/${slug}/${assetPath}`;

// D1 schema, declarative. Bootstrap with:
//   wrangler d1 execute palapala-registry --remote --command "
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

interface Env {
	R2: R2Bucket;
	D1: D1Database;
	WORKER_NAME: string;
	WORKER_VERSION: string;
}

// D1 returns rows with snake_case column names; the
// Document interface matches that directly so .first<Document>()
// works without an ad-hoc mapper. DocumentEntity is the public
// API contract (also snake_case — the upstream wire format).
interface Document {
	id: string;
	workspace_id: string;
	slug: string;
	doc_path: string;
	kind: "markdown" | "html";
	head_hash: string;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
}

// The upstream wire entity the CLI consumes (src/http.ts DocumentEntity).
interface DocumentEntity {
	id: string;
	workspace_id: string;
	slug: string;
	share_url: string;
	doc_path: string;
	kind: "markdown" | "html";
	title: string | null;
	version: string | null;
	created_at: string;
	updated_at: string;
	file_url: string | null;
}

// The upstream wire entity for workspaces (src/http.ts WorkspaceEntity).
interface WorkspaceEntity {
	id: string;
	slug: string;
	share_url: string;
	visibility: string;
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
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 22);
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

// URL shapes mirror src/commands.ts livingUrl/frozenUrl exactly:
// index.html resolves to the bare slug; frozen URLs always carry docPath.
function livingUrlFor(slug: string, docPath: string): string {
	if (docPath === "index.md" || docPath === "index.html") {
		return `${CONTENT_ORIGIN}/${slug}`;
	}
	return `${CONTENT_ORIGIN}/${slug}/${docPath}`;
}

function frozenUrlFor(slug: string, docPath: string, hash: string): string {
	return `${CONTENT_ORIGIN}/${slug}/${docPath}@${hash}`;
}

// Stable per (slug, docPath) — never derived from content, so two slugs
// publishing identical bytes don't collide on the primary key.
async function docIdFor(slug: string, docPath: string): Promise<string> {
	const digest = await sha256Hex(`${slug}\n${docPath}`);
	return `doc_${digest.slice(0, 12)}`;
}

function toEntity(doc: Document): DocumentEntity {
	return {
		id: doc.id,
		workspace_id: doc.workspace_id,
		slug: doc.slug,
		share_url: livingUrlFor(doc.slug, doc.doc_path),
		doc_path: doc.doc_path,
		kind: doc.kind,
		title: null,
		version: doc.head_hash,
		created_at: doc.created_at,
		updated_at: doc.updated_at,
		file_url: frozenUrlFor(doc.slug, doc.doc_path, doc.head_hash),
	};
}

function workspaceEntity(slug: string): WorkspaceEntity {
	return {
		id: slug, // workspace id == slug (see header)
		slug,
		share_url: livingUrlFor(slug, "index.html"),
		visibility: "public",
	};
}

async function readDocumentHead(env: Env, slug: string, docPath: string): Promise<Document | null> {
	const row = await env.D1.prepare(
		"SELECT id, workspace_id, slug, doc_path, kind, head_hash, created_at, updated_at, deleted_at FROM documents WHERE slug = ? AND doc_path = ? AND deleted_at IS NULL",
	)
		.bind(slug, docPath)
		.first<Document>();
	if (!row) return null;
	return row;
}

async function readDocumentById(env: Env, docId: string): Promise<Document | null> {
	const row = await env.D1.prepare(
		"SELECT id, workspace_id, slug, doc_path, kind, head_hash, created_at, updated_at, deleted_at FROM documents WHERE id = ? AND deleted_at IS NULL",
	)
		.bind(docId)
		.first<Document>();
	if (!row) return null;
	return row;
}

async function writeDocumentHead(env: Env, doc: Document): Promise<void> {
	await env.D1.prepare(
		"INSERT OR REPLACE INTO documents (id, workspace_id, slug, doc_path, kind, head_hash, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			doc.id,
			doc.workspace_id,
			doc.slug,
			doc.doc_path,
			doc.kind,
			doc.head_hash,
			doc.created_at,
			doc.updated_at,
			doc.deleted_at,
		)
		.run();
}

async function finalizeObject(
	env: Env,
	hash: string,
	body: string,
	contentType: string,
	slug: string,
	docPath: string,
): Promise<void> {
	const buf = new TextEncoder().encode(body);
	const versionedKey = buildVersionedKey(slug, hash, docPath);
	await env.R2.put(versionedKey, buf, {
		httpMetadata: { contentType },
	});
}

async function uploadAsset(
	env: Env,
	slug: string,
	assetPath: string,
	body: ArrayBuffer,
	contentType: string,
): Promise<{ hash: string; path: string }> {
	const bytes = new Uint8Array(body);
	const hash = await sha256Hex(bytes);
	const key = R2_ASSET_KEY_TEMPLATE(slug, assetPath);
	const existing = await env.R2.get(key);
	// Living pointer: overwrite-in-place, but skip the write when bytes are
	// unchanged so re-publishes stay cheap.
	if (!existing || (await sha256Hex(await existing.arrayBuffer())) !== hash) {
		await env.R2.put(key, bytes, { httpMetadata: { contentType } });
	}
	return { hash, path: assetPath };
}

// Hard delete: mark the D1 row deleted and drop every R2 object the slug
// owns (all document versions + all living assets).
async function purgeSlugObjects(env: Env, slug: string): Promise<void> {
	for (const prefix of [`pages/${slug}/`, `assets/${slug}/`]) {
		let cursor: string | undefined;
		do {
			const page: R2Objects = await env.R2.list({ prefix, cursor });
			if (page.objects.length > 0) {
				await env.R2.delete(page.objects.map((o) => o.key));
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor !== undefined);
	}
}

function pathFromUrl(url: URL): string {
	const pathname = url.pathname;
	if (pathname.startsWith("/")) return pathname.slice(1);
	return pathname;
}

function parsePathComponents(_slug: string, rest: string[]): { docPath: string } | null {
	if (rest.length === 0) {
		return { docPath: "index.html" };
	}
	const docPath = rest.join("/");
	if (!DOC_PATH_PATTERN.test(docPath)) {
		return null;
	}
	return { docPath };
}

function isAdminRequest(req: Request): boolean {
	return req.url.includes("/v1/");
}

// Shared write path for the two create routes. Idempotent per
// (slug, docPath): re-posting moves the head, keeps the id + created_at.
async function commitDocument(
	env: Env,
	slug: string,
	docPath: string,
	kind: "markdown" | "html",
	bodyText: string,
): Promise<Document> {
	const contentType = await docContentType(kind);
	const hash = await docHash(bodyText);
	const now = nowIso();
	const existing = await readDocumentHead(env, slug, docPath);
	const doc: Document = {
		id: existing?.id ?? (await docIdFor(slug, docPath)),
		workspace_id: existing?.workspace_id ?? slug,
		slug,
		doc_path: docPath,
		kind,
		head_hash: hash,
		created_at: existing?.created_at ?? now,
		updated_at: now,
		deleted_at: null,
	};
	await finalizeObject(env, hash, bodyText, contentType, slug, docPath);
	await writeDocumentHead(env, doc);
	return doc;
}

async function handleAdmin(req: Request, env: Env, path: string, _slug: string): Promise<Response> {
	if (path === "v1/documents" && req.method === "POST") {
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

		const slug: string = parsed.slug ?? slugify();
		if (!SLUG_PATTERN.test(slug)) {
			return jsonError(400, "Invalid slug", "ERR_SLUG");
		}
		const docPath: string = parsed.docPath ?? "index.html";
		if (!DOC_PATH_PATTERN.test(docPath)) {
			return jsonError(400, "Invalid docPath", "ERR_PATH");
		}

		const doc = await commitDocument(env, slug, docPath, parsed.kind, parsed.body);
		return new Response(
			JSON.stringify({ workspace: workspaceEntity(slug), document: toEntity(doc) }),
			{
				headers: { "content-type": "application/json" },
			},
		);
	}

	if (path === "v1/workspaces" && req.method === "POST") {
		// The CLI sends an empty body here — the workspace is just an early
		// slug mint (for og:image baking). Stateless: nothing persists until
		// a document lands under the slug.
		const slug = slugify();
		return new Response(JSON.stringify({ workspace: workspaceEntity(slug) }), {
			headers: { "content-type": "application/json" },
		});
	}

	const assetMatch = path.match(/^v1\/workspaces\/([^/]+)\/assets\/(.+)$/);
	if (assetMatch && req.method === "PUT") {
		const slug = decodeURIComponent(assetMatch[1]);
		const assetPath = assetMatch[2];
		if (!SLUG_PATTERN.test(slug)) {
			return jsonError(400, "Invalid workspace", "ERR_SLUG");
		}
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
		const result = await uploadAsset(env, slug, assetPath, ab, contentType);
		return new Response(JSON.stringify(result), {
			headers: { "content-type": "application/json" },
		});
	}

	const docMatch = path.match(/^v1\/workspaces\/([^/]+)\/documents$/);
	if (docMatch && req.method === "POST") {
		// The path workspace IS the slug (workspace id == slug): the CLI minted
		// it via POST /v1/workspaces and expects the document to land under it.
		const slug = decodeURIComponent(docMatch[1]);
		if (!SLUG_PATTERN.test(slug)) {
			return jsonError(400, "Invalid workspace", "ERR_SLUG");
		}
		let body: string;
		try {
			body = await readBodyWithLimit(req, MAX_BODY_BYTES);
		} catch {
			return jsonError(413, "Body too large", "ERR_BODY_TOO_LARGE");
		}
		// Upstream sends doc_path (snake); docPath (camel) kept for our
		// operator scripts written against the pre-compat Worker.
		let parsed: {
			kind?: "markdown" | "html";
			body?: string;
			doc_path?: string;
			docPath?: string;
		};
		try {
			parsed = JSON.parse(body);
		} catch {
			return jsonError(400, "Invalid JSON", "ERR_JSON");
		}
		if (parsed.kind !== "markdown" && parsed.kind !== "html") {
			return jsonError(400, "Invalid kind", "ERR_KIND");
		}
		if (!parsed.body || parsed.body.length === 0) {
			return jsonError(400, "Missing body", "ERR_MISSING");
		}
		const docPath: string = parsed.doc_path ?? parsed.docPath ?? "index.html";
		if (!DOC_PATH_PATTERN.test(docPath)) {
			return jsonError(400, "Invalid docPath", "ERR_PATH");
		}

		const doc = await commitDocument(env, slug, docPath, parsed.kind, parsed.body);
		// The CLI reads the bare document entity (res.json.id), not a wrapper.
		return new Response(JSON.stringify(toEntity(doc)), {
			headers: { "content-type": "application/json" },
		});
	}

	const readMatch = path.match(/^v1\/workspaces\/([^/]+)\/documents\/([^/]+)$/);
	if (readMatch && req.method === "GET") {
		const docId = decodeURIComponent(readMatch[2]);
		const row = await readDocumentById(env, docId);
		if (!row) {
			return jsonError(404, "Document not found", "ERR_NOT_FOUND");
		}
		return new Response(JSON.stringify(toEntity(row)), {
			headers: { "content-type": "application/json" },
		});
	}

	if (readMatch && req.method === "PUT") {
		// Upstream contract: raw body bytes, kind from content-type.
		const docId = decodeURIComponent(readMatch[2]);
		let body: string;
		try {
			body = await readBodyWithLimit(req, MAX_BODY_BYTES);
		} catch {
			return jsonError(413, "Body too large", "ERR_BODY_TOO_LARGE");
		}
		const existing = await readDocumentById(env, docId);
		if (!existing) {
			return jsonError(404, "Document not found", "ERR_NOT_FOUND");
		}
		if (body.length === 0) {
			return jsonError(400, "Empty body", "ERR_EMPTY");
		}
		const contentTypeHeader = req.headers.get("content-type") ?? "";
		const kind: "markdown" | "html" = /markdown/i.test(contentTypeHeader) ? "markdown" : "html";

		const doc = await commitDocument(env, existing.slug, existing.doc_path, kind, body);
		// commitDocument mints via (slug, docPath) — preserve the original id
		// the CLI holds, whichever form it takes.
		if (doc.id !== existing.id) {
			doc.id = existing.id;
			doc.workspace_id = existing.workspace_id;
			doc.created_at = existing.created_at;
			await writeDocumentHead(env, doc);
		}
		return new Response(JSON.stringify(toEntity(doc)), {
			headers: { "content-type": "application/json" },
		});
	}

	if (readMatch && req.method === "DELETE") {
		const docId = decodeURIComponent(readMatch[2]);
		const existing = await readDocumentById(env, docId);
		if (!existing) {
			// Upstream idempotency: deleting a gone document is success.
			return new Response(null, { status: 204 });
		}
		const now = nowIso();
		await env.D1.prepare(
			"UPDATE documents SET deleted_at = ?, head_hash = '', updated_at = ? WHERE id = ?",
		)
			.bind(now, now, existing.id)
			.run();
		await purgeSlugObjects(env, existing.slug);
		return new Response(null, { status: 204 });
	}

	if (path === "v1/me") {
		// Stub per decision: anonymous-only, no real auth.
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

		// Read paths (docs.palapala.me/<slug>/<docPath> or
		// docs.palapala.me/<slug>/<docPath>@<hash>)
		if (req.method === "GET" && slug && SLUG_PATTERN.test(slug) && !isAdminRequest(req)) {
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
				if (doc) {
					r2Key = buildVersionedKey(slug, doc.head_hash, parsed.docPath);
					cacheControl = "public, max-age=60";
				} else {
					// Document miss → asset fallthrough. Pages reference support
					// files (images, css, js) at living paths beside the document.
					const asset = await env.R2.get(R2_ASSET_KEY_TEMPLATE(slug, parsed.docPath));
					if (!asset) {
						return new Response("Not found", { status: 404 });
					}
					const assetHeaders = new Headers();
					assetHeaders.set(
						"content-type",
						asset.httpMetadata?.contentType ?? "application/octet-stream",
					);
					assetHeaders.set("cache-control", "public, max-age=60");
					assetHeaders.set("cache-tag", `ws:${slug}`);
					return new Response(asset.body, { headers: assetHeaders });
				}
			}

			const obj = await env.R2.get(r2Key);
			if (!obj) {
				return new Response("Not found", { status: 404 });
			}

			const headers = new Headers();
			headers.set(
				"content-type",
				obj.httpMetadata?.contentType ?? "text/html; charset=utf-8",
			);
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
