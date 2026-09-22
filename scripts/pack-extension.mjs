import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "apps", "extension");
const output = join(root, "dist", "extension");
const powershellPack = join(root, "scripts", "create-extension-zip.ps1");
const expectedEntries = [
  "background.js",
  "content.js",
  "manifest.json",
  "popup.html",
  "popup.js",
  "security.js",
  "stage-one.js",
  "stage-two.js",
  "stage-three.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png"
].sort();
const sourceManifest = JSON.parse(await readFile(
  join(source, "manifest.json"),
  "utf8"
));
const zip = join(root, "dist", `tabward-extension-${sourceManifest.version}.zip`);

async function filesUnder(directory, prefix = "") {
  const values = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = join(prefix, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      values.push(...await filesUnder(path, relativePath));
    } else if (entry.isFile()) {
      values.push(relativePath);
    } else {
      throw new Error(`Extension package source contains unsupported entry: ${relativePath}`);
    }
  }
  return values.sort();
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of expectedEntries) {
  const input = join(source, ...entry.split("/"));
  const target = join(output, ...entry.split("/"));
  if (!(await stat(input)).isFile()) {
    throw new Error(`Extension package source is not a file: ${entry}`);
  }
  await mkdir(resolve(target, ".."), { recursive: true });
  await copyFile(input, target);
}

const copiedEntries = await filesUnder(output);
if (JSON.stringify(copiedEntries) !== JSON.stringify(expectedEntries)) {
  throw new Error(`Extension package entries differ: ${copiedEntries.join(", ")}`);
}

const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
if (manifest.name !== "TabWard" || Number(manifest.minimum_chrome_version) < 116) {
  throw new Error("Invalid TabWard extension manifest");
}
if (manifest.permissions.includes("nativeMessaging")) {
  throw new Error("TabWard extension must not require nativeMessaging");
}
for (const icon of Object.values(manifest.icons || {})) {
  if (!expectedEntries.includes(String(icon))) {
    throw new Error(`Manifest icon is not in the exact package allowlist: ${icon}`);
  }
}

const info = await stat(join(output, "background.js"));
await rm(zip, { force: true });
const zipOutput = execFileSync("powershell.exe", [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  powershellPack,
  "-SourceDirectory",
  output,
  "-DestinationZip",
  zip
], { encoding: "utf8" });
const zipEntries = zipOutput
  .split(/\r?\n/)
  .map((value) => value.trim().replaceAll("\\", "/"))
  .filter(Boolean)
  .sort();
if (JSON.stringify(zipEntries) !== JSON.stringify(expectedEntries)) {
  throw new Error(`ZIP entries differ from the exact allowlist: ${zipEntries.join(", ")}`);
}

console.log(JSON.stringify({
  ok: true,
  output: relative(root, output).replaceAll("\\", "/"),
  zip: relative(root, zip).replaceAll("\\", "/"),
  files: expectedEntries.length,
  entriesVerified: true,
  backgroundBytes: info.size
}));
