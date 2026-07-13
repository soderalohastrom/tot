import path from "node:path";
import { describe, expect, it } from "vitest";

import { launchAgentDefinitions } from "../src/launch-agent.js";

describe("dashboard LaunchAgents", () => {
	it("generates a persistent local server and a five-minute cloud sync job", () => {
		const definitions = launchAgentDefinitions("/opt/homebrew/bin/tot", "/Users/test");

		expect(definitions).toHaveLength(2);
		expect(definitions[0]).toMatchObject({
			label: "com.paumalu.tot-dashboard",
			file: path.join("/Users/test", "Library/LaunchAgents/com.paumalu.tot-dashboard.plist"),
		});
		expect(definitions[0]?.plist).toContain("<key>KeepAlive</key>");
		expect(definitions[0]?.plist).toContain("<string>--no-open</string>");
		expect(definitions[1]?.plist).toContain("<key>StartInterval</key>");
		expect(definitions[1]?.plist).toContain("<integer>300</integer>");
		expect(definitions[1]?.plist).toContain("<string>sync</string>");
		expect(definitions[1]?.plist).toContain("<string>--quiet</string>");
	});

	it("escapes paths before embedding them in XML", () => {
		const [definition] = launchAgentDefinitions("/path/with&symbol/tot", "/Users/test");
		expect(definition?.plist).toContain("/path/with&amp;symbol/tot");
	});
});
