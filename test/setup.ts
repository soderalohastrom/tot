// CLI tests run in plain node. No global setup is required beyond ensuring no
// test accidentally reads the developer's real ~/.tot: each Config test sets
// TOT_CONFIG to a temp path. We assert that here as a guard.
import { afterEach } from "vitest";

afterEach(() => {
	// Leave no TOT_CONFIG bleeding into the next test file.
	delete process.env.TOT_CONFIG;
});
