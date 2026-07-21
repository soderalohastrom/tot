#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	listCommand,
	loginCommand,
	publishCommand,
	removeCommand,
	updateCommand,
	type CommandDeps,
} from "./commands.js";
import { Config } from "./config.js";
import {
	backupCloudDashboard,
	cloudAccessCredentials,
	cloudSyncToken,
	loadCloudSyncSettings,
	restoreCloudDashboard,
	saveCloudSyncSettings,
	saveCloudSyncToken,
	syncCloudDashboard,
} from "./cloud-sync.js";
import { DEFAULT_DASHBOARD_HOST, DEFAULT_DASHBOARD_PORT, startDashboard } from "./dashboard.js";
import { createHttpClient } from "./http.js";
import { installDashboardLaunchAgents, uninstallDashboardLaunchAgents } from "./launch-agent.js";
import type { OgMeta } from "./og.js";
import { normalizeProjectSlug } from "./projects.js";

interface ParsedArgs {
	_: string[];
	flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
	const out: ParsedArgs = { _: [], flags: {} };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) {
				out.flags[key] = true;
			} else {
				out.flags[key] = next;
				i++;
			}
		} else {
			out._.push(a);
		}
	}
	return out;
}

function flagStr(flags: Record<string, string | true>, name: string): string | undefined {
	const v = flags[name];
	return typeof v === "string" ? v : undefined;
}

const HELP = `tot — publish a page to tot.page

  tot <file>              publish a raw markdown or html file
  tot update <file|url>   push new content to the same living URL
  tot remove <file|url>   delete a page (anyone with the link can; so can you)
  tot list                list pages you've published from this machine
  tot dashboard           browse your published pages at localhost
  tot dashboard sync      mirror local pages to the configured cloud dashboard
  tot dashboard backup    download a restorable cloud archive
  tot dashboard restore   restore the cloud mirror from an archive
  tot dashboard tag <slug|url> <project>    tag a page into a client reading room
  tot dashboard untag <slug|url> <project>  remove a project tag from a page
  tot dashboard tags [<slug|url>]           list project tags (all pages, or one)
  tot login --key <KEY>   save a pre-minted wsk_live_ key to ~/.tot (optional)

flags
  --endpoint <url>     override the API origin (default https://workspaces.plannotator.ai)
  --key <KEY>          API key for this run (login persists it)
  --title <text>       inject <title>/og:title/twitter:title into an .html file's <head>
  --description <text> inject description/og:description/twitter:description
  --image <url>        inject og:image/twitter:image (absolute https URL)
  --no-image           skip auto-generating a title/description banner when --title is set
  --url <url>          inject og:url (on 'update' this defaults to the page's living URL)
  --host <host>        dashboard bind address (default ${DEFAULT_DASHBOARD_HOST})
  --port <port>        dashboard port (default ${DEFAULT_DASHBOARD_PORT})
  --no-open            start the dashboard without opening a browser
  --cloud <url>        cloud dashboard URL for configure/sync
  --quiet              suppress per-page cloud sync progress
  --help               show this help

Passing --title without --image auto-generates a colored 1200×630 banner
(title + description) and publishes it as the og:image/twitter:image.`;

function ogMetaFromFlags(flags: Record<string, string | true>): OgMeta | undefined {
	const title = flagStr(flags, "title");
	const description = flagStr(flags, "description");
	const image = flagStr(flags, "image");
	const url = flagStr(flags, "url");
	if (title === undefined) {
		if (description !== undefined || image !== undefined || url !== undefined) {
			throw new Error("--title is required when passing --description/--image/--url");
		}
		return undefined;
	}
	return { title, description, image, url };
}

function makeDeps(cfg: Config): CommandDeps {
	return {
		http: createHttpClient(cfg),
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		now: () => Date.now(),
		log: (msg) => console.log(msg),
	};
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	const args = parseArgs(argv);
	const cfg = Config.load();

	if (flagStr(args.flags, "endpoint")) {
		cfg.endpoint = flagStr(args.flags, "endpoint")!;
	}
	if (flagStr(args.flags, "key")) {
		cfg.key = flagStr(args.flags, "key")!;
	}

	const cmd = args._[0];

	if (!cmd || cmd === "help" || args.flags.help === true) {
		console.log(HELP);
		return 0;
	}

	const deps = makeDeps(cfg);

	if (cmd === "login") {
		const key = flagStr(args.flags, "key") ?? cfg.key ?? undefined;
		if (!key) {
			console.error("provide a key:  tot login --key <KEY>");
			return 1;
		}
		await loginCommand(key, cfg, deps);
		return 0;
	}

	if (cmd === "list") {
		listCommand(cfg, deps);
		return 0;
	}

	if (cmd === "dashboard" || cmd === "dash") {
		const dashboardCommand = args._[1];
		if (dashboardCommand === "configure") {
			const endpoint = flagStr(args.flags, "cloud") ?? args._[2];
			const token = process.env.TOT_DASHBOARD_SYNC_TOKEN;
			if (!endpoint) throw new Error("usage: tot dashboard configure <cloud-url>");
			if (!token) {
				throw new Error("set TOT_DASHBOARD_SYNC_TOKEN before configuring cloud sync");
			}
			if (process.platform === "darwin") saveCloudSyncToken(endpoint, token);
			const settings = saveCloudSyncSettings(endpoint);
			console.log(`cloud dashboard configured  ${settings.endpoint}`);
			return 0;
		}
		if (dashboardCommand === "sync") {
			const settings = loadCloudSyncSettings();
			const endpoint = flagStr(args.flags, "cloud") ?? settings?.endpoint;
			if (!endpoint) {
				throw new Error("configure cloud sync first: tot dashboard configure <cloud-url>");
			}
			const token = cloudSyncToken(endpoint);
			if (!token) throw new Error("cloud sync token was not found in Keychain");
			const access = cloudAccessCredentials(endpoint);
			if (!access) throw new Error("Cloudflare Access service credentials were not found");
			const result = await syncCloudDashboard(
				{ endpoint, token, access, registry: cfg.registry },
				{
					fetch,
					now: () => new Date(),
					log: args.flags.quiet === true ? () => {} : (message) => console.log(message),
				},
			);
			console.log(
				`cloud dashboard synced  ${result.count} tots, ${result.objectsUploaded} new objects, manifest ${result.manifestUpdated ? "updated" : "unchanged"}`,
			);
			return 0;
		}
		if (dashboardCommand === "backup") {
			const settings = loadCloudSyncSettings();
			const endpoint = flagStr(args.flags, "cloud") ?? settings?.endpoint;
			if (!endpoint) throw new Error("cloud dashboard URL is required (--cloud <url>)");
			const token = cloudSyncToken(endpoint);
			if (!token) throw new Error("cloud sync token was not found");
			const access = cloudAccessCredentials(endpoint);
			if (!access) throw new Error("Cloudflare Access service credentials were not found");
			const directory = args._[2] ?? path.join(process.cwd(), "tot-dashboard-backup");
			const result = await backupCloudDashboard({ endpoint, token, access, directory });
			console.log(
				`cloud backup complete  ${result.count} tots, ${result.downloaded} downloaded  ${result.directory}`,
			);
			return 0;
		}
		if (dashboardCommand === "restore") {
			const settings = loadCloudSyncSettings();
			const endpoint = flagStr(args.flags, "cloud") ?? settings?.endpoint;
			if (!endpoint) throw new Error("cloud dashboard URL is required (--cloud <url>)");
			const token = cloudSyncToken(endpoint);
			if (!token) throw new Error("cloud sync token was not found");
			const access = cloudAccessCredentials(endpoint);
			if (!access) throw new Error("Cloudflare Access service credentials were not found");
			const directory = args._[2] ?? path.join(process.cwd(), "tot-dashboard-backup");
			const result = await restoreCloudDashboard(
				{ endpoint, token, access, directory },
				{
					fetch,
					now: () => new Date(),
					log: args.flags.quiet === true ? () => {} : (message) => console.log(message),
				},
			);
			console.log(
				`cloud restore complete  ${result.count} tots, ${result.uploaded} uploaded  ${result.directory}`,
			);
			return 0;
		}
		if (dashboardCommand === "install-agent") {
			const definitions = installDashboardLaunchAgents();
			console.log(`installed ${definitions.length} LaunchAgents (dashboard + 5-minute sync)`);
			return 0;
		}
		if (dashboardCommand === "uninstall-agent") {
			const definitions = uninstallDashboardLaunchAgents();
			console.log(`removed ${definitions.length} Tot Dashboard LaunchAgents`);
			return 0;
		}
		if (dashboardCommand === "tag" || dashboardCommand === "untag") {
			const target = args._[2];
			const project = args._[3];
			if (!target || !project) {
				throw new Error(`usage: tot dashboard ${dashboardCommand} <slug|url> <project>`);
			}
			const slug = normalizeProjectSlug(project);
			if (!slug) throw new Error(`invalid project slug: ${project}`);
			const resolved = cfg.resolve(target);
			if (!resolved) throw new Error(`no published page matches: ${target}`);
			const current = resolved.entry.projects ?? [];
			const next =
				dashboardCommand === "tag"
					? [...current, slug]
					: current.filter((existing) => existing !== slug);
			// updateDashboardEntry normalizes the set; null clears the field entirely.
			cfg.updateDashboardEntry(resolved.entry.slug, {
				projects: next.length > 0 ? next : null,
			});
			cfg.save();
			const tags = resolved.entry.projects ?? [];
			console.log(
				`${resolved.entry.slug}  ${dashboardCommand === "tag" ? "tagged" : "untagged"} ${slug}  (projects: ${tags.join(", ") || "none"})`,
			);
			return 0;
		}
		if (dashboardCommand === "tags") {
			const target = args._[2];
			const entries = target
				? [cfg.resolve(target)?.entry ?? null]
				: Object.values(cfg.registry).sort((a, b) =>
						b.createdAt.localeCompare(a.createdAt),
					);
			if (entries.length === 1 && entries[0] === null) {
				throw new Error(`no published page matches: ${target}`);
			}
			for (const entry of entries) {
				if (!entry) continue;
				console.log(
					`${entry.slug}  ${(entry.projects ?? []).join(", ") || "(no projects)"}`,
				);
			}
			return 0;
		}
		const portValue = flagStr(args.flags, "port");
		if (portValue !== undefined && !/^\d+$/.test(portValue)) {
			throw new Error(`invalid dashboard port: ${portValue}`);
		}
		const port = portValue === undefined ? DEFAULT_DASHBOARD_PORT : Number(portValue);
		if (!Number.isInteger(port) || port < 1 || port > 65_535) {
			throw new Error(`invalid dashboard port: ${portValue}`);
		}
		const instance = await startDashboard({
			host: flagStr(args.flags, "host") ?? DEFAULT_DASHBOARD_HOST,
			port,
			open: args.flags["no-open"] !== true,
			admin: {
				update: async (slug, patch) => {
					const current = Config.load();
					const updated = current.updateDashboardEntry(slug, patch);
					if (updated) current.save();
					return updated;
				},
				remove: async (slug) => {
					const current = Config.load();
					if (!current.resolve(slug)) return false;
					await removeCommand(slug, current, makeDeps(current));
					return true;
				},
			},
		});
		console.log(`tot dashboard  ${instance.url}`);
		return 0;
	}

	if (cmd === "update") {
		const target = args._[1];
		if (!target) {
			console.error("usage: tot update <file|url>");
			return 1;
		}
		await updateCommand(target, cfg, deps, {
			og: ogMetaFromFlags(args.flags),
			noAutoImage: args.flags["no-image"] === true,
		});
		return 0;
	}

	if (cmd === "remove" || cmd === "rm" || cmd === "delete") {
		const target = args._[1];
		if (!target) {
			console.error("usage: tot remove <file|url>");
			return 1;
		}
		await removeCommand(target, cfg, deps);
		return 0;
	}

	// Default: the first positional is a file to publish.
	await publishCommand(cmd, cfg, deps, {
		og: ogMetaFromFlags(args.flags),
		noAutoImage: args.flags["no-image"] === true,
	});
	return 0;
}

function realPathForEntrypoint(value: string): string {
	const absolute = path.resolve(value);
	try {
		return fs.realpathSync(absolute);
	} catch {
		return absolute;
	}
}

export function isCliEntrypoint(
	metaUrl: string,
	argv1: string | undefined = process.argv[1],
): boolean {
	if (argv1 === undefined) return false;
	return realPathForEntrypoint(fileURLToPath(metaUrl)) === realPathForEntrypoint(argv1);
}

// Only run when invoked as the CLI, not when imported (e.g. by tests).
if (isCliEntrypoint(import.meta.url)) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("error:", msg);
			process.exitCode = 1;
		},
	);
}
