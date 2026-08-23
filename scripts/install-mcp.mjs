import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

if (process.platform !== "win32") {
  throw new Error("TabWard supports the automated MCP installer on Windows only");
}

const root = resolve(import.meta.dirname, "..");
const packageDirectory = join(root, "packages", "mcp");
const packageJson = JSON.parse(await readFile(
  join(packageDirectory, "package.json"),
  "utf8"
));
const tempDirectory = join(root, ".factory", "temp");
const archive = join(tempDirectory, `tabward-mcp-${packageJson.version}.tgz`);
const npmCli = process.env.npm_execpath || join(
  resolve(process.execPath, ".."),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js"
);
const npmEnvironment = { ...process.env };
delete npmEnvironment.npm_config_prefix;
delete npmEnvironment.NPM_CONFIG_PREFIX;

await mkdir(tempDirectory, { recursive: true });
await rm(archive, { force: true });
await access(npmCli);

function run(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: npmEnvironment
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exit(result.status ?? 1);
  }
  return result;
}

try {
  const packed = run([
    "pack",
    packageDirectory,
    "--pack-destination",
    tempDirectory
  ]);
  process.stdout.write(packed.stdout || "");
  process.stderr.write(packed.stderr || "");

  const installed = run(["install", "--global", archive]);
  process.stdout.write(installed.stdout || "");
  process.stderr.write(installed.stderr || "");
} finally {
  await rm(archive, { force: true });
}

const npmRootResult = run(["root", "--global"]);
const npmRoot = npmRootResult.stdout.trim();
const serverPath = join(
  npmRoot,
  "@tabward",
  "mcp",
  "dist",
  "index.js"
).replaceAll("\\", "/");
const installedManifest = JSON.parse(await readFile(
  join(npmRoot, "@tabward", "mcp", "package.json"),
  "utf8"
));
if (installedManifest.version !== packageJson.version) {
  throw new Error(
    `Installed @tabward/mcp version ${installedManifest.version} does not match ${packageJson.version}`
  );
}
await access(serverPath);

console.log(JSON.stringify({
  ok: true,
  package: `${packageJson.name}@${packageJson.version}`,
  serverPath,
  factoryCommand: `droid mcp add tabward node ${serverPath}`
}));
