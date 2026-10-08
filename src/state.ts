import { chmod, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionCredentials } from "./model.js";

export interface Profile extends SessionCredentials {
  lastDeliveredSeq: number;
  lastProcessedSeq: number;
  createdAt: string;
  role?: string;
  vendor?: string;
  device?: string;
  cwd?: string;
  interruptSeverity?: number;
  hookVendor?: string;
  hookSessionId?: string;
  lastInterruptScanSeq?: number;
  lastWaitScanSeq?: number;
  lastStopWorkdocVersion?: number;
  lastHookCheckAt?: string;
  leftAt?: string;
}

interface StateFile {
  version: 1;
  profiles: Record<string, Profile>;
  settings?: {
    server?: string;
  };
}

export function statePath(): string {
  if (process.env.RELAYROOM_STATE) return process.env.RELAYROOM_STATE;
  const root = process.env.RELAYROOM_HOME
    ?? (process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "RelayRoom")
      : process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME, "relayroom") : undefined)
    ?? join(homedir(), ".relayroom");
  return root.endsWith(".json") ? root : join(root, "state.json");
}

export async function loadState(): Promise<StateFile> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8")) as StateFile;
    if (parsed.version !== 1 || !parsed.profiles) throw new Error("Unsupported state version.");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: {} };
    throw error;
  }
}

export async function saveState(state: StateFile): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${statePath()}.lock`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Age cannot distinguish a crashed writer from a suspended live process.
      // Fail with a recovery instruction instead of stealing another writer's lock.
      if (Date.now() >= deadline) {
        throw new Error(`State is locked: ${lockPath}. Stop all RelayRoom CLI/hook processes before removing a leftover lock directory.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function putProfile(name: string, profile: Profile): Promise<void> {
  await withStateLock(async () => {
    const state = await loadState();
    state.profiles[name] = profile;
    await saveState(state);
  });
}

export async function updateProfile(name: string, update: Partial<Profile>): Promise<Profile> {
  return withStateLock(async () => {
    const state = await loadState();
    const profile = state.profiles[name];
    if (!profile) throw new Error(`Unknown profile '${name}'.`);
    const monotonic = ["lastDeliveredSeq", "lastProcessedSeq", "lastInterruptScanSeq", "lastWaitScanSeq", "lastStopWorkdocVersion"] as const;
    for (const field of monotonic) {
      const value = update[field];
      if (value !== undefined) profile[field] = Math.max(profile[field] ?? 0, value);
    }
    const remaining = { ...update };
    for (const field of monotonic) delete remaining[field];
    Object.assign(profile, remaining);
    await saveState(state);
    return profile;
  });
}

export async function removeProfile(name: string): Promise<void> {
  await withStateLock(async () => {
    const state = await loadState();
    delete state.profiles[name];
    await saveState(state);
  });
}

export async function resolveProfile(requested?: string): Promise<{ name: string; profile: Profile }> {
  const state = await loadState();
  const name = requested ?? process.env.RELAYROOM_PROFILE;
  if (name) {
    const profile = state.profiles[name];
    if (!profile) throw new Error(`Unknown profile '${name}'. Available: ${Object.keys(state.profiles).join(", ") || "none"}.`);
    return { name, profile };
  }
  const entries = Object.entries(state.profiles);
  if (entries.length === 1) return { name: entries[0]![0], profile: entries[0]![1] };
  if (entries.length === 0) throw new Error("No room profile exists. Run 'relayroom create' or 'relayroom join'.");
  throw new Error(`More than one profile exists. Pass --profile NAME. Available: ${entries.map(([key]) => key).join(", ")}.`);
}

export async function listProfiles(): Promise<Array<{ name: string; profile: Profile }>> {
  return Object.entries((await loadState()).profiles).map(([name, profile]) => ({ name, profile }));
}

function normalizedCwd(value?: string): string | undefined {
  if (!value) return undefined;
  const collapsed = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? collapsed.toLowerCase() : collapsed;
}

export async function resolveHookProfile(
  vendor: string,
  sessionId: string,
  cwd?: string,
  requestedProfile?: string,
): Promise<{ name: string; profile: Profile } | undefined> {
  return withStateLock(async () => {
    const state = await loadState();
    const exact = Object.entries(state.profiles).find(([, profile]) => !profile.leftAt && profile.hookVendor === vendor && profile.hookSessionId === sessionId);
    if (exact) return { name: exact[0], profile: exact[1] };

    const requested = requestedProfile ? state.profiles[requestedProfile] : undefined;
    if (requested && !requested.leftAt && requested.vendor === vendor && (!requested.hookSessionId || requested.hookSessionId === sessionId)) {
      requested.hookVendor = vendor;
      requested.hookSessionId = sessionId;
      await saveState(state);
      return { name: requestedProfile!, profile: requested };
    }

    // Bind once: prefer an exact working-directory match, then the newest
    // unclaimed profile. Later hooks use the stable session ID above.
    const unclaimed = Object.entries(state.profiles)
      .filter(([, profile]) => !profile.leftAt && !profile.hookSessionId && profile.vendor === vendor);
    if (unclaimed.length === 0) {
      console.error(
        `relayroom hook: no unclaimed '${vendor}' profile to bind for session ${sessionId}. ` +
        "If this session should be in a room, run 'relayroom join CODE --as NAME --profile NAME'; see 'relayroom profiles'.",
      );
      return undefined;
    }
    const wanted = normalizedCwd(cwd);
    const matching = wanted ? unclaimed.filter(([, profile]) => normalizedCwd(profile.cwd) === wanted) : [];
    const pool = matching.length > 0 ? matching : unclaimed;
    pool.sort((left, right) => right[1].createdAt.localeCompare(left[1].createdAt));
    if (pool.length > 1) {
      console.error(
        `relayroom hook: ${pool.length} unclaimed '${vendor}' profiles (${pool.map(([key]) => key).join(", ")}); ` +
        `binding the newest, '${pool[0]![0]}'. Remove stray profiles with 'relayroom leave --profile NAME'.`,
      );
    }
    const selected = pool[0]!;
    selected[1].hookVendor = vendor;
    selected[1].hookSessionId = sessionId;
    await saveState(state);
    return { name: selected[0], profile: selected[1] };
  });
}

export async function setDefaultServer(server: string): Promise<void> {
  await withStateLock(async () => {
    const state = await loadState();
    state.settings = { ...state.settings, server: server.replace(/\/$/, "") };
    await saveState(state);
  });
}

export async function getDefaultServer(): Promise<string | undefined> {
  return (await loadState()).settings?.server;
}
