import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RelayRoomClient, ClientError } from "../src/client.js";
import type { Profile } from "../src/state.js";
import { startServer, type RunningServer } from "../src/server.js";

const pepper = "test-only-pepper-that-is-long-enough";

function profile(result: any): Profile {
  return {
    server: result.server,
    roomId: result.roomId,
    roomTitle: result.roomTitle,
    participantId: result.participant.id,
    participantName: result.participant.name,
    participantToken: result.participantToken,
    ...(result.hostToken ? { hostToken: result.hostToken } : {}),
    lastDeliveredSeq: 0,
    lastProcessedSeq: 0,
    createdAt: new Date().toISOString(),
  };
}

async function fixture(): Promise<{ running: RunningServer; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "relayroom-test-"));
  const running = await startServer({ port: 0, databasePath: join(directory, "room.db"), pepper, quiet: true });
  return { running, directory };
}

test("full multi-agent room lifecycle", async (t) => {
  const { running, directory } = await fixture();
  t.after(async () => {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = new RelayRoomClient(running.url);
  const created = await client.create({
    title: "iOS/web sprint",
    name: "Mac-Codex",
    role: "ios",
    vendor: "codex",
    device: "mac",
    maxParticipants: 4,
    inviteMinutes: 15,
    retentionHours: 24,
  });
  assert.match(created.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

  const host = profile(created);
  const joined = await client.join(created.code, { name: "PC-Claude", role: "web", vendor: "claude", device: "pc" });
  const claude = profile(joined);

  const first = await client.say(host, "@PC-Claude [QUESTION] Can you verify the API?", { kind: "question", idempotencyKey: "same-retry" });
  const retried = await client.say(host, "this body is ignored on retry", { kind: "question", idempotencyKey: "same-retry" });
  assert.equal(first.event.seq, retried.event.seq);
  assert.deepEqual(first.event.mentions, ["PC-Claude"]);

  const received = await client.events(claude, 0, 0);
  assert.equal(received.events.filter((event) => event.type === "message").length, 1);
  await client.ack(claude, first.event.seq, first.event.seq);
  const state = await client.state(claude);
  const claudeState = state.participants.find((participant: any) => participant.name === "PC-Claude");
  assert.equal(claudeState.deliveredSeq, first.event.seq);
  assert.equal(claudeState.processedSeq, first.event.seq);

  const pending = client.events(host, first.event.seq, 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const reply = await client.say(claude, "@Mac-Codex [RESULT] Verified.", { kind: "result", replyTo: first.event.seq });
  const awakened = await pending;
  assert.equal(awakened.events[0]?.seq, reply.event.seq);

  const sent = await Promise.all(Array.from({ length: 10 }, (_, index) => client.say(host, `message-${index}`, {
    kind: "status",
    idempotencyKey: `concurrent-${index}`,
  })));
  const sequences = sent.map((item) => item.event.seq);
  assert.equal(new Set(sequences).size, 10);
  assert.deepEqual([...sequences].sort((a, b) => a - b), Array.from({ length: 10 }, (_, index) => Math.min(...sequences) + index));

  const rotated = await client.rotateInvite(host, 15);
  await assert.rejects(() => client.join(created.code, { name: "Old-Code", role: "test", vendor: "cursor", device: "pc" }), (error: unknown) => {
    return error instanceof ClientError && error.status === 404;
  });
  const cursorJoined = await client.join(rotated.code, { name: "PC-Cursor", role: "review", vendor: "cursor", device: "pc" });
  assert.equal(cursorJoined.roomId, created.roomId);

  const ended = await client.end(host);
  assert.equal(ended.event.type, "room.ended");
  assert.match(ended.transcript, /PC-Claude \[RESULT\]/);
  const exported = await client.export(claude);
  assert.equal(exported, ended.transcript);
  await assert.rejects(() => client.say(claude, "too late", { kind: "message" }), (error: unknown) => {
    return error instanceof ClientError && error.code === "room_ended";
  });
});

test("SQLite log survives a server restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relayroom-restart-"));
  const databasePath = join(directory, "room.db");
  let running = await startServer({ port: 0, databasePath, pepper, quiet: true });
  const firstClient = new RelayRoomClient(running.url);
  const created = await firstClient.create({ title: "restart", name: "Host", role: "lead", vendor: "codex", device: "mac" });
  const host = profile(created);
  const sent = await firstClient.say(host, "durable", { kind: "decision" });
  await running.close();

  running = await startServer({ port: 0, databasePath, pepper, quiet: true });
  t.after(async () => {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  });
  host.server = running.url;
  const secondClient = new RelayRoomClient(running.url);
  const events = await secondClient.events(host, 0, 0);
  assert.equal(events.events.find((event) => event.seq === sent.event.seq)?.body, "durable");
});

test("startup backfills workdocs for participants created before workdoc support", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relayroom-backfill-"));
  const databasePath = join(directory, "room.db");
  let running = await startServer({ port: 0, databasePath, pepper, quiet: true });
  const client = new RelayRoomClient(running.url);
  const created = await client.create({ title: "migration", name: "Legacy", role: "lead", vendor: "codex", device: "mac" });
  const legacy = profile(created);
  running.store.db.prepare("DELETE FROM workdocs WHERE room_id = ? AND participant_id = ?").run(legacy.roomId, legacy.participantId);
  await running.close();

  running = await startServer({ port: 0, databasePath, pepper, quiet: true });
  t.after(async () => {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  });
  legacy.server = running.url;
  const backfilled = (await new RelayRoomClient(running.url).getWorkdoc(legacy)).workdoc;
  assert.equal(backfilled.version, 1);
  assert.match(backfilled.content, /Legacy/);
});

test("invalid tokens and cursor leaps are rejected", async (t) => {
  const { running, directory } = await fixture();
  t.after(async () => {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = new RelayRoomClient(running.url);
  const created = await client.create({ title: "security", name: "Host", role: "lead", vendor: "codex", device: "mac" });
  const host = profile(created);
  await assert.rejects(
    () => client.events({ ...host, participantToken: "wrong-token-that-is-long-enough" }, 0, 0),
    (error: unknown) => error instanceof ClientError && error.status === 401,
  );
  await assert.rejects(
    () => client.ack(host, 999, 999),
    (error: unknown) => error instanceof ClientError && error.code === "invalid_cursor",
  );
  await assert.rejects(
    () => client.ack(host, undefined, 1),
    (error: unknown) => error instanceof ClientError && error.code === "invalid_cursor",
  );
});

test("rooms default to 72 hours and reject shorter-than-12-hour retention", async (t) => {
  const { running, directory } = await fixture();
  t.after(async () => {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = new RelayRoomClient(running.url);
  const before = Date.now();
  const created = await client.create({ title: "three days", name: "Host", role: "lead", vendor: "codex", device: "mac" });
  const durationHours = (new Date(created.expiresAt).getTime() - before) / 3_600_000;
  assert.ok(durationHours > 71.99 && durationHours <= 72.01);
  await assert.rejects(
    () => client.create({ title: "too short", name: "Other", role: "lead", vendor: "codex", device: "mac", retentionHours: 11 }),
    (error: unknown) => error instanceof ClientError && error.code === "invalid_field",
  );
});

test("severity, blocking messages, and per-agent workdocs are durable", async (t) => {
  const { running, directory } = await fixture();
  t.after(async () => {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = new RelayRoomClient(running.url);
  const created = await client.create({ title: "v2", name: "Host", role: "lead", vendor: "codex", device: "mac" });
  const host = profile(created);

  const initial = (await client.getWorkdoc(host)).workdoc;
  assert.equal(initial.version, 1);
  assert.match(initial.content, /Current task/);

  const updated = (await client.updateWorkdoc(host, "## Current task\nShip v2\n\n## Next step\nRun tests", 1)).workdoc;
  assert.equal(updated.version, 2);
  await assert.rejects(
    () => client.updateWorkdoc(host, "stale overwrite", 1),
    (error: unknown) => error instanceof ClientError && error.code === "workdoc_conflict",
  );

  const sent = await client.say(host, "@all production is blocked", { kind: "question", severity: 5, blocking: true });
  assert.equal(sent.event.severity, 5);
  assert.equal(sent.event.blocking, true);
  assert.deepEqual(sent.event.mentions, ["all"]);

  await client.leave(host);
  const afterLeave = (await client.getWorkdoc(host)).workdoc;
  assert.equal(afterLeave.content, updated.content);
  assert.ok(afterLeave.deleteAfter);
  const retentionDays = (new Date(afterLeave.deleteAfter!).getTime() - Date.now()) / 86_400_000;
  assert.ok(retentionDays > 6.99 && retentionDays <= 7.01);
  await assert.rejects(
    () => client.updateWorkdoc(host, "cannot mutate after leaving"),
    (error: unknown) => error instanceof ClientError && error.code === "invalid_participant_token",
  );

  running.store.db.prepare("UPDATE workdocs SET delete_after = ? WHERE room_id = ?").run(new Date(0).toISOString(), host.roomId);
  running.store.cleanupExpired();
  assert.equal(running.store.workdocsForRoom(host.roomId).length, 0);
});
