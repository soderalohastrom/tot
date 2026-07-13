const state = {
	tots: [],
	query: "",
	view: localStorage.getItem("tot-dashboard-view") || "cards",
	selected: null,
	signature: "",
};

const elements = {
	grid: document.querySelector("#tot-grid"),
	search: document.querySelector("#search"),
	count: document.querySelector("#result-count"),
	sync: document.querySelector("#sync-state"),
	reader: document.querySelector("#reader"),
	readerEmpty: document.querySelector(".reader-empty"),
	readerActive: document.querySelector(".reader-active"),
	readerTitle: document.querySelector("#reader-title"),
	readerFrame: document.querySelector("#reader-frame"),
	readerOpen: document.querySelector("#reader-open"),
	emptyTemplate: document.querySelector("#empty-template"),
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

function visibleTots() {
	return state.tots
		.map((tot) => ({
			tot,
			score: fuzzyScore(
				state.query,
				`${tot.title} ${tot.file} ${tot.url} ${tot.slug} ${tot.kind}`,
			),
		}))
		.filter(({ score }) => score > 0)
		.sort((a, b) =>
			state.query ? b.score - a.score : b.tot.createdAt.localeCompare(a.tot.createdAt),
		)
		.map(({ tot }) => tot);
}

function cardMarkup(tot, index) {
	return `<article class="tot-card" style="--i:${index}">
		<div class="preview"><iframe src="${escapeHtml(tot.url)}" loading="lazy" sandbox="allow-scripts allow-forms" tabindex="-1" title="Preview of ${escapeHtml(tot.title)}"></iframe></div>
		<button class="select-card" type="button" data-select="${escapeHtml(tot.id)}" aria-label="Read ${escapeHtml(tot.title)}"></button>
		<div class="card-body">
			<div class="card-topline"><span class="kind">${escapeHtml(tot.kind)}</span><time datetime="${escapeHtml(tot.createdAt)}">${formatDate(tot.createdAt)}</time></div>
			<h3 title="${escapeHtml(tot.title)}">${escapeHtml(tot.title)}</h3>
			<p class="file-path" title="${escapeHtml(tot.file)}">${escapeHtml(tot.file)}</p>
			<div class="card-footer"><span>${formatBytes(tot.bytes)}</span><a href="${escapeHtml(tot.originalUrl || tot.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a></div>
		</div>
	</article>`;
}

function render() {
	const tots = visibleTots();
	elements.count.textContent = `${tots.length} ${tots.length === 1 ? "page" : "pages"}`;
	elements.grid.classList.toggle("list-view", state.view === "list");
	if (!tots.length) {
		elements.grid.replaceChildren(elements.emptyTemplate.content.cloneNode(true));
		return;
	}
	elements.grid.innerHTML = tots.map(cardMarkup).join("");
}

function selectTot(id) {
	const tot = state.tots.find((candidate) => candidate.id === id);
	if (!tot) return;
	state.selected = id;
	elements.readerTitle.textContent = tot.title;
	elements.readerFrame.src = tot.url;
	elements.readerOpen.href = tot.originalUrl || tot.url;
	elements.readerEmpty.hidden = true;
	elements.readerActive.hidden = false;
	elements.reader.classList.add("open");
}

function closeReader() {
	state.selected = null;
	elements.reader.classList.remove("open");
	elements.readerFrame.removeAttribute("src");
	elements.readerActive.hidden = true;
	elements.readerEmpty.hidden = false;
}

async function refresh({ quiet = false } = {}) {
	if (!quiet) {
		elements.sync.className = "sync-state";
		elements.sync.innerHTML = "<i></i> Connecting";
	}
	try {
		const response = await fetch("/api/tots", { cache: "no-store" });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();
		const signature = data.tots
			.map(
				(tot) =>
					`${tot.id}:${tot.contentHash}:${tot.title}:${tot.url}:${tot.bytes}:${tot.createdAt}`,
			)
			.join("|");
		if (signature !== state.signature) {
			state.tots = data.tots;
			state.signature = signature;
			render();
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

function setView(view) {
	state.view = view;
	localStorage.setItem("tot-dashboard-view", view);
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
	localStorage.setItem("tot-dashboard-theme", theme);
	document.querySelector("#theme-toggle").title =
		`Switch to ${theme === "dark" ? "light" : "dark"} theme`;
}

const savedTheme = localStorage.getItem("tot-dashboard-theme");
if (savedTheme) setTheme(savedTheme);
else setTheme(currentTheme());
setView(state.view);

elements.search.addEventListener("input", (event) => {
	state.query = event.target.value;
	render();
});
elements.grid.addEventListener("click", (event) => {
	const target = event.target.closest("[data-select]");
	if (target) selectTot(target.dataset.select);
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
		if (state.selected) closeReader();
		else if (elements.search.value) {
			elements.search.value = "";
			state.query = "";
			render();
		}
	}
});

refresh();
setInterval(() => refresh({ quiet: true }), 12_000);
