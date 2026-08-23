import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "apps", "extension");
const output = join(root, "dist", "extension");
const sourceManifest = JSON.parse(await readFile(
  join(root, "apps", "extension", "manifest.json"),
  "utf8"
));
const zip = join(root, "dist", `tabward-extension-${sourceManifest.version}.zip`);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
if (manifest.name !== "TabWard" || Number(manifest.minimum_chrome_version) < 116) {
  throw new Error("Invalid TabWard extension manifest");
}
if (manifest.permissions.includes("nativeMessaging")) {
  throw new Error("TabWard extension must not require nativeMessaging");
}
const info = await stat(join(output, "background.js"));
await rm(zip, { force: true });
execFileSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  `Compress-Archive -LiteralPath '${output}\\*' -DestinationPath '${zip}' -Force`
], { stdio: "inherit" });
const entries = await readdir(output);
if (!entries.includes("manifest.json")) {
  throw new Error("Packaged extension root is missing manifest.json");
}
console.log(JSON.stringify({
  ok: true,
  output,
  zip,
  files: entries.length,
  backgroundBytes: info.size
}));
