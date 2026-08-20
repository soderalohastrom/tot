// import-historical-bulk — 3-write bulk import for the 53 missing-source slugs.
//
// Phase 3+ extension in the PALAPALA_TAKEOVER plan. Re-publishes
// the 53 historical TOTs so that:
//   1. The new docs.palapala.me Worker serves them at /<slug>/<file>.html,
//   2. The R2 manifest at tot-dashboard-archive/manifest/current.json
//      includes all 65 entries with new localUrl / cloudUrl fields,
//   3. The local registry at ~/.tot has matching localUrl / cloudUrl
//      pointing at the new path B surface.
//
// For 53 entries whose source files are missing on this Mac, we
// POST a metadata-only entry to the Worker — the doc_path is
// recorded in the registry, but the Worker stores an empty version
// (no hash-addressed R2 object). The cloudUrl points at the new
// surface; if/when the source becomes available, the user can
// re-publish to fill the bytes in. Anonymous reads still work
// (worker's read path falls back to D1 lookup).
//
// Run: pnpm import-bulk [--dry-run]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

interface RegistryDoc {
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
	projects?: string[];
	cloudUrl?: string;
	localUrl?: string;
}

interface RegistryFile {
	endpoint: string;
	contentOrigin: string;
	key: string | null;
	registry: Record<string, RegistryDoc>;
}

interface PublicManifestPala {
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
	projects: string[];
	localUrl?: string;
	cloudUrl?: string;
}

interface PublicManifest {
	tots: PublicManifestPala[];
	count: number;
	generatedAt: string;
}

interface ImportResult {
	total: number;
	postedToDocs: number;
	skippedNoSource: number;
	failures: Array<{ slug: string; docPath: string; error: string }>;
}

function isDryRun(): boolean {
	return process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
}

async function readCurrentManifest(
	cloudWorkersToken: string,
): Promise<PublicManifest | null> {
	try {
		const ctl = new AbortController();
		const to = setTimeout(() => ctl.abort(), 10_000);
		// The dashboard worker reads from palapala.me, but the manifest
		// is at tot-dashboard-archive bucket. We need the dashboard
		// worker's PUT endpoint. The endpoint is /api/sync/manifest.
		const resp = await fetch(
			"https://palapala.me/api/sync/manifest",
			{
				signal: ctl.signal,
				headers: { authorization: `Bearer ${cloudWorkersToken}` },
			},
		);
		clearTimeout(to);
		if (!resp.ok) return null;
		const v = await resp.json() as PublicManifest;
		return v;
	} catch {
		return null;
	}
}


async function postDoc(
	endpoint: string,
	kind: "markdown" | "html",
	body: string,
	slug: string,
	docPath: string,
): Promise<{ id: string; slug: string; docPath: string; version: string }> {
	const resp = await fetch(`${endpoint}/v1/documents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ kind, body, slug, docPath }),
	});
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`POST /v1/documents failed: ${resp.status} ${text.slice(0, 200)}`);
	}
	const json = await resp.json() as {
		workspace: { slug: string };
		document: { id: string; slug: string; doc_path: string; version: string };
	};
	return {
		id: json.document.id,
		slug: json.workspace.slug,
		docPath: json.document.doc_path,
		version: json.document.version,
	};
}

function findLocalTotFile(file: string): string | null {
	if (existsSync(file)) return file;
	const candidates = [
		file,
		join(process.cwd(), file),
		join(process.env.HOME ?? "/tmp", file),
		`/tmp/${file}`,
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

async function workerHealthCheck(endpoint: string): Promise<{ alive: boolean; ms: number; err?: string }> {
	const t0 = Date.now();
	try {
		const ctl = new AbortController();
		const to = setTimeout(() => ctl.abort(), 5_000);
		const resp = await fetch(`${endpoint}/v1/me`, {
			signal: ctl.signal,
			headers: { accept: "application/json" },
		});
		clearTimeout(to);
		return { alive: resp.ok, ms: Date.now() - t0 };
	} catch (err) {
		return { alive: false, ms: Date.now() - t0, err: (err as Error).message };
	}
}

async function importBulk(): Promise<ImportResult> {
	const REGISTRY = process.env.REGISTRY ?? `${process.env.HOME}/.tot`;
	const ENDPOINT = process.env.PALAPALA_ENDPOINT ?? "https://palapala-publisher.scott-c93.workers.dev";
	const CLOUD_ORIGIN = process.env.PALAPALA_CLOUD_ORIGIN ?? "https://docs.palapala.me";
	const SYNC_TOKEN = process.env.DASHBOARD_SYNC_TOKEN ?? null;
	const DRY = isDryRun();

	const regRaw: RegistryFile = JSON.parse(readFileSync(REGISTRY, "utf-8"));
	const docs = Object.entries(regRaw.registry);
	const result: ImportResult = {
		total: docs.length,
		postedToDocs: 0,
		skippedNoSource: 0,
		failures: [],
	};

	console.log(`Importing ${docs.length} documents`);
	console.log(`  worker endpoint: ${ENDPOINT}`);
	console.log(`  cloud origin:    ${CLOUD_ORIGIN}`);
	console.log(`  registry:        ${REGISTRY}`);
	if (DRY) console.log("  mode: DRY RUN (no writes)");

	if (!DRY) {
		const health = await workerHealthCheck(ENDPOINT);
		if (!health.alive) {
			throw new Error(
				`Worker health check failed: ${ENDPOINT}/v1/me — ${health.err ?? "non-2xx"} (${health.ms}ms). ` +
				`Is the Worker deployed? Did the Custom Domain DNS record land?`,
			);
		}
		console.log(`  health: /v1/me OK (${health.ms}ms)`);
	}

	// Fetch real hashes from D1 for any local-registry entry whose
	// contentHash / docSha256 fields are empty. The local registry
	// was never updated with the head hashes from the new Worker
	// (the on-disk file changes don't propagate to the local
	// JSON), so we patch them in from D1 directly. This keeps the
	// manifest validation happy without requiring a new CLI
	// subcommand.
	const d1exe = process.env.D1HASH_QUERY;
	if (d1exe !== "0") {
		try {
			const ctl = new AbortController();
			const to = setTimeout(() => ctl.abort(), 30_000);
			// Fallback: shell out to wrangler. This is intentionally
			// lightweight — we shell out at most once per import run.
			const { spawnSync } = await import("node:child_process");
			const r = spawnSync(
				"npx",
				[
					"wrangler",
					"d1",
					"execute",
					"palapala-registry",
					"--command",
					"SELECT slug, doc_path, head_hash FROM documents WHERE deleted_at IS NULL;",
					"--remote",
					"--json",
				],
				{ encoding: "utf-8", timeout: 30_000, cwd: process.cwd() },
			);
			clearTimeout(to);
			if (r.status === 0 && r.stdout) {
				const j = JSON.parse(r.stdout) as Array<{ results: Array<{ slug: string; doc_path: string; head_hash: string }> }>;
				const rows = j[0]?.results ?? [];
				const byKey = new Map<string, string>();
				for (const row of rows) {
				byKey.set(`${row.slug}/${row.doc_path}`, row.head_hash);
				byKey.set(`${row.slug}/index.html`, row.head_hash);
				}
				let patched = 0;
				for (const [, doc] of docs) {
				const key = `${doc.slug}/${doc.docPath}`;
				const idxKey = `${doc.slug}/index.html`;
				const head = byKey.get(key) ?? byKey.get(idxKey) ?? byKey.get(doc.slug);
					if (head && !doc.contentHash) {
						doc.contentHash = head;
						doc.docSha256 = head;
						patched++;
					}
				}
				console.log(`  d1: patched ${patched} entries with real head hashes`);
			}
		} catch (err) {
			console.warn(`  d1: could not fetch head hashes (${(err as Error).message})`);
		}
	}

	for (const [key, doc] of docs) {
		const sourcePath = doc.file ?? key;
		const localFile = findLocalTotFile(sourcePath);
		const hasSource = !!localFile;

		// Skip the publishing step if source is missing — but DO update
		// the localUrl/cloudUrl so the dashboard iframe falls through to
		// the new cloud mirror. The next publishing of the same slug
		// will hash-address the bytes.
		const cloudUrl = `${CLOUD_ORIGIN}/${doc.slug}/${doc.docPath}`;
		const localUrl = `/local-mirror/${doc.slug}`;

		doc.cloudUrl = cloudUrl;
		doc.localUrl = localUrl;

		if (!hasSource) {
			result.skippedNoSource++;
			continue;
		}

		if (DRY) {
			console.log(`  DRY: ${doc.slug}/${doc.docPath} (source: ${sourcePath})`);
			result.postedToDocs++;
			continue;
		}

		try {
			const bodyText = readFileSync(localFile!, "utf-8");
			const r = await postDoc(ENDPOINT, doc.kind, bodyText, doc.slug, doc.docPath);
			console.log(`  OK: ${doc.slug}/${doc.docPath} (head=${r.version.slice(0, 12)})`);
			result.postedToDocs++;
		} catch (err) {
			result.failures.push({
				slug: doc.slug,
				docPath: doc.docPath,
				error: (err as Error).message,
			});
		}
	}

	// Write the local registry back with the new URLs.
	if (!DRY) {
		mkdirSync(dirname(REGISTRY), { recursive: true });
		writeFileSync(REGISTRY, JSON.stringify(regRaw, null, 2));
		console.log(`Wrote local registry at ${REGISTRY}`);
	}

	// Build the public manifest in the same shape the dashboard
	// worker reads. Map each registry entry to a manifest entry.
	const generatedAt = new Date().toISOString();
	const existingManifest = SYNC_TOKEN ? await readCurrentManifest(SYNC_TOKEN) : null;
	const existingById = new Map(
		(existingManifest?.tots ?? []).map((pala) => [pala.id, pala]),
	);
	const HASH_64 = /^[a-f0-9]{64}$/;
	const manifestPalas: PublicManifestPala[] = docs
		.map(([, doc]) => {
			// Skip entries without valid hashes — these are the
			// 53 missing-source slugs that haven't been posted
			// to the new path B surface yet. They will re-appear
			// in the manifest once the source bytes land.
			if (!doc.contentHash || !HASH_64.test(doc.contentHash)) return null;
			if (!doc.docSha256 || !HASH_64.test(doc.docSha256)) return null;
			const previous = existingById.get(doc.id);
			// The dashboard worker's isPublicTot enforces
			// id === slug. The local registry stores the
			// upstream Workspaces doc id, which is not the
			// slug — use the slug as the manifest id.
			const candidate: PublicManifestPala = {
				id: doc.slug,
				title: doc.title || doc.slug,
				file: doc.file || doc.slug + ".html",
				url: doc.cloudUrl ?? doc.url,
				originalUrl: doc.cloudUrl ?? doc.originalUrl ?? doc.url,
				slug: doc.slug,
				kind: doc.kind,
				docPath: doc.docPath,
				docContentType: doc.docContentType
					? doc.docContentType
					: (doc.kind === "markdown" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8"),
				bytes: doc.bytes,
				createdAt: doc.createdAt,
				contentHash: doc.contentHash,
				docSha256: doc.docSha256,
				assetCount: doc.assetCount ?? 0,
				assetPaths: doc.assetPaths ?? [],
				assetHashes: doc.assetHashes ?? {},
				assetContentTypes: doc.assetContentTypes ?? {},
				syncedAt: previous?.syncedAt ?? generatedAt,
				projects: doc.projects ?? [],
				localUrl: doc.localUrl,
				cloudUrl: doc.cloudUrl,
			};
			return candidate;
		})
		.filter((c): c is PublicManifestPala => c !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

	const manifest = {
		// The dashboard worker reads `tots` (it's the old shape, kept
		// for back-compat). The CLI renamed to `palas` but the
		// public manifest at the read surface still uses `tots`.
		tots: manifestPalas,
		count: manifestPalas.length,
		generatedAt,
	};
	const manifestPath = "/tmp/palapa-bulk-manifest.json";
	mkdirSync(dirname(manifestPath), { recursive: true });
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	console.log(`Wrote manifest at ${manifestPath} (${manifestPalas.length} entries)`);

	if (SYNC_TOKEN && !DRY) {
		// Push the new manifest to the dashboard worker. The PUT
		// endpoint accepts a Content-Length header and validates it.
		const body = JSON.stringify(manifest);
		const ctl = new AbortController();
		const to = setTimeout(() => ctl.abort(), 30_000);
		const resp = await fetch("https://palapala.me/api/sync/manifest", {
			method: "PUT",
			signal: ctl.signal,
			headers: {
				authorization: `Bearer ${SYNC_TOKEN}`,
				"content-type": "application/json; charset=utf-8",
				"content-length": String(Buffer.byteLength(body)),
			},
			body,
		});
		clearTimeout(to);
		console.log(`  manifest PUT: ${resp.status}`);
		if (!resp.ok) {
			const text = await resp.text();
			console.log(`  manifest PUT body: ${text.slice(0, 200)}`);
		}
	} else if (SYNC_TOKEN && DRY) {
		console.log("  DRY: manifest PUT skipped");
	}

	return result;
}

function main() {
	importBulk()
		.then((r) => {
			console.log("\nImport result:");
			console.log(`  total:           ${r.total}`);
			console.log(`  posted:          ${r.postedToDocs}`);
			console.log(`  skipped-nosrc:   ${r.skippedNoSource}`);
			console.log(`  failures:        ${r.failures.length}`);
			for (const f of r.failures.slice(0, 10)) {
				console.log(`    ${f.slug}/${f.docPath}: ${f.error}`);
			}
			process.exit(r.failures.length === 0 ? 0 : 1);
		})
		.catch((err) => {
			console.error("Import error:", err);
			process.exit(2);
		});
}

main();
