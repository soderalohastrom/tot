import {
	clampReaderWidth,
	defaultReaderWidth,
	maximumReaderWidth,
	readerWidthFromKey,
	readerWidthFromPointer,
} from "./reader-layout.js";

const LEGACY_VIEW_KEY = "tot-dashboard-view";
const LEGACY_READER_WIDTH_KEY = "tot-dashboard-reader-width";
const VIEW_KEY = "pala-dashboard-view";
const READER_WIDTH_KEY = "pala-dashboard-reader-width";

// Backwards-compatible read: existing browser state from the tot era lives
// under the tot-* keys. Migrate on first read so the next write uses the
// new key, but fall back silently if the new key is already set.
const storedView = localStorage.getItem(VIEW_KEY) ?? localStorage.getItem(LEGACY_VIEW_KEY);

const state = {
	palas: [],
	query: "",
	view: storedView || "cards",
	selected: null,
	signature: "",
	canManage: false,
	adminToken: null,
	showHidden: false,
	editing: null,
	tagging: null,
	pendingDelete: null,
	readerWidth: null,
	resizingReader: false,
	// Scoped client reading room: set when the app is served at /<project>.
	project: projectFromPath(location.pathname),
};

// The Worker only serves this shell at reserved-name-free single-segment
// paths, so any slug-shaped first segment is a project context. The local
// dashboard serves only / and /index.html, so this stays null there.
function projectFromPath(pathname) {
	const segment = pathname.split("/")[1] ?? "";
	if (segment === "" || segment === "index.html") return null;
	return /^[a-z0-9][a-z0-9-]{0,63}$/.test(segment) ? segment : null;
}

function humanizeProjectSlug(slug) {
	return slug
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

const elements = {
	grid: document.querySelector("#pala-grid"),
	search: document.querySelector("#search"),
	count: document.querySelector("#result-count"),
	hiddenToggle: document.querySelector("#hidden-toggle"),
	sync: document.querySelector("#sync-state"),
	reader: document.querySelector("#reader"),
	workspace: document.querySelector(".workspace"),
	readerResizer: document.querySelector("#reader-resizer"),
	readerEmpty: document.querySelector(".reader-empty"),
	readerActive: document.querySelector(".reader-active"),
	readerMissing: document.querySelector(".reader-missing"),
	readerTitle: document.querySelector("#reader-title"),
	readerFrame: document.querySelector("#reader-frame"),
	readerOpen: document.querySelector("#reader-open"),
	emptyTemplate: document.querySelector("#empty-template"),
	deleteDialog: document.querySelector("#delete-dialog"),
	deleteDescription: document.querySelector("#delete-description"),
	hideConfirm: document.querySelector("#hide-confirm"),
	deleteConfirm: document.querySelector("#delete-confirm"),
	toast: document.querySelector("#toast"),
	tagDialog: document.querySelector("#tag-dialog"),
	tagDialogTitle: document.querySelector("#tag-dialog-title"),
	tagChips: document.querySelector("#tag-chips"),
	tagForm: document.querySelector("#tag-form"),
	tagInput: document.querySelector("#tag-input"),
	tagSuggestions: document.querySelector("#tag-suggestions"),
	tagError: document.querySelector("#tag-error"),
	tagDone: document.querySelector("#tag-done"),
};

const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const icons = {
	edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10.9-10.9a2.2 2.2 0 0 0-3.2-3.2L5 15.8 4 20Z"></path><path d="m14.5 6.5 3 3"></path></svg>',
	hide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path></svg>',
	restore:
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.2-6 9-6 9 6 9 6-3.2 6-9 6-9-6-9-6Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>',
	tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7l9 9-7 7-9-9V4Z"></path><circle cx="8.5" cy="8.5" r="1.3"></circle></svg>',
};

function escapeHtml(value) {
	return String(value).replace(
		/[&<>'"]/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				"'": "&#39;",
				'"': "&quot;",
			})[character],
	);
}

function fuzzyScore(needle, haystack) {
	const query = needle.toLowerCase().trim();
	const text = haystack.toLowerCase();
	if (!query) return 1;
	const exact = text.indexOf(query);
	if (exact >= 0) return 1000 - exact;
	let queryIndex = 0;
	let score = 0;
	let previous = -2;
	for (let index = 0; index < text.length && queryIndex < query.length; index += 1) {
		if (text[index] !== query[queryIndex]) continue;
		score += index === previous + 1 ? 12 : 3;
		if (index === 0 || /[\s/_-]/.test(text[index - 1])) score += 8;
		previous = index;
		queryIndex += 1;
	}
	return queryIndex === query.length ? score - (text.length - query.length) * 0.02 : 0;
}

function formatDate(value) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(new Date(value));
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

function visiblePalas() {
	return state.palas
		.filter((pala) => !pala.hidden || state.showHidden)
		.map((pala) => ({
			pala,
			score: fuzzyScore(
				state.query,
				`${pala.title} ${pala.file} ${pala.url} ${pala.slug} ${pala.kind} ${(pala.projects ?? []).join(" ")}`,
			),
		}))
		.filter(({ score }) => score > 0)
		.sort((a, b) =>
			state.query ? b.score - a.score : b.pala.createdAt.localeCompare(a.pala.createdAt),
		)
		.map(({ pala }) => pala);
}

function cardMarkup(pala, index) {
	const editing = state.editing === pala.id;
	const actions =
		state.canManage && state.view === "cards"
			? `<div class="card-actions">
				<button type="button" data-action="tag" data-id="${escapeHtml(pala.id)}" aria-label="Tag ${escapeHtml(pala.title)} by client or project" title="Tag by client / project">${icons.tag}</button>
				<button type="button" data-action="edit" data-id="${escapeHtml(pala.id)}" aria-label="Rename ${escapeHtml(pala.title)}" title="Rename">${icons.edit}</button>
				<button type="button" data-action="${pala.hidden ? "restore" : "hide"}" data-id="${escapeHtml(pala.id)}" aria-label="${pala.hidden ? "Restore" : "Hide or delete"} ${escapeHtml(pala.title)}" title="${pala.hidden ? "Restore to dashboard" : "Hide or delete"}">${pala.hidden ? icons.restore : icons.hide}</button>
			</div>`
			: "";
	// Owner-only: never show cross-room membership inside a client reading room.
	const projects = state.canManage ? (pala.projects ?? []) : [];
	const tagRow = projects.length
		? `<div class="card-tags">${projects
				.map((slug) => `<span class="card-tag">${escapeHtml(slug)}</span>`)
				.join("")}</div>`
		: "";
	return `<article class="pala-card${pala.hidden ? " is-hidden" : ""}" style="--i:${index}">
		<div class="preview">${pala.localUrl && pala.localUrl !== pala.url
			? `<iframe src="${escapeHtml(pala.localUrl)}" loading="lazy" sandbox="allow-scripts allow-forms" tabindex="-1" title="Preview of ${escapeHtml(pala.title)}"></iframe>`
			: pala.cloudUrl
				? `<iframe src="${escapeHtml(pala.cloudUrl)}" loading="lazy" sandbox="allow-scripts allow-forms" tabindex="-1" title="Cloud preview of ${escapeHtml(pala.title)}"></iframe>`
				: `<div class="preview-placeholder" role="img" aria-label="No source available for ${escapeHtml(pala.title)}">
					<span class="preview-glyph" aria-hidden="true">·</span>
					<span class="preview-label">no source available</span>
					<span class="preview-hint">re-publish to restore</span>
				</div>`}</div>
		<button class="select-card" type="button" data-select="${escapeHtml(pala.id)}" aria-label="Read ${escapeHtml(pala.title)}"></button>
		${actions}
		<div class="card-body">
			<div class="card-topline"><span class="kind">${escapeHtml(pala.kind)}${pala.hidden ? ' · <b class="hidden-label">hidden</b>' : ""}</span><time datetime="${escapeHtml(pala.createdAt)}">${formatDate(pala.createdAt)}</time></div>
			${editing ? `<form class="rename-form" data-rename="${escapeHtml(pala.id)}"><input name="title" value="${escapeHtml(pala.title)}" maxlength="160" aria-label="New title for ${escapeHtml(pala.title)}" /><span>Enter to save · Esc to cancel</span></form>` : `<h3 title="${escapeHtml(pala.title)}">${escapeHtml(pala.title)}</h3>`}
			${tagRow}
			<p class="file-path" title="${escapeHtml(pala.file)}">${escapeHtml(pala.file)}</p>
			<div class="card-footer"><span>${formatBytes(pala.bytes)}</span><a href="${escapeHtml(pala.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a></div>
		</div>
	</article>`;
}

function render() {
	const palas = visiblePalas();
	const hiddenCount = state.palas.filter((pala) => pala.hidden).length;
	elements.count.textContent = `${palas.length} ${palas.length === 1 ? "page" : "pages"}`;
	elements.hiddenToggle.hidden = !state.canManage || hiddenCount === 0;
	elements.hiddenToggle.textContent = state.showHidden
		? "Hide hidden"
		: `Show hidden (${hiddenCount})`;
	elements.hiddenToggle.setAttribute("aria-pressed", String(state.showHidden));
	elements.grid.classList.toggle("list-view", state.view === "list");
	if (!palas.length) {
		elements.grid.replaceChildren(elements.emptyTemplate.content.cloneNode(true));
		return;
	}
	elements.grid.innerHTML = palas.map(cardMarkup).join("");
	const renameInput = elements.grid.querySelector(".rename-form input");
	if (renameInput) {
		renameInput.focus();
		renameInput.select();
	}
}

function selectPala(id) {
	const pala = state.palas.find((candidate) => candidate.id === id);
	if (!pala) return;
	state.selected = id;
	elements.readerTitle.textContent = pala.title;
	const hasLocal = pala.localUrl && pala.localUrl !== pala.url;
	elements.readerFrame.src = hasLocal ? pala.localUrl : (pala.cloudUrl || "");
	elements.readerOpen.href = pala.cloudUrl || pala.url;
	elements.readerEmpty.hidden = true;
	elements.readerActive.hidden = !hasLocal;
	elements.readerMissing.hidden = hasLocal;
	elements.readerFrame.hidden = !hasLocal;
	elements.reader.classList.add("open");
}

function closeReader() {
	state.selected = null;
	elements.reader.classList.remove("open");
	elements.readerFrame.removeAttribute("src");
	elements.readerActive.hidden = true;
	elements.readerMissing.hidden = true;
	elements.readerEmpty.hidden = false;
	elements.readerFrame.hidden = false;
}

function setReaderWidth(width, { persist = false } = {}) {
	const maximum = maximumReaderWidth(window.innerWidth);
	const next = clampReaderWidth(width, window.innerWidth);
	state.readerWidth = next;
	elements.workspace.style.setProperty("--reader-width", `${next}px`);
	elements.readerResizer.setAttribute("aria-valuemax", String(maximum));
	elements.readerResizer.setAttribute("aria-valuenow", String(next));
	elements.readerResizer.setAttribute("aria-valuetext", `${next} pixels wide`);
	if (persist) {
		localStorage.setItem(READER_WIDTH_KEY, String(next));
		localStorage.removeItem(LEGACY_READER_WIDTH_KEY);
	}
}

function resetReaderWidth() {
	localStorage.removeItem(READER_WIDTH_KEY);
	localStorage.removeItem(LEGACY_READER_WIDTH_KEY);
	setReaderWidth(defaultReaderWidth(window.innerWidth));
}

function initializeReaderWidth() {
	// Backwards-compatible read: prefer the new key, fall back to the tot-era
	// key for users who never opened the pala binary. The next persist
	// (resize gesture) writes to READER_WIDTH_KEY and clears the legacy.
	const saved = Number(
		localStorage.getItem(READER_WIDTH_KEY) ?? localStorage.getItem(LEGACY_READER_WIDTH_KEY),
	);
	setReaderWidth(
		Number.isFinite(saved) && saved > 0 ? saved : defaultReaderWidth(window.innerWidth),
	);
}

async function refresh({ quiet = false } = {}) {
	if (!quiet) {
		elements.sync.className = "sync-state";
		elements.sync.innerHTML = "<i></i> Connecting";
	}
	try {
		const manifestUrl = state.project
			? `/api/tots?project=${encodeURIComponent(state.project)}`
			: "/api/tots";
		const response = await fetch(manifestUrl, { cache: "no-store" });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();
		// Reading rooms are always read-only, whatever the endpoint claims.
		const canManage = !state.project && data.capabilities?.manage === true;
		const adminToken = canManage ? data.capabilities.token : null;
		const signature =
			data.tots
				.map(
					(pala) =>
						`${pala.id}:${pala.contentHash}:${pala.title}:${pala.url}:${pala.bytes}:${pala.createdAt}:${pala.hidden === true}:${(pala.projects ?? []).join(",")}`,
				)
				.join("|") + `|manage:${canManage}`;
		if (signature !== state.signature) {
			state.palas = data.tots;
			state.signature = signature;
			state.canManage = canManage;
			state.adminToken = adminToken;
			render();
		} else {
			state.adminToken = adminToken;
		}
		const time = new Intl.DateTimeFormat(undefined, {
			hour: "numeric",
			minute: "2-digit",
			second: "2-digit",
		}).format(new Date());
		elements.sync.className = "sync-state live";
		elements.sync.innerHTML = `<i></i> Synced ${time}`;
	} catch (error) {
		elements.sync.className = "sync-state error";
		elements.sync.innerHTML = `<i></i> ${escapeHtml(error.message || "Sync failed")}`;
	}
}

let toastTimer;
function showToast(message, tone = "success") {
	clearTimeout(toastTimer);
	elements.toast.textContent = message;
	elements.toast.dataset.tone = tone;
	elements.toast.hidden = false;
	toastTimer = setTimeout(() => {
		elements.toast.hidden = true;
	}, 3600);
}

async function mutatePala(id, { method = "PATCH", body, success }) {
	if (!state.canManage || !state.adminToken) return;
	try {
		const headers = { "x-pala-dashboard-token": state.adminToken };
		if (body !== undefined) headers["content-type"] = "application/json";
		const response = await fetch(`/api/tots/${encodeURIComponent(id)}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const result = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
		state.signature = "";
		state.editing = null;
		await refresh({ quiet: true });
		showToast(success);
	} catch (error) {
		showToast(error.message || "Could not update pala", "error");
	}
}

function beginRename(id) {
	state.editing = id;
	render();
}

function tagById(id) {
	return state.palas.find((pala) => pala.id === id) ?? null;
}

// Union of every project slug in use, so the input can suggest existing rooms
// instead of making you retype "mise"/"gohappy".
function allProjectSlugs() {
	const slugs = new Set();
	for (const pala of state.palas) for (const slug of pala.projects ?? []) slugs.add(slug);
	return [...slugs].sort();
}

function hideTagError() {
	elements.tagError.hidden = true;
	elements.tagError.textContent = "";
}

function showTagError(message) {
	elements.tagError.textContent = message;
	elements.tagError.hidden = false;
}

// Chips + suggestions always render from state.palas — the persisted source of
// truth — so the dialog reflects exactly what was saved after each change.
function renderTagDialog() {
	const pala = tagById(state.tagging);
	if (!pala) return;
	const projects = pala.projects ?? [];
	elements.tagChips.innerHTML = projects.length
		? projects
				.map(
					(slug) =>
						`<span class="tag-chip">${escapeHtml(slug)}<button type="button" data-remove-tag="${escapeHtml(slug)}" aria-label="Remove ${escapeHtml(slug)}" title="Remove">×</button></span>`,
				)
				.join("")
		: '<span class="tag-empty">No rooms yet — add one below.</span>';
	const applied = new Set(projects);
	elements.tagSuggestions.innerHTML = allProjectSlugs()
		.filter((slug) => !applied.has(slug))
		.map((slug) => `<option value="${escapeHtml(slug)}"></option>`)
		.join("");
}

function openTagDialog(id) {
	const pala = tagById(id);
	if (!pala) return;
	state.tagging = id;
	elements.tagDialogTitle.textContent = pala.title;
	elements.tagInput.value = "";
	hideTagError();
	renderTagDialog();
	elements.tagDialog.showModal();
	elements.tagInput.focus();
}

// Persist immediately on each add/remove: the reading room is live, so there is
// no separate "save" step to forget. Re-render from the refreshed state.
async function commitTags(id, projects) {
	if (!state.canManage || !state.adminToken) return;
	try {
		const response = await fetch(`/api/tots/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: {
				"x-pala-dashboard-token": state.adminToken,
				"content-type": "application/json",
			},
			body: JSON.stringify({ projects: projects.length ? projects : null }),
		});
		const result = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
		state.signature = "";
		await refresh({ quiet: true });
		if (state.tagging === id) renderTagDialog();
	} catch (error) {
		showTagError(error.message || "Could not update rooms");
	}
}

function addTagFromInput() {
	const pala = tagById(state.tagging);
	if (!pala) return;
	const slug = elements.tagInput.value.trim().toLowerCase();
	if (!slug) return;
	if (!PROJECT_SLUG_PATTERN.test(slug)) {
		showTagError("Use lowercase letters, numbers and hyphens (e.g. gohappy).");
		return;
	}
	elements.tagInput.value = "";
	if ((pala.projects ?? []).includes(slug)) {
		hideTagError();
		return;
	}
	hideTagError();
	commitTags(pala.id, [...(pala.projects ?? []), slug]);
}

function removeTag(slug) {
	const pala = tagById(state.tagging);
	if (!pala) return;
	commitTags(
		pala.id,
		(pala.projects ?? []).filter((existing) => existing !== slug),
	);
}

function openDeleteDialog(id) {
	const pala = state.palas.find((candidate) => candidate.id === id);
	if (!pala) return;
	state.pendingDelete = id;
	elements.deleteDescription.textContent = `“${pala.title}” can disappear from the dashboard without removing its published page.`;
	elements.deleteDialog.showModal();
}

function setView(view) {
	state.view = view;
	localStorage.setItem(VIEW_KEY, view);
	localStorage.removeItem(LEGACY_VIEW_KEY);
	document.querySelectorAll("[data-view]").forEach((button) => {
		const active = button.dataset.view === view;
		button.classList.toggle("active", active);
		button.setAttribute("aria-pressed", String(active));
	});
	render();
}

function currentTheme() {
	return (
		document.documentElement.dataset.theme ||
		(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
	);
}

function setTheme(theme) {
	document.documentElement.dataset.theme = theme;
	localStorage.setItem("pala-dashboard-theme", theme);
	document.querySelector("#theme-toggle").title =
		`Switch to ${theme === "dark" ? "light" : "dark"} theme`;
}

const savedTheme = localStorage.getItem("pala-dashboard-theme") ?? localStorage.getItem("tot-dashboard-theme");
if (savedTheme) setTheme(savedTheme);
else setTheme(currentTheme());
setView(state.view);

// Scoped reading room: swap the masthead to the project name (Phase 1 derives
// it from the slug; Phase 2 will use branding metadata).
if (state.project) {
	const name = humanizeProjectSlug(state.project);
	document.title = `${name} · Pala`;
	const eyebrow = document.querySelector(".eyebrow");
	if (eyebrow) eyebrow.textContent = "Reading room";
	const brandHeading = document.querySelector(".brand-lockup h1");
	if (brandHeading) brandHeading.textContent = name;
}

elements.search.addEventListener("input", (event) => {
	state.query = event.target.value;
	render();
});
elements.grid.addEventListener("click", (event) => {
	const action = event.target.closest("[data-action]");
	if (action) {
		const id = action.dataset.id;
		if (action.dataset.action === "tag") openTagDialog(id);
		if (action.dataset.action === "edit") beginRename(id);
		if (action.dataset.action === "hide") openDeleteDialog(id);
		if (action.dataset.action === "restore") {
			mutatePala(id, { body: { hidden: false }, success: "Pala restored to the dashboard" });
		}
		return;
	}
	const target = event.target.closest("[data-select]");
	if (target) selectPala(target.dataset.select);
});
elements.grid.addEventListener("submit", (event) => {
	const form = event.target.closest("[data-rename]");
	if (!form) return;
	event.preventDefault();
	const title = new FormData(form).get("title");
	mutatePala(form.dataset.rename, {
		body: { title: typeof title === "string" ? title : "" },
		success: "Display name saved",
	});
});
elements.tagForm.addEventListener("submit", (event) => {
	event.preventDefault();
	addTagFromInput();
	elements.tagInput.focus();
});
elements.tagChips.addEventListener("click", (event) => {
	const remove = event.target.closest("[data-remove-tag]");
	if (remove) removeTag(remove.dataset.removeTag);
});
elements.tagDone.addEventListener("click", () => elements.tagDialog.close());
elements.tagDialog.addEventListener("close", () => {
	state.tagging = null;
	hideTagError();
});
elements.hiddenToggle.addEventListener("click", () => {
	state.showHidden = !state.showHidden;
	render();
});
elements.hideConfirm.addEventListener("click", async () => {
	const id = state.pendingDelete;
	elements.deleteDialog.close();
	if (id) await mutatePala(id, { body: { hidden: true }, success: "Pala hidden from dashboards" });
});
elements.deleteConfirm.addEventListener("click", async () => {
	const id = state.pendingDelete;
	const pala = state.palas.find((candidate) => candidate.id === id);
	if (!id || !pala) return;
	if (!confirm(`Permanently delete “${pala.title}” and its published page?`)) return;
	elements.deleteDialog.close();
	if (state.selected === id) closeReader();
	await mutatePala(id, { method: "DELETE", success: "Published Pala permanently deleted" });
});
elements.deleteDialog.addEventListener("close", () => {
	state.pendingDelete = null;
});
elements.readerResizer.addEventListener("pointerdown", (event) => {
	if (event.button !== 0 || state.resizingReader) return;
	event.preventDefault();
	state.resizingReader = true;
	const startX = event.clientX;
	const startWidth = elements.reader.getBoundingClientRect().width;
	elements.readerResizer.setPointerCapture(event.pointerId);
	elements.readerResizer.classList.add("is-dragging");
	document.body.classList.add("is-resizing-reader");

	const move = (moveEvent) => {
		setReaderWidth(
			readerWidthFromPointer(startWidth, startX, moveEvent.clientX, window.innerWidth),
		);
	};
	const finish = (finishEvent) => {
		if (!state.resizingReader) return;
		state.resizingReader = false;
		if (elements.readerResizer.hasPointerCapture(finishEvent.pointerId)) {
			elements.readerResizer.releasePointerCapture(finishEvent.pointerId);
		}
		elements.readerResizer.classList.remove("is-dragging");
		document.body.classList.remove("is-resizing-reader");
		setReaderWidth(state.readerWidth, { persist: true });
		elements.readerResizer.removeEventListener("pointermove", move);
		elements.readerResizer.removeEventListener("pointerup", finish);
		elements.readerResizer.removeEventListener("pointercancel", finish);
	};
	elements.readerResizer.addEventListener("pointermove", move);
	elements.readerResizer.addEventListener("pointerup", finish);
	elements.readerResizer.addEventListener("pointercancel", finish);
});
elements.readerResizer.addEventListener("keydown", (event) => {
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		resetReaderWidth();
		return;
	}
	const width = readerWidthFromKey(
		event.key,
		state.readerWidth,
		window.innerWidth,
		event.shiftKey,
	);
	if (width === null) return;
	event.preventDefault();
	setReaderWidth(width, { persist: true });
});
elements.readerResizer.addEventListener("dblclick", resetReaderWidth);
window.addEventListener("resize", () => {
	if (state.readerWidth !== null) setReaderWidth(state.readerWidth);
});
document
	.querySelectorAll("[data-view]")
	.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document
	.querySelector("#theme-toggle")
	.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
document.querySelector("#reader-close").addEventListener("click", closeReader);
document.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
		event.preventDefault();
		elements.search.focus();
	}
	if (event.key === "Escape") {
		// The tag dialog is a native modal; let it handle Escape itself so we
		// don't also clear the reader or the search box behind it.
		if (elements.tagDialog.open) return;
		if (state.editing) {
			state.editing = null;
			render();
		} else if (state.selected) closeReader();
		else if (elements.search.value) {
			elements.search.value = "";
			state.query = "";
			render();
		}
	}
});

initializeReaderWidth();
refresh();
setInterval(() => refresh({ quiet: true }), 12_000);
