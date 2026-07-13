import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DASHBOARD_LABEL = "com.paumalu.tot-dashboard";
const SYNC_LABEL = "com.paumalu.tot-dashboard-sync";

export interface LaunchAgentDefinition {
	label: string;
	file: string;
	plist: string;
}

function xml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function argumentsXml(values: string[]): string {
	return values.map((value) => `\t\t<string>${xml(value)}</string>`).join("\n");
}

function plist(
	label: string,
	arguments_: string[],
	logFile: string,
	options: { keepAlive?: boolean; startInterval?: number },
): string {
	const scheduling = options.keepAlive
		? "\t<key>KeepAlive</key>\n\t<true/>"
		: `\t<key>StartInterval</key>\n\t<integer>${options.startInterval ?? 300}</integer>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xml(label)}</string>
	<key>ProgramArguments</key>
	<array>
${argumentsXml(arguments_)}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
${scheduling}
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>${xml(logFile)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

export function launchAgentDefinitions(
	totExecutable: string,
	home = os.homedir(),
): LaunchAgentDefinition[] {
	const launchAgents = path.join(home, "Library", "LaunchAgents");
	const logs = path.join(home, "Library", "Logs");
	return [
		{
			label: DASHBOARD_LABEL,
			file: path.join(launchAgents, `${DASHBOARD_LABEL}.plist`),
			plist: plist(
				DASHBOARD_LABEL,
				[totExecutable, "dashboard", "--no-open"],
				path.join(logs, "tot-dashboard.log"),
				{ keepAlive: true },
			),
		},
		{
			label: SYNC_LABEL,
			file: path.join(launchAgents, `${SYNC_LABEL}.plist`),
			plist: plist(
				SYNC_LABEL,
				[totExecutable, "dashboard", "sync", "--quiet"],
				path.join(logs, "tot-dashboard-sync.log"),
				{ startInterval: 300 },
			),
		},
	];
}

function launchctl(arguments_: string[], allowFailure = false): void {
	const result = spawnSync("launchctl", arguments_, { encoding: "utf8" });
	if (!allowFailure && result.status !== 0) {
		throw new Error(result.stderr.trim() || `launchctl ${arguments_[0]} failed`);
	}
}

function findTotExecutable(): string {
	const result = spawnSync("which", ["tot"], { encoding: "utf8" });
	if (result.status !== 0 || !result.stdout.trim()) {
		throw new Error("could not find tot on PATH");
	}
	return result.stdout.trim();
}

export function installDashboardLaunchAgents(
	totExecutable = findTotExecutable(),
): LaunchAgentDefinition[] {
	if (process.platform !== "darwin" || process.getuid === undefined) {
		throw new Error("LaunchAgent installation is only available on macOS");
	}
	const definitions = launchAgentDefinitions(totExecutable);
	for (const definition of definitions) {
		fs.mkdirSync(path.dirname(definition.file), { recursive: true });
		fs.mkdirSync(path.join(os.homedir(), "Library", "Logs"), { recursive: true });
		fs.writeFileSync(definition.file, definition.plist, { mode: 0o644 });
		const lint = spawnSync("plutil", ["-lint", definition.file], { encoding: "utf8" });
		if (lint.status !== 0) throw new Error(lint.stderr.trim() || "invalid LaunchAgent plist");
	}

	const domain = `gui/${process.getuid()}`;
	for (const definition of definitions) {
		launchctl(["bootout", `${domain}/${definition.label}`], true);
		launchctl(["bootstrap", domain, definition.file]);
	}
	return definitions;
}

export function uninstallDashboardLaunchAgents(): LaunchAgentDefinition[] {
	if (process.platform !== "darwin" || process.getuid === undefined) {
		throw new Error("LaunchAgent installation is only available on macOS");
	}
	const definitions = launchAgentDefinitions(findTotExecutable());
	const domain = `gui/${process.getuid()}`;
	for (const definition of definitions) {
		launchctl(["bootout", `${domain}/${definition.label}`], true);
		fs.rmSync(definition.file, { force: true });
	}
	return definitions;
}
