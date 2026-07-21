/**
 * Project slugs tag a Tot into scoped client reading rooms (`/<project>` on the
 * dashboard host). The CLI, the loopback patch handler, and the manifest builder
 * all normalize through here; the Worker mirrors PROJECT_SLUG_PATTERN as a
 * constant (it does not import from src/).
 */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isProjectSlug(s: string): boolean {
	return PROJECT_SLUG_PATTERN.test(s);
}

/** Lowercase + trim; returns null when the result is not a valid project slug. */
export function normalizeProjectSlug(s: string): string | null {
	const normalized = s.trim().toLowerCase();
	return isProjectSlug(normalized) ? normalized : null;
}

/**
 * Normalize a set of project slugs: trim, lowercase, drop empties, dedupe, sort.
 * Throws on anything that is not a valid slug after normalization — callers
 * decide whether that is a CLI error or a 400 patch rejection.
 */
export function normalizeProjects(input: string[]): string[] {
	const out = new Set<string>();
	for (const raw of input) {
		const trimmed = raw.trim();
		if (trimmed === "") continue;
		const slug = normalizeProjectSlug(trimmed);
		if (slug === null) throw new Error(`invalid project slug: ${JSON.stringify(raw)}`);
		out.add(slug);
	}
	return [...out].sort();
}
