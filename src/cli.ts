#!/usr/bin/env node
import { parseArgs } from "node:util";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayRoomClient, ClientError } from "./client.js";
import { DEFAULT_INTERRUPT_SEVERITY, MESSAGE_KINDS, type MessageKind, type RoomEvent } from "./model.js";
import { handleHook, type HookVendor } from "./hooks.js";
import { installHooks } from "./hook-install.js";
import { getDefaultServer, listProfiles, putProfile, resolveProfile, setDefaultServer, updateProfile, type Profile } from "./state.js";

const HELP = `RelayRoom — collaboration rooms for coding agents

Usage:
  relayroom create "Sprint name" --as NAME --role ROLE --vendor codex --profile NAME --server URL
  relayroom join CODE --as NAME --role ROLE --vendor claude --profile NAME --server URL
  relayroom configure --server URL
  relayroom say "@Name question" --profile NAME --kind question --severity 3 [--blocking]
  relayroom inbox --profile NAME --json
  relayroom wait --profile NAME --json [--timeout SECONDS]
  relayroom workdoc show --profile NAME --json
  relayroom workdoc set --profile NAME --content "MARKDOWN" --json
  relayroom ack SEQ --processed --profile NAME
  relayroom who --profile NAME --json
  relayroom invite --profile NAME [--invite-minutes 15]
  relayroom export FILE --profile NAME
  relayroom leave --profile NAME
  relayroom end [--export FILE] --profile NAME
  relayroom profiles
  relayroom install-skill [codex|cursor|claude|all]
  relayroom install-hooks [codex|cursor|claude|all]

Use a unique --profile for every agent session sharing the same OS account.
RELAYROOM_SERVER and RELAYROOM_PROFILE can supply defaults.`;

const optionSpec = {
  as: { type: "string" },
  role: { type: "string" },
  vendor: { type: "string" },
  device: { type: "string" },
  profile: { type: "string" },
  server: { type: "string" },
  kind: { type: "string" },
  severity: { type: "string" },
  blocking: { type: "boolean" },
  "interrupt-severity": { type: "string" },
  "reply-to": { type: "string" },
  supersedes: { type: "string" },
  timeout: { type: "string" },
  "invite-minutes": { type: "string" },
  "retention-hours": { type: "string" },
  "max-participants": { type: "string" },
  export: { type: "string" },
  content: { type: "string" },
  "expected-version": { type: "string" },
  "managed-hook": { type: "string" },
  processed: { type: "boolean" },
  json: { type: "boolean", short: "j" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = Partial<Record<keyof typeof optionSpec, string | boolean>>;

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required.`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer.`);
  return parsed;
}

function boundedInteger(value: string | undefined, fallback: number, flag: string, min: number, max: number): number {
  const parsed = positiveInteger(value, fallback, flag);
  if (parsed < min || parsed > max) throw new Error(`${flag} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function print(value: unknown, jsonMode: boolean): void {
  if (jsonMode) console.log(JSON.stringify(value));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  // Accept a UTF-8 BOM from Windows hook producers before parsing JSON.
  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
}

function compactEvent(event: RoomEvent) {
  return {
    seq: event.seq,
    type: event.type,
    from: event.senderName,
    role: event.senderRole,
    ...(event.kind ? { kind: event.kind } : {}),
    ...(event.type === "message" ? { severity: event.severity, ...(event.blocking ? { blocking: true } : {}) } : {}),
    ...(event.body ? { body: event.body } : {}),
    ...(event.mentions.length ? { mentions: event.mentions } : {}),
    ...(event.replyTo ? { replyTo: event.replyTo } : {}),
    ...(event.supersedes ? { supersedes: event.supersedes } : {}),
    at: event.createdAt,
  };
}

async function active(values: Values): Promise<{ profileName: string; profile: Profile; client: RelayRoomClient }> {
  const selected = await resolveProfile(values.profile as string | undefined);
  return { profileName: selected.name, profile: selected.profile, client: new RelayRoomClient(selected.profile.server) };
}

async function selectedServer(values: Values): Promise<string> {
  return (values.server as string | undefined)
    ?? process.env.RELAYROOM_SERVER
    ?? await getDefaultServer()
    ?? "http://127.0.0.1:8787";
}

async function receive(profileName: string, profile: Profile, client: RelayRoomClient, waitSeconds: number) {
  const response = await client.events(profile, profile.lastDeliveredSeq, waitSeconds);
  if (response.events.length === 0) return [];
  const latest = response.events.at(-1)!.seq;
  await client.ack(profile, latest, undefined);
  await updateProfile(profileName, { lastDeliveredSeq: latest });
  profile.lastDeliveredSeq = latest;
  return response.events.filter((event) => event.senderId !== profile.participantId || event.type !== "message");
}

async function installSkill(target: string): Promise<string[]> {
  const source = fileURLToPath(new URL("../skills/relayroom/SKILL.md", import.meta.url));
  const roots: Record<string, string> = {
    codex: join(homedir(), ".agents", "skills", "relayroom"),
    cursor: join(homedir(), ".cursor", "skills", "relayroom"),
    claude: join(homedir(), ".claude", "skills", "relayroom"),
  };
  const selected = target === "all" ? Object.keys(roots) : [target];
  for (const name of selected) if (!roots[name]) throw new Error("Target must be codex, cursor, claude, or all.");
  const installed: string[] = [];
  for (const name of selected) {
    const destination = join(roots[name]!, "SKILL.md");
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
    installed.push(destination);
  }
  return installed;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  const parsed = parseArgs({ args, options: optionSpec, allowPositionals: true, strict: true });
  const values = parsed.values as Values;
  const positionals = parsed.positionals;
  if (values.help) {
    console.log(HELP);
    return;
  }
  const jsonMode = values.json === true;

  if (command === "configure") {
    const server = required(values.server as string | undefined, "--server");
    const parsedServer = new URL(server);
    if (!["http:", "https:"].includes(parsedServer.protocol)) throw new Error("--server must use http:// or https://.");
    await setDefaultServer(server);
    print({ server: server.replace(/\/$/, "") }, jsonMode);
    return;
  }

  if (command === "hook") {
    const vendor = required(positionals[0], "hook vendor") as HookVendor;
    if (!["codex", "claude", "cursor"].includes(vendor)) throw new Error("Hook vendor must be codex, claude, or cursor.");
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
    console.log(JSON.stringify(await handleHook(vendor, input)));
    return;
  }

  if (command === "install-hooks") {
    const cliPath = fileURLToPath(import.meta.url);
    const installed = await installHooks(positionals[0] ?? "all", process.execPath, cliPath);
    print({ installed, codexTrustRequired: installed.some((item) => item.vendor === "codex") }, jsonMode);
    return;
  }

  if (command === "create") {
    const server = await selectedServer(values);
    const name = required(values.as as string | undefined, "--as");
    const role = (values.role as string | undefined) ?? "agent";
    const vendor = (values.vendor as string | undefined) ?? "other";
    const device = (values.device as string | undefined) ?? hostname();
    const profileName = (values.profile as string | undefined) ?? name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const result = await new RelayRoomClient(server).create({
      title: required(positionals.join(" ").trim(), "room title"),
      name,
      role,
      vendor,
      device,
      maxParticipants: positiveInteger(values["max-participants"] as string | undefined, 8, "--max-participants"),
      inviteMinutes: positiveInteger(values["invite-minutes"] as string | undefined, 15, "--invite-minutes"),
      retentionHours: positiveInteger(values["retention-hours"] as string | undefined, 72, "--retention-hours"),
    });
    await putProfile(profileName, {
      server: result.server,
      roomId: result.roomId,
      roomTitle: result.roomTitle,
      participantId: result.participant.id,
      participantName: result.participant.name,
      participantToken: result.participantToken,
      hostToken: result.hostToken,
      joinCode: result.code,
      joinCodeExpiresAt: result.codeExpiresAt,
      lastDeliveredSeq: result.event.seq,
      lastProcessedSeq: 0,
      createdAt: new Date().toISOString(),
      role,
      vendor,
      device,
      cwd: process.cwd(),
      interruptSeverity: boundedInteger(values["interrupt-severity"] as string | undefined, DEFAULT_INTERRUPT_SEVERITY, "--interrupt-severity", 1, 5),
      lastInterruptScanSeq: result.event.seq,
      lastWaitScanSeq: result.event.seq,
      lastStopWorkdocVersion: 1,
    });
    print({ profile: profileName, roomId: result.roomId, code: result.code, codeExpiresAt: result.codeExpiresAt, expiresAt: result.expiresAt, server: result.server }, jsonMode);
    return;
  }

  if (command === "join") {
    const server = await selectedServer(values);
    const code = required(positionals[0], "room code");
    const name = required(values.as as string | undefined, "--as");
    const role = (values.role as string | undefined) ?? "agent";
    const vendor = (values.vendor as string | undefined) ?? "other";
    const device = (values.device as string | undefined) ?? hostname();
    const profileName = (values.profile as string | undefined) ?? name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const result = await new RelayRoomClient(server).join(code, {
      name,
      role,
      vendor,
      device,
    });
    await putProfile(profileName, {
      server: result.server,
      roomId: result.roomId,
      roomTitle: result.roomTitle,
      participantId: result.participant.id,
      participantName: result.participant.name,
      participantToken: result.participantToken,
      lastDeliveredSeq: 0,
      lastProcessedSeq: 0,
      createdAt: new Date().toISOString(),
      role,
      vendor,
      device,
      cwd: process.cwd(),
      interruptSeverity: boundedInteger(values["interrupt-severity"] as string | undefined, DEFAULT_INTERRUPT_SEVERITY, "--interrupt-severity", 1, 5),
      lastInterruptScanSeq: result.event.seq,
      lastWaitScanSeq: result.event.seq,
      lastStopWorkdocVersion: 1,
    });
    print({ profile: profileName, roomId: result.roomId, title: result.roomTitle, expiresAt: result.expiresAt, server: result.server }, jsonMode);
    return;
  }

  if (command === "profiles") {
    const profiles = (await listProfiles()).map(({ name, profile }) => ({
      name,
      roomId: profile.roomId,
      participant: profile.participantName,
      vendor: profile.vendor,
      server: profile.server,
      hookBound: Boolean(profile.hookSessionId),
      status: profile.leftAt ? "left" : "active",
    }));
    print({ profiles }, jsonMode);
    return;
  }

  if (command === "install-skill") {
    const installed = await installSkill(positionals[0] ?? "all");
    print({ installed }, jsonMode);
    return;
  }

  const { profileName, profile, client } = await active(values);

  if (command === "say") {
    const body = required(positionals.join(" ").trim(), "message");
    const kind = ((values.kind as string | undefined) ?? "message") as MessageKind;
    if (!MESSAGE_KINDS.includes(kind)) throw new Error(`--kind must be one of: ${MESSAGE_KINDS.join(", ")}.`);
    const replyTo = values["reply-to"] ? positiveInteger(values["reply-to"] as string, 0, "--reply-to") : undefined;
    const supersedes = values.supersedes ? positiveInteger(values.supersedes as string, 0, "--supersedes") : undefined;
    const result = await client.say(profile, body, {
      kind,
      severity: boundedInteger(values.severity as string | undefined, 1, "--severity", 1, 5),
      blocking: values.blocking === true,
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
    });
    print({ event: compactEvent(result.event) }, jsonMode);
    return;
  }

  if (command === "inbox") {
    const events = await receive(profileName, profile, client, 0);
    print({ events: events.map(compactEvent), cursor: profile.lastDeliveredSeq }, jsonMode);
    return;
  }

  if (command === "wait") {
    const timeout = positiveInteger(values.timeout as string | undefined, 0, "--timeout");
    const deadline = timeout === 0 ? Number.POSITIVE_INFINITY : Date.now() + timeout * 1_000;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        print({ events: [], timeout: true, cursor: profile.lastDeliveredSeq }, jsonMode);
        return;
      }
      const events = await receive(profileName, profile, client, Math.min(30, Math.max(1, Math.ceil(remaining / 1_000))));
      if (events.length > 0) {
        print({ events: events.map(compactEvent), cursor: profile.lastDeliveredSeq }, jsonMode);
        return;
      }
    }
  }

  if (command === "ack") {
    const seq = positiveInteger(required(positionals[0], "sequence"), 0, "sequence");
    const processed = values.processed === true ? seq : undefined;
    const delivered = Math.max(profile.lastDeliveredSeq, seq);
    const result = await client.ack(profile, delivered, processed);
    await updateProfile(profileName, {
      lastDeliveredSeq: delivered,
      ...(processed !== undefined ? { lastProcessedSeq: Math.max(profile.lastProcessedSeq, processed) } : {}),
    });
    print({ participant: result.participant }, jsonMode);
    return;
  }

  if (command === "who") {
    print(await client.state(profile), jsonMode);
    return;
  }

  if (command === "workdoc") {
    const action = positionals[0] ?? "show";
    if (action === "show") {
      print(await client.getWorkdoc(profile), jsonMode);
      return;
    }
    if (action === "set") {
      let content = values.content as string | undefined;
      const source = positionals[1];
      if (!content && source) content = source === "-" ? await readStdin() : await readFile(source, "utf8");
      const expectedVersion = values["expected-version"]
        ? positiveInteger(values["expected-version"] as string, 0, "--expected-version")
        : undefined;
      const result = await client.updateWorkdoc(profile, required(content?.trim(), "--content or workdoc file"), expectedVersion);
      print(result, jsonMode);
      return;
    }
    throw new Error("workdoc action must be show or set.");
  }

  if (command === "invite") {
    const result = await client.rotateInvite(profile, positiveInteger(values["invite-minutes"] as string | undefined, 15, "--invite-minutes"));
    await updateProfile(profileName, { joinCode: result.code, joinCodeExpiresAt: result.codeExpiresAt });
    print(result, jsonMode);
    return;
  }

  if (command === "export") {
    const path = required(positionals[0], "export file");
    await writeFile(path, await client.export(profile), "utf8");
    print({ exported: path }, jsonMode);
    return;
  }

  if (command === "leave") {
    const result = await client.leave(profile);
    const leftAt = new Date().toISOString();
    await updateProfile(profileName, { leftAt });
    print({ event: compactEvent(result.event), profile: profileName, workdocAvailableUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString() }, jsonMode);
    return;
  }

  if (command === "end") {
    const result = await client.end(profile);
    const exportPath = values.export as string | undefined;
    if (exportPath) await writeFile(exportPath, result.transcript, "utf8");
    print({ event: compactEvent(result.event), ...(exportPath ? { exported: exportPath } : {}) }, jsonMode);
    return;
  }

  throw new Error(`Unknown command '${command}'. Run 'relayroom help'.`);
}

main().catch((error: unknown) => {
  const payload = error instanceof ClientError
    ? { error: { code: error.code, message: error.message, status: error.status } }
    : { error: { code: "cli_error", message: error instanceof Error ? error.message : String(error) } };
  if (process.argv.includes("--json") || process.argv.includes("-j")) console.error(JSON.stringify(payload));
  else console.error(`RelayRoom: ${payload.error.message}`);
  process.exitCode = 1;
});
