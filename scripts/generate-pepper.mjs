import { randomBytes, randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(".env");
const text = await readFile(path, "utf8");
if ((text.match(/^RELAYROOM_SECRET_PEPPER=/gm) ?? []).length !== 1 || !/^RELAYROOM_SECRET_PEPPER=[\t ]*\r?$/m.test(text)) {
  throw new Error("Expected exactly one empty RELAYROOM_SECRET_PEPPER in .env; refusing to replace an existing secret.");
}
const temporary = `${path}.${randomUUID()}.tmp`;
try {
  const value = randomBytes(32).toString("hex");
  await writeFile(temporary, text.replace(/^RELAYROOM_SECRET_PEPPER=[\t ]*\r?$/m, `RELAYROOM_SECRET_PEPPER=${value}`), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
} finally {
  await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
}
console.log("Wrote a random pepper to .env. Keep this file private and preserve it with your database.");
