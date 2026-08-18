#!/usr/bin/env node
// Thin alias shim — the `tot` binary now re-runs the `pala` CLI entrypoint
// so existing muscle memory (LaunchAgents, shell aliases, dashboard buttons)
// keeps working through the rebrand window. Logs nothing on its own; any
// error output comes from cli.ts.
import { main } from "./cli.js";

main().then((code) => {
	process.exit(code ?? 0);
});