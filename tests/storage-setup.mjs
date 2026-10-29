// Node's test workers must not share a writable workspace. Inherited helpers
// deliberately keep their parent's directory (for restart/recovery tests).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.env.NODE_TEST_CONTEXT && !process.env.LH_DATA_DIR) {
	const directory = mkdtempSync(path.join(tmpdir(), "lh-test-workspace-"));
	process.env.LH_DATA_DIR = directory;
	process.env.LH_AUTH_FILE ??= path.join(directory, "auth.json");
	process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
}
