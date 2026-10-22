import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const parent = resolve(root, "..");
const pnpm = process.env.npm_execpath;
function run(dir, args) {
  const result = spawnSync(
    pnpm
      ? process.execPath
      : process.platform === "win32"
        ? "pnpm.cmd"
        : "pnpm",
    pnpm ? [pnpm, ...args] : args,
    {
      cwd: dir,
      stdio: "inherit",
      shell: !pnpm && process.platform === "win32",
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const dirs = [
  resolve(parent, "PluHub-Spec"),
  root,
  resolve(parent, "PluHub-Plugins"),
];
if (process.argv[2] === "bootstrap")
  for (const dir of dirs) run(dir, ["install", "--frozen-lockfile"]);
else if (process.argv[2] === "build")
  for (const dir of dirs) run(dir, ["build"]);
else if (process.argv[2] === "test") {
  for (const dir of dirs) run(dir, ["test"]);
  const go = spawnSync("go", ["test", "./..."], {
    cwd: resolve(parent, "PluHub-SDK-Go"),
    stdio: "inherit",
  });
  process.exit(go.status ?? 1);
} else throw new Error("Expected bootstrap, build or test");
