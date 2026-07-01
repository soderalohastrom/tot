import { describe, expect, it } from "vitest";
import { injectOpenGraph } from "../src/og.js";

describe("injectOpenGraph", () => {
	it("injects tags right after <head> so they win over existing ones", () => {
		const html = "<!doctype html><html><head><title>old</title></head><body>hi</body></html>";
		const out = injectOpenGraph(html, {
			title: "New Title",
			description: "A description",
			url: "https://tot.page/abc",
			image: "https://tot.page/abc/preview.png",
		});

		expect(out.indexOf("<title>New Title</title>")).toBeLessThan(out.indexOf("<title>old</title>"));
		expect(out).toContain('<meta property="og:title" content="New Title" />');
		expect(out).toContain('<meta property="og:description" content="A description" />');
		expect(out).toContain('<meta property="og:url" content="https://tot.page/abc" />');
		expect(out).toContain('<meta property="og:image" content="https://tot.page/abc/preview.png" />');
		expect(out).toContain('<meta name="twitter:card" content="summary_large_image" />');
	});

	it("falls back to summary card when no image is given", () => {
		const out = injectOpenGraph("<html><head></head><body></body></html>", { title: "T" });
		expect(out).toContain('<meta name="twitter:card" content="summary" />');
		expect(out).not.toContain("og:image");
	});

	it("escapes HTML-significant characters in metadata", () => {
		const out = injectOpenGraph("<html><head></head></html>", {
			title: `<script>alert("x")</script> & "quotes"`,
		});
		expect(out).not.toContain("<script>alert");
		expect(out).toContain("&lt;script&gt;");
		expect(out).toContain("&amp;");
		expect(out).toContain("&quot;quotes&quot;");
	});

	it("adds a <head> when missing but <html> is present", () => {
		const out = injectOpenGraph("<html><body>hi</body></html>", { title: "T" });
		expect(out).toContain("<head>");
		expect(out).toContain("<title>T</title>");
	});

	it("wraps bare fragments in a full document", () => {
		const out = injectOpenGraph("<p>hi</p>", { title: "T" });
		expect(out).toMatch(/^<!doctype html>/);
		expect(out).toContain("<head>");
		expect(out).toContain("<body>\n<p>hi</p>\n</body>");
	});
});
