// palapala-migrate — re-publish the 65 existing slugs from the
// local mirror to the new palapala-publisher Worker.
//
// Phase 3 in the PALAPALA_TAKEOVER plan. The local mirror is
// authoritative; the upstream tot.page edge is not the source of
// truth. Each TOT in `~/.tot` is fetched from disk, hashed,
// uploaded to the new Worker, and the registry at
// docs.palapala.me/<slug>/<file>.html is updated.
//
// This is a one-shot migration tool, not a daemon. Run it after
// the Worker `palapala-publisher` is deployed AND the Custom
// Domain `docs.palapala.me` is provisioned in Cloudflare
// (Workers & Pages → palapala-publisher → Settings → Domains
// & Routes → Add Custom Domain). The Custom Domain auto-
// creates the DNS record; no manual DNS staging required.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

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
	projects?: string[];
}

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

function sha256Hex(input: string | Buffer): string {
	const h = createHash("sha256").update(input).digest("hex");
	return h;
}

function readRegistry(path: string): RegistryFile {
	if (!existsSync(path)) {
		throw new Error(`Registry not found: ${path}`);
	}
	const text = readFileSync(path, "utf-8");
	return JSON.parse(text);
}

function writeRegistry(path: string, reg: RegistryFile): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(reg, null, 2));
}

async function publishOne(
	endpoint: string,
	key: string | null,
	doc: PublicTot,
	bodyText: string
): Promise<{ slug: string; docPath: string; headHash: string; newSlug?: string }> {
	const newSlug = doc.slug;
	const postBody = JSON.stringify({
		kind: doc.kind,
		body: bodyText,
		slug: newSlug,
	});

	const resp = await fetch(`${endpoint}/v1/documents`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(key ? { "X-Api-Key": key } : {}),
		},
		body: postBody,
	});
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`POST /v1/documents failed: ${resp.status} ${text.slice(0, 200)}`);
	}
	const json = await resp.json() as {
		workspace: { slug: string };
		document: { id: string; slug: string; docPath: string; version: string };
	};
	return {
		slug: json.workspace.slug,
		docPath: json.document.docPath,
		headHash: json.document.version,
		newSlug: json.document.slug === doc.slug ? undefined : json.document.slug,
	};
}

function findLocalTotFile(file: string): string | null {
	if (existsSync(file)) return file;
	// If file is a relative or absolute path, try common locations
	const candidates = [
		file,
		join(process.cwd(), file),
		join(process.env.HOME ?? "/tmp", file),
		`/tmp/${file}`,
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function isDryRun(): boolean {
	return process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
}

function isAutoSkipMissing(): boolean {
	// Default-on: the source files for older TOTs often live
	// on machines we no longer have (cleaned /tmp, retired
	// worktrees). The slug is durable identity; the source is
	// not. Don't fail the whole migration over missing
	// source — just report which ones are skipped and let
	// the user re-publish from a fresh source if needed.
	// Override with --no-skip-missing to require all present.
	if (process.argv.includes("--no-skip-missing")) return false;
	return process.env.SKIP_MISSING !== "0";
}

async function workerHealthCheck(endpoint: string): Promise<{ alive: boolean; ms: number; err?: string }> {
	const t0 = Date.now();
	try {
		// /v1/me is the auth-stub endpoint, a clean liveness signal
		// without requiring any auth or write path.
		const ctl = new AbortController();
		const to = setTimeout(() => ctl.abort(), 5000);
		const resp = await fetch(`${endpoint}/v1/me`, {
			signal: ctl.signal,
			headers: { "accept": "application/json" },
		});
		clearTimeout(to);
		return { alive: resp.ok, ms: Date.now() - t0 };
	} catch (err) {
		return { alive: false, ms: Date.now() - t0, err: (err as Error).message };
	}
}

async function liveReadCheck(endpoint: string, slug: string, docPath: string): Promise<{ status: number; ms: number; bytes: number }> {
	const t0 = Date.now();
	const ctl = new AbortController();
	const to = setTimeout(() => ctl.abort(), 5000);
	const resp = await fetch(`${endpoint}/${slug}/${docPath}`, { signal: ctl.signal });
	clearTimeout(to);
	const text = await resp.text();
	return { status: resp.status, ms: Date.now() - t0, bytes: text.length };
}

// A Custom Domain that just provisioned has a cert gap — HTTPS
// can return 525/526 for a few seconds to a few minutes while
// Cloudflare provisions the edge cert. Live-read smoke test
// retries 5xx with a short backoff before declaring a failure,
// so the migration run isn't poisoned by the cert gap.
async function liveReadRetry(endpoint: string, slug: string, docPath: string, attempts = 4, delayMs = 2500): Promise<{ status: number; ms: number; bytes: number; retried: boolean }> {
	for (let i = 0; i < attempts; i++) {
		const r = await liveReadCheck(endpoint, slug, docPath);
		if (r.status >= 200 && r.status < 400) {
			return { ...r, retried: i > 0 };
		}
		if (r.status < 500 || i === attempts - 1) {
			return { ...r, retried: i > 0 };
		}
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	return { ...(await liveReadCheck(endpoint, slug, docPath)), retried: true };
}

interface MigrationResult {
	total: number;
	migrated: number;
	slugsRenamed: number;
	bytesUploaded: number;
	failures: Array<{ slug: string; docPath: string; error: string }>;
}

async function migrate(): Promise<MigrationResult> {
	const REGISTRY = process.env.REGISTRY ?? `${process.env.HOME}/.tot`;
	const ENDPOINT = process.env.PALAPALA_ENDPOINT ?? "https://palapala-publisher.scott-c93.workers.dev";
	const KEY = process.env.PALAPALA_KEY ?? null;
	const DRY = isDryRun();

	const reg = readRegistry(REGISTRY);
	const docs = Object.entries(reg.registry);
	const result: MigrationResult = {
		total: docs.length,
		migrated: 0,
		slugsRenamed: 0,
		bytesUploaded: 0,
		failures: [],
	};

	console.log(`Migrating ${docs.length} documents`);
	console.log(`  endpoint: ${ENDPOINT}`);
	console.log(`  registry: ${REGISTRY}`);
	if (DRY) console.log("  mode: DRY RUN (no writes)");

	// Health check first — if the Worker isn't responding to /v1/me,
	// the migration will just fail every doc. Fail fast.
	if (!DRY) {
		const health = await workerHealthCheck(ENDPOINT);
		if (!health.alive) {
			throw new Error(
				`Worker health check failed: ${ENDPOINT}/v1/me — ${health.err ?? "non-2xx"} (${health.ms}ms). ` +
				`Is the Worker deployed? Did the Custom Domain DNS record land? ` +
				`Check: curl ${ENDPOINT}/v1/me`,
			);
		}
		console.log(`  health: /v1/me OK (${health.ms}ms)`);
	}

	for (const [key, doc] of docs) {
		// The registry's `key` is the canonical source path; fall
		// back to `doc.file` for older entries that did record it.
		const sourcePath = doc.file ?? key;
		const localFile = findLocalTotFile(sourcePath);
		if (!localFile) {
			if (isAutoSkipMissing()) {
				result.failures.push({
					slug: doc.slug,
					docPath: doc.docPath,
					error: `skipped (no local source): ${sourcePath}`,
				});
				continue;
			}
			result.failures.push({
				slug: doc.slug,
				docPath: doc.docPath,
				error: `local file not found: ${sourcePath}`,
			});
			continue;
		}
		const bodyText = readFileSync(localFile, "utf-8");
		const bytes = Buffer.byteLength(bodyText, "utf-8");
		const sha = sha256Hex(bodyText);
		if (sha !== doc.contentHash && sha !== doc.docSha256) {
			result.failures.push({
				slug: doc.slug,
				docPath: doc.docPath,
				error: `hash mismatch: disk=${sha.slice(0, 12)} manifest=${(doc.docSha256 ?? doc.contentHash ?? "").slice(0, 12)}`,
			});
			continue;
		}
		if (DRY) {
			console.log(`  DRY: ${doc.slug}/${doc.docPath} (${bytes} bytes, sha=${sha.slice(0, 12)})`);
			result.migrated++;
			continue;
		}
		try {
			const r = await publishOne(ENDPOINT, KEY, doc as PublicTot, bodyText);
			console.log(`  OK: ${doc.slug}/${doc.docPath} → ${r.slug}/${r.docPath} (head=${r.headHash.slice(0, 12)})`);
			if (r.newSlug && r.newSlug !== doc.slug) {
				result.slugsRenamed++;
				console.log(`    (slug renamed: ${doc.slug} → ${r.newSlug})`);
			}
			// Update the registry with the new cloudUrl
			doc.cloudUrl = `https://palapala.me/${r.slug}/${r.docPath}`;
			doc.localUrl = `/local-mirror/${r.slug}`;
			result.migrated++;
			result.bytesUploaded += bytes;
		} catch (err) {
			result.failures.push({
				slug: doc.slug,
				docPath: doc.docPath,
				error: (err as Error).message,
			});
		}
	}

	if (!DRY) {
		writeRegistry(REGISTRY, reg);
		console.log(`Updated registry at ${REGISTRY}`);

		// Smoke test: read a few migrated slugs via the public read
		// path to confirm the live Worker serves them. This catches
		// R2 wiring, the slug-pattern logic, and the D1→R2 join.
		const sample = docs
			.slice(0, 3)
			.map(([, d]) => ({ slug: d.slug, docPath: d.docPath }));
		if (sample.length > 0) {
			console.log(`\nSmoke test: reading ${sample.length} migrated slugs via ${ENDPOINT}:`);
			for (const s of sample) {
				const r = await liveReadRetry(ENDPOINT, s.slug, s.docPath);
				const tag = r.status === 200 ? "OK" : r.status;
				console.log(`  ${tag}  ${s.slug}/${s.docPath}  (${r.ms}ms, ${r.bytes} bytes${r.retried ? ", retried" : ""})`);
			}
		}
	}

	return result;
}

function main() {
	migrate()
		.then((r) => {
			console.log("\nMigration result:");
			console.log(`  total:        ${r.total}`);
			console.log(`  migrated:    ${r.migrated}`);
			console.log(`  renames:      ${r.slugsRenamed}`);
			console.log(`  bytes:        ${r.bytesUploaded}`);
			console.log(`  failures:     ${r.failures.length}`);
			for (const f of r.failures.slice(0, 10)) {
				console.log(`    ${f.slug}/${f.docPath}: ${f.error}`);
			}
			process.exit(r.failures.length === 0 ? 0 : 1);
		})
		.catch((err) => {
			console.error("Migration error:", err);
			process.exit(2);
		});
}

main();
