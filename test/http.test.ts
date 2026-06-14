import { describe, expect, it } from "vitest";
import {
	createHttpClient,
	deleteDocument,
	getDocument,
	getMe,
	postDocument,
	putDocument,
} from "../src/http.js";
import { emptyResponse, jsonResponse, stubHttp } from "./stub.js";

describe("http layer", () => {
	// Catches: a wrong POST path or body shape. The server expects
	// POST /v1/documents with a JSON {kind, body}; the response is
	// {document, workspace} and we must read workspace.slug + document.id.
	it("postDocument posts {kind, body} to /v1/documents and reads slug+id", async () => {
		const http = stubHttp((call) => {
			expect(call.method).toBe("POST");
			expect(call.path).toBe("/v1/documents");
			expect(JSON.parse(String(call.body))).toEqual({ kind: "markdown", body: "# Hello" });
			expect(call.headers?.["content-type"]).toBe("application/json");
			return jsonResponse(201, {
				document: {
					id: "doc_1",
					workspace_id: "ws_1",
					doc_path: "index.md",
					version: null,
				},
				workspace: { id: "ws_1", slug: "k7q9zyxwvu98abcd", visibility: "open" },
			});
		});
		const res = await postDocument(http, "markdown", "# Hello");
		expect(res.workspace.slug).toBe("k7q9zyxwvu98abcd");
		expect(res.document.id).toBe("doc_1");
	});

	// Catches: reading `version` from the wrong place. GET returns the Document
	// at top level (NOT wrapped in {document}); version flips from null → hash.
	it("getDocument reads the top-level version field", async () => {
		const http = stubHttp((call) => {
			expect(call.method).toBe("GET");
			expect(call.path).toBe("/v1/workspaces/ws_1/documents/doc_1");
			return jsonResponse(200, { id: "doc_1", doc_path: "index.md", version: "abc123" });
		});
		const doc = await getDocument(http, "ws_1", "doc_1");
		expect(doc.version).toBe("abc123");
	});

	// Catches: sending markdown as application/json. The PUT body must be the
	// RAW string with Content-Type text/markdown — a JSON wrap is a 422.
	it("putDocument sends a raw body with text/markdown content-type", async () => {
		const http = stubHttp((call) => {
			expect(call.method).toBe("PUT");
			expect(call.path).toBe("/v1/workspaces/ws_1/documents/doc_1");
			expect(call.body).toBe("# Edited");
			expect(call.headers?.["content-type"]).toBe("text/markdown");
			return jsonResponse(200, { id: "doc_1", version: "def456" });
		});
		const doc = await putDocument(http, "ws_1", "doc_1", "# Edited", "text/markdown");
		expect(doc.version).toBe("def456");
	});

	// Catches: treating a 204 as an error or trying to parse an empty body.
	it("deleteDocument accepts a 204 with no body", async () => {
		const http = stubHttp((call) => {
			expect(call.method).toBe("DELETE");
			expect(call.path).toBe("/v1/workspaces/ws_1/documents/doc_1");
			return emptyResponse(204);
		});
		await expect(deleteDocument(http, "ws_1", "doc_1")).resolves.toBeUndefined();
	});

	// Catches: a missing/wrong Authorization header on /v1/me, and not
	// surfacing a 401 from an invalid key.
	it("getMe rejects a 401 and createHttpClient sends the bearer key", async () => {
		// First, the wrapper actually attaches the key.
		const fetchImpl = (async (_url: string, init: any) => {
			expect(init.headers["authorization"]).toBe("Bearer wsk_live_test");
			return new Response(JSON.stringify({ user_id: "u1", email: "a@b.com" }), {
				status: 200,
			});
		}) as unknown as typeof fetch;
		const client = createHttpClient(
			{ endpoint: "https://api.example", key: "wsk_live_test" },
			fetchImpl,
		);
		const me = await getMe(client);
		expect(me.email).toBe("a@b.com");

		// And a 401 from a bad key surfaces as an error (not a silent success).
		const bad = stubHttp(() => jsonResponse(401, { error: { message: "invalid key" } }));
		await expect(getMe(bad)).rejects.toThrow(/invalid key/);
	});

	// Catches: a network failure (offline/DNS/wrong --endpoint) surfacing as a
	// bare "fetch failed" with no context. The wrapper must name the endpoint so
	// the user can tell connectivity from a server error.
	it("wraps a fetch rejection with the endpoint and the underlying reason", async () => {
		const fetchImpl = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		const client = createHttpClient({ endpoint: "https://api.example", key: null }, fetchImpl);
		await expect(client.fetch("GET", "/v1/me")).rejects.toThrow(
			/cannot reach https:\/\/api\.example .*fetch failed.*--endpoint/,
		);
	});

	// Catches: a wrong base-URL join (double slash / missing slash) and that the
	// key is omitted entirely when none is set (anonymous publishes).
	it("createHttpClient joins endpoint without a double slash and omits key when null", async () => {
		let seenUrl = "";
		let seenAuth: string | undefined;
		const fetchImpl = (async (url: string, init: any) => {
			seenUrl = url;
			seenAuth = init.headers["authorization"];
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch;
		const client = createHttpClient({ endpoint: "https://api.example/", key: null }, fetchImpl);
		await client.fetch("GET", "/v1/me");
		expect(seenUrl).toBe("https://api.example/v1/me");
		expect(seenAuth).toBeUndefined();
	});
});
