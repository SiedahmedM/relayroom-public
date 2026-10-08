import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MARKER = "--managed-hook relayroom";
const EVENTS = ["SessionStart", "PostToolUse", "PreCompact", "Stop"] as const;

type JsonObject = Record<string, any>;

async function readJson(path: string): Promise<JsonObject> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object.`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeJson(path: string, value: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function quote(value: string): string {
  if (process.platform !== "win32") return `'${value.replaceAll("'", "'\\''")}'`;
  // Windows command shells expand percent and delayed-expansion markers even
  // inside quotes. Reject such install paths instead of changing their meaning.
  if (/["%!\r\n]/.test(value)) throw new Error("Windows hook paths cannot contain quotes, %, !, or newlines.");
  return `"${value}"`;
}

function command(nodePath: string, cliPath: string, vendor: string): string {
  return `${quote(nodePath)} ${quote(cliPath)} hook ${vendor} ${MARKER}`;
}

function codexWindowsCommand(nodePath: string, cliPath: string): string {
  // PowerShell needs an invocation operator before a quoted executable path.
  // Encoding preserves literal paths through the vendor's outer shell.
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = `& ${literal(nodePath)} ${literal(cliPath)} hook codex ${MARKER}; exit $LASTEXITCODE`;
  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

function removeManagedNested(groups: unknown): any[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    if (!group || typeof group !== "object") return [group];
    const hooks = Array.isArray(group.hooks)
      ? group.hooks.filter((hook: any) => typeof hook?.command !== "string" || !hook.command.includes(MARKER))
      : [];
    return hooks.length ? [{ ...group, hooks }] : [];
  });
}

function installNested(config: JsonObject, vendor: "codex" | "claude", nodePath: string, cliPath: string): JsonObject {
  const hooks = config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks) ? { ...config.hooks } : {};
  for (const event of EVENTS) hooks[event] = removeManagedNested(hooks[event]);
  const fast = (event: string) => ({
    type: "command",
    command: command(nodePath, cliPath, vendor),
    ...(vendor === "codex" ? { commandWindows: codexWindowsCommand(nodePath, cliPath) } : {}),
    timeout: 15,
    statusMessage: `RelayRoom: ${event}`,
  });
  hooks.SessionStart.push({ matcher: "startup|resume|compact", hooks: [fast("restoring room workdoc")] });
  hooks.PostToolUse.push({ hooks: [fast("checking tagged priority messages")] });
  hooks.PreCompact.push({ matcher: "manual|auto", hooks: [fast("preserving room checkpoint")] });
  hooks.Stop.push({ hooks: [{
    type: "command",
    command: command(nodePath, cliPath, vendor),
    ...(vendor === "codex" ? { commandWindows: codexWindowsCommand(nodePath, cliPath) } : {}),
    timeout: 604_800,
    statusMessage: "RelayRoom: waiting for teammates",
  }] });
  return { ...config, hooks };
}

function installCursor(config: JsonObject, nodePath: string, cliPath: string): JsonObject {
  const hooks = config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks) ? { ...config.hooks } : {};
  const cursorEvents: Record<string, { timeout: number; loop_limit?: null }> = {
    sessionStart: { timeout: 15 },
    postToolUse: { timeout: 15 },
    preCompact: { timeout: 15 },
    stop: { timeout: 604_800, loop_limit: null },
  };
  for (const [event, settings] of Object.entries(cursorEvents)) {
    const existing = Array.isArray(hooks[event])
      ? hooks[event].filter((hook: any) => typeof hook?.command !== "string" || !hook.command.includes(MARKER))
      : [];
    hooks[event] = [...existing, { command: command(nodePath, cliPath, "cursor"), ...settings }];
  }
  return { ...config, version: config.version ?? 1, hooks };
}

export async function installHooks(
  target: string,
  nodePath: string,
  cliPath: string,
  homeDirectory = homedir(),
): Promise<Array<{ vendor: string; path: string }>> {
  const destinations: Record<string, string> = {
    codex: join(homeDirectory, ".codex", "hooks.json"),
    claude: join(homeDirectory, ".claude", "settings.json"),
    cursor: join(homeDirectory, ".cursor", "hooks.json"),
  };
  const selected = target === "all" ? Object.keys(destinations) : [target];
  for (const vendor of selected) if (!destinations[vendor]) throw new Error("Target must be codex, cursor, claude, or all.");
  const installed: Array<{ vendor: string; path: string }> = [];
  for (const vendor of selected) {
    const path = destinations[vendor]!;
    const current = await readJson(path);
    const next = vendor === "cursor"
      ? installCursor(current, nodePath, cliPath)
      : installNested(current, vendor as "codex" | "claude", nodePath, cliPath);
    await writeJson(path, next);
    installed.push({ vendor, path });
  }
  return installed;
}
