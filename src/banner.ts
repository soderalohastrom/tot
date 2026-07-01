import { Resvg } from "@resvg/resvg-js";

export interface BannerMeta {
	title: string;
	description?: string;
}

interface Palette {
	from: string;
	to: string;
	ink: string;
	inkDim: string;
}

// Deterministic pick (hash of title) so re-publishing the same title keeps the
// same color instead of shuffling on every `tot update`.
const PALETTES: Palette[] = [
	{ from: "#0f766e", to: "#134e4a", ink: "#f0fdfa", inkDim: "#99f6e4" }, // teal
	{ from: "#b45309", to: "#78350f", ink: "#fffbeb", inkDim: "#fde68a" }, // amber
	{ from: "#166534", to: "#14532d", ink: "#f0fdf4", inkDim: "#bbf7d0" }, // forest
	{ from: "#b91c1c", to: "#7f1d1d", ink: "#fef2f2", inkDim: "#fecaca" }, // brick
	{ from: "#4338ca", to: "#312e81", ink: "#eef2ff", inkDim: "#c7d2fe" }, // indigo
	{ from: "#a21caf", to: "#701a75", ink: "#fdf4ff", inkDim: "#f5d0fe" }, // plum
];

export const BANNER_WIDTH = 1200;
export const BANNER_HEIGHT = 630;

const MARGIN_X = 80;
// Conservative (wider-than-actual) average-char-width estimates, since we
// render without measuring real glyph metrics — better to wrap a line early
// than let one run off the canvas.
const TITLE_FONT_SIZE = 64;
const TITLE_LINE_HEIGHT = 74;
const TITLE_CHARS_PER_LINE = 27;
const TITLE_MAX_LINES = 2;
const DESC_FONT_SIZE = 28;
const DESC_LINE_HEIGHT = 38;
const DESC_CHARS_PER_LINE = 68;
const DESC_MAX_LINES = 2;

function paletteFor(title: string): Palette {
	let hash = 0;
	for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) | 0;
	return PALETTES[Math.abs(hash) % PALETTES.length]!;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Greedy word-wrap into at most `maxLines`, ellipsizing the last line if the
 * text doesn't fit — so long titles/descriptions wrap or truncate instead of
 * running past the canvas edge.
 */
function wrapLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = "";
	let consumed = 0;
	for (const word of words) {
		const candidate = current === "" ? word : `${current} ${word}`;
		if (candidate.length > maxCharsPerLine && current !== "") {
			lines.push(current);
			consumed += current.split(/\s+/).length;
			current = word;
			if (lines.length === maxLines) break;
		} else {
			current = candidate;
		}
	}
	if (lines.length < maxLines && current !== "") {
		lines.push(current);
		consumed += current.split(/\s+/).length;
	}

	const truncated = consumed < words.length;
	const last = lines.length - 1;
	if (last >= 0 && (truncated || lines[last]!.length > maxCharsPerLine)) {
		const maxLen = Math.max(0, maxCharsPerLine - 1);
		lines[last] = `${lines[last]!.slice(0, maxLen)}…`;
	}
	return lines;
}

export function bannerSvg(meta: BannerMeta): string {
	const p = paletteFor(meta.title);
	const titleLines = wrapLines(meta.title, TITLE_CHARS_PER_LINE, TITLE_MAX_LINES);
	const descLines =
		meta.description === undefined ? [] : wrapLines(meta.description, DESC_CHARS_PER_LINE, DESC_MAX_LINES);

	const titleTop = descLines.length === 0 ? 330 : 280;
	const titleTexts = titleLines
		.map(
			(line, i) =>
				`<text x="${MARGIN_X}" y="${titleTop + i * TITLE_LINE_HEIGHT}" font-family="Georgia, 'Times New Roman', serif" font-size="${TITLE_FONT_SIZE}" font-weight="700" fill="${p.ink}">${escapeXml(line)}</text>`,
		)
		.join("\n\t");

	const descTop = titleTop + titleLines.length * TITLE_LINE_HEIGHT + 20;
	const descTexts = descLines
		.map(
			(line, i) =>
				`<text x="${MARGIN_X}" y="${descTop + i * DESC_LINE_HEIGHT}" font-family="Helvetica, Arial, sans-serif" font-size="${DESC_FONT_SIZE}" fill="${p.inkDim}">${escapeXml(line)}</text>`,
		)
		.join("\n\t");

	return `<svg width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" viewBox="0 0 ${BANNER_WIDTH} ${BANNER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0%" stop-color="${p.from}"/>
			<stop offset="100%" stop-color="${p.to}"/>
		</linearGradient>
	</defs>
	<rect width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" fill="url(#bg)"/>
	${titleTexts}
	${descTexts}
	<text x="${MARGIN_X}" y="${BANNER_HEIGHT - 60}" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="${p.inkDim}" opacity="0.8">tot.page</text>
</svg>`;
}

/** Renders the deterministic title/description banner to a 1200×630 PNG. */
export function renderBannerPng(meta: BannerMeta): Buffer {
	const resvg = new Resvg(bannerSvg(meta), { fitTo: { mode: "width", value: BANNER_WIDTH } });
	return resvg.render().asPng();
}
