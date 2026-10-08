import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const dist = new URL("dist/", root);
await rm(dist, { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(new URL("node_modules/typescript/bin/tsc", root)), "-p", "tsconfig.build.json"], {
  cwd: fileURLToPath(root), stdio: "inherit",
});
await mkdir(new URL("dist/skills/relayroom/", root), { recursive: true });
await cp(new URL("skills/relayroom/SKILL.md", root), new URL("dist/skills/relayroom/SKILL.md", root));
