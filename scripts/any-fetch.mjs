/** Build-time only: fetch a pinned official Any release, verify it, unpack its full runtime. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, mkdir, mkdtemp, writeFile, rm, rename, readdir, stat, chmod, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "electron/any-release.json"), "utf8"));
const platform = process.argv[2] ?? `${process.platform}-${process.arch}`;
const asset = manifest.assets[platform];
if (!asset) throw new Error(`No pinned Any ${manifest.version} release for ${platform}`);
const destination = path.join(root, "vendor/any", platform);
const executable = platform.startsWith("win32") ? "any.exe" : "any";

async function inventory(dir, prefix = "") {
  const result = {};
  for (const name of (await readdir(dir)).sort()) {
    const relative = path.posix.join(prefix, name);
    const absolute = path.join(dir, name);
    if ((await stat(absolute)).isDirectory()) Object.assign(result, await inventory(absolute, relative));
    else if (relative !== "verified.json") result[relative] = createHash("sha256").update(await readFile(absolute)).digest("hex");
  }
  return result;
}

try {
  const prior = JSON.parse(await readFile(path.join(destination, "verified.json"), "utf8"));
  if (prior.archiveSha256 === asset.sha256 && prior.version === manifest.version && JSON.stringify(await inventory(destination)) === JSON.stringify(prior.files)) {
    console.log(`Verified Any ${manifest.version}: ${destination}`);
    process.exit(0);
  }
} catch { /* Missing or modified cache: verify a fresh official archive. */ }

await mkdir(path.dirname(destination), { recursive: true });
const scratch = await mkdtemp(path.join(path.dirname(destination), ".download-"));
try {
  const url = `https://github.com/anyproto/any/releases/download/v${manifest.version}/${asset.file}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Any release download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("Any release SHA-256 does not match the pinned manifest");
  const archive = path.join(scratch, asset.file);
  await writeFile(archive, bytes);
  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  if (listing.status !== 0 || listing.stdout.split("\n").some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) throw new Error("Invalid Any release archive");
  const extracted = path.join(scratch, "extracted");
  await mkdir(extracted);
  const unpacked = spawnSync("tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8" });
  if (unpacked.status !== 0) throw new Error(`Cannot unpack Any release: ${unpacked.stderr}`);
  // Official release tarballs have one top-level directory; normalize the resource path.
  let runtime = extracted;
  try { await stat(path.join(runtime, executable)); }
  catch {
    const top = await readdir(extracted);
    if (top.length !== 1) throw new Error("Unexpected Any release layout");
    runtime = path.join(extracted, top[0]);
    await stat(path.join(runtime, executable));
  }
  if (!platform.startsWith("win32")) await chmod(path.join(runtime, executable), 0o755);
  await copyFile(path.join(root, "electron/any-LICENSE"), path.join(runtime, "LICENSE-Any"));
  const files = await inventory(runtime);
  await writeFile(path.join(runtime, "verified.json"), JSON.stringify({ version: manifest.version, commit: manifest.commit, archiveSha256: asset.sha256, files }, null, 2));
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(runtime, destination);
  console.log(`Verified Any ${manifest.version}: ${destination}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
