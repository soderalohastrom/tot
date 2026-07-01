export interface OgMeta {
	title: string;
	description?: string;
	url?: string;
	image?: string;
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Injects <title>/description/Open Graph/Twitter Card tags so link-unfurl
 * crawlers (Slack, Discord, etc.) see metadata without executing JS.
 * Tags go right after <head> (not before </head>) so they win over any
 * pre-existing <title>/meta tags further down — crawlers use the first match.
 */
export function injectOpenGraph(html: string, meta: OgMeta): string {
	const lines = [
		`<title>${escapeHtml(meta.title)}</title>`,
		meta.description === undefined
			? null
			: `<meta name="description" content="${escapeHtml(meta.description)}" />`,
		`<meta property="og:type" content="article" />`,
		meta.url === undefined ? null : `<meta property="og:url" content="${escapeHtml(meta.url)}" />`,
		`<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
		meta.description === undefined
			? null
			: `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
		meta.image === undefined
			? null
			: `<meta property="og:image" content="${escapeHtml(meta.image)}" />`,
		`<meta name="twitter:card" content="${meta.image === undefined ? "summary" : "summary_large_image"}" />`,
		`<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
		meta.description === undefined
			? null
			: `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
		meta.image === undefined
			? null
			: `<meta name="twitter:image" content="${escapeHtml(meta.image)}" />`,
	].filter((line): line is string => line !== null);
	const tags = lines.join("\n");

	const headOpen = /<head[^>]*>/i.exec(html);
	if (headOpen !== null) {
		return `${html.slice(0, headOpen.index + headOpen[0].length)}\n${tags}\n${html.slice(headOpen.index + headOpen[0].length)}`;
	}
	const htmlOpen = /<html[^>]*>/i.exec(html);
	if (htmlOpen !== null) {
		const insertAt = htmlOpen.index + htmlOpen[0].length;
		return `${html.slice(0, insertAt)}\n<head>\n${tags}\n</head>\n${html.slice(insertAt)}`;
	}
	return `<!doctype html>\n<html>\n<head>\n${tags}\n</head>\n<body>\n${html}\n</body>\n</html>`;
}
