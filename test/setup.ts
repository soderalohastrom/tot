// CLI tests run in plain node. No global setup is required beyond ensuring no
// test accidentally reads the developer's real ~/.tot: each Config test sets
// TOT_CONFIG to a temp path. We assert that here as a guard.
import { afterEach } from "vitest";

// worker/index.ts uses the workerd-only FixedLengthStream global. Plain-node
// tests only need its pass-through behavior, not its length bookkeeping.
const nodeGlobal = globalThis as { FixedLengthStream?: typeof FixedLengthStream };
nodeGlobal.FixedLengthStream ??= class extends TransformStream {
	constructor(_expectedLength: number) {
		super();
	}
} as unknown as typeof FixedLengthStream;

afterEach(() => {
	// Leave no TOT_CONFIG bleeding into the next test file.
	delete process.env.TOT_CONFIG;
});
