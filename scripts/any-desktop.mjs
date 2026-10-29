/** Run the isolated preview against the locally built standalone payload. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const environment = { ...process.env, LH_ANY_PREVIEW: "1" };
delete environment.LH_DEV_URL;
const child = spawn(process.execPath, [require.resolve("electron/cli.js"), "."], { env: environment, stdio: "inherit" });
child.once("error", () => { process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
