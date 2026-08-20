// Verify the CLI package keeps the palapala domain split honest.
//
// The CLI talks to the palapala-publisher Worker origin. The links it prints
// stay on the same cookieless raw content origin (one origin serves both).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXPECTED_API_ENDPOINT = "https://docs.palapala.me";
const EXPECTED_CONTENT_ORIGIN = "https://docs.palapala.me";

const exactChecks = [
	{
		file: "src/config.ts",
		text: `DEFAULT_ENDPOINT = "${EXPECTED_API_ENDPOINT}"`,
	},
	{
		file: "src/config.ts",
		text: `DEFAULT_CONTENT_ORIGIN = "${EXPECTED_CONTENT_ORIGIN}"`,
	},
	{
		file: "dist/config.js",
		text: `DEFAULT_ENDPOINT = "${EXPECTED_API_ENDPOINT}"`,
	},
	{
		file: "dist/config.js",
		text: `DEFAULT_CONTENT_ORIGIN = "${EXPECTED_CONTENT_ORIGIN}"`,
	},
	{
		file: "dist/cli.js",
		text: `default ${EXPECTED_API_ENDPOINT}`,
	},
];

const packageSurfaceFiles = [
	"README.md",
	"package.json",
	"src/cli.ts",
	"src/config.ts",
	"dist/cli.js",
	"dist/config.js",
	"dist/config.d.ts",
];

function fail(message) {
	throw new Error(`domain-contract verification failed: ${message}`);
}

function read(file) {
	return readFileSync(join(process.cwd(), file), "utf8");
}

for (const check of exactChecks) {
	if (!read(check.file).includes(check.text)) {
		fail(`${check.file} does not contain ${check.text}`);
	}
}

for (const file of packageSurfaceFiles) {
	const text = read(file);
	if (text.includes("workspaces.plannotator.ai")) {
		fail(
			`${file} advertises the upstream Workspaces origin; the API origin is docs.palapala.me`,
		);
	}
	if (text.includes("api.tot.page")) {
		fail(`${file} advertises api.tot.page; the upstream alias is retired`);
	}
	if (text.includes("usercontent.plannotator.ai")) {
		fail(
			`${file} contains the old usercontent placeholder; content links belong on docs.palapala.me`,
		);
	}
}

console.log(
	`domain contract verified: CLI API ${EXPECTED_API_ENDPOINT}; content ${EXPECTED_CONTENT_ORIGIN}`,
);
