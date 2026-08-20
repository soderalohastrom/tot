#!/usr/bin/env node
// Thin alias shim — the `tot` binary now re-runs the `pala` CLI entrypoint
// so existing muscle memory (LaunchAgents, shell aliases, dashboard buttons)
// keeps working through the rebrand window. Logs nothing on its own; any
// error output comes from cli.ts.
import { main } from "./cli.js";

// process.exitCode, not process.exit(): long-running commands (the dashboard
// server) keep the event loop alive after main() resolves — a hard exit
// would kill them the moment the banner prints.
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