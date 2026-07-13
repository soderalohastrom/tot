import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { handleRequest } from "../worker/index.js";

interface StoredObject {
	bytes: Uint8Array;
	customMetadata?: Record<string, string>;
	contentType?: string;
}

class MemoryR2 {
	readonly objects = new Map<string, StoredObject>();

	async head(key: string): Promise<unknown> {
		const object = this.objects.get(key);
		return object
			? {
					etag: `etag-${key}`,
					customMetadata: object.customMetadata,
					size: object.bytes.length,
				}
			: null;
	}

	async get(key: string): Promise<unknown> {
		const object = this.objects.get(key);
		if (!object) return null;
		return {
			body: new Response(Buffer.from(object.bytes)).body,
			httpEtag: `etag-${key}`,
			writeHttpMetadata(headers: Headers) {
				if (object.contentType) headers.set("content-type", object.contentType);
			},
		};
	}

	async put(
		key: string,
		value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
		options?: R2PutOptions,
	): Promise<unknown> {
		if (options?.onlyIf && "etagDoesNotMatch" in options.onlyIf && this.objects.has(key)) {
			return null;
		}
		let bytes: Uint8Array;
		if (typeof value === "string") {
			bytes = new TextEncoder().encode(value);
		} else if (value instanceof ReadableStream) {
			const chunks: Uint8Array[] = [];
			const reader = value.getReader();
			for (;;) {
				// oxlint-disable-next-line no-await-in-loop -- streams are consumed sequentially.
				const result = await reader.read();
				if (result.done) break;
				chunks.push(result.value);
			}
			const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
			bytes = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
		} else if (ArrayBuffer.isView(value)) {
			bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		} else {
			bytes = new Uint8Array(value);
		}
		this.objects.set(key, {
			bytes,
			customMetadata: options?.customMetadata,
			contentType:
				options?.httpMetadata instanceof Headers
					? (options.httpMetadata.get("content-type") ?? undefined)
					: options?.httpMetadata?.contentType,
		});
		return { etag: `etag-${key}` };
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
	}
}

function environment(bucket: MemoryR2): Env {
	return {
		TOTS_BUCKET: bucket as unknown as R2Bucket,
		ASSETS: {
			fetch: () => Promise.resolve(new Response("dashboard")),
		} as unknown as Fetcher,
		ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
		ACCESS_AUD: "audience",
		SYNC_SECRET: "sync-secret",
	};
}

function syncRequest(path: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set("authorization", "Bearer sync-secret");
	return new Request(`https://dashboard.example.com${path}`, { ...init, headers });
}

describe("cloud dashboard Worker", () => {
	it("enforces the Worker sync secret and browser Access JWT", async () => {
		const env = environment(new MemoryR2());

		expect(
			(
				await handleRequest(
					new Request("https://dashboard.example.com/api/sync/manifest"),
					env,
				)
			).status,
		).toBe(401);
		expect((await handleRequest(syncRequest("/api/sync/manifest"), env)).status).toBe(200);
		expect(
			(await handleRequest(new Request("https://dashboard.example.com/"), env)).status,
		).toBe(401);
	});

	it("streams only objects whose actual length and digest match", async () => {
		const bucket = new MemoryR2();
		const env = environment(bucket);
		const body = new TextEncoder().encode("verified object");
		const digest = createHash("sha256").update(body).digest("hex");
		const version = "a".repeat(64);
		const key = `tots/slug/${version}/index.html`;
		const valid = syncRequest(`/api/sync/object?key=${encodeURIComponent(key)}`, {
			method: "PUT",
			headers: {
				"content-length": String(body.byteLength),
				"content-type": "text/html",
				"x-tot-sha256": digest,
			},
			body,
		});

		expect((await handleRequest(valid, env)).status).toBe(201);
		expect(bucket.objects.get(key)?.customMetadata?.["sha256"]).toBe(digest);

		const badKey = `tots/slug/${"b".repeat(64)}/index.html`;
		const mismatch = syncRequest(`/api/sync/object?key=${encodeURIComponent(badKey)}`, {
			method: "PUT",
			headers: {
				"content-length": String(body.byteLength),
				"x-tot-sha256": "c".repeat(64),
			},
			body,
		});
		expect((await handleRequest(mismatch, env)).status).toBe(422);
		expect(bucket.objects.has(badKey)).toBe(false);
		expect([...bucket.objects.keys()].some((key) => key.startsWith("staging/"))).toBe(false);
	});

	it("rejects a manifest whose actual body length differs from its declaration", async () => {
		const env = environment(new MemoryR2());
		const response = await handleRequest(
			syncRequest("/api/sync/manifest", {
				method: "PUT",
				headers: { "content-length": "500", "content-type": "application/json" },
				body: "{}",
			}),
			env,
		);
		expect(response.status).toBe(422);
	});
});
