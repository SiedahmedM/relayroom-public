import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RelayRoomClient } from "../src/client.js";
import { handleHook, type HookVendor } from "../src/hooks.js";
import { loadState, putProfile, updateProfile, type Profile } from "../src/state.js";
import { startServer, type RunningServer } from "../src/server.js";

const pepper = "workflow-test-pepper-that-is-long-enough";
const cwd = "/workspace/sample-project";

interface WorkflowFixture {
  client: RelayRoomClient;
  directory: string;
  running: RunningServer;
  restoreEnvironment(): void;
}

function profile(result: any, vendor: HookVendor, interruptSeverity = 4): Profile {
  return {
    server: result.server,
    roomId: result.roomId,
    roomTitle: result.roomTitle,
    participantId: result.participant.id,
    participantName: result.participant.name,
    participantToken: result.participantToken,
    ...(result.hostToken ? { hostToken: result.hostToken } : {}),
    lastDeliveredSeq: result.event.seq,
    lastProcessedSeq: 0,
    createdAt: new Date().toISOString(),
    role: result.participant.role,
    vendor,
    device: result.participant.device,
    cwd,
    interruptSeverity,
    lastInterruptScanSeq: result.event.seq,
    lastWaitScanSeq: result.event.seq,
    lastStopWorkdocVersion: 1,
  };
}

function hookInput(vendor: HookVendor, event: string, session: string, extra: Record<string, unknown> = {}) {
  return vendor === "cursor"
    ? { hook_event_name: event, conversation_id: session, workspace_roots: [cwd], ...extra }
    : { hook_event_name: event, session_id: session, cwd, ...extra };
}

function injectedText(vendor: HookVendor, output: Record<string, unknown>): string {
  if (vendor === "cursor") return String(output.additional_context ?? output.followup_message ?? output.user_message ?? "");
  const specific = output.hookSpecificOutput as Record<string, unknown> | undefined;
  return String(specific?.additionalContext ?? output.reason ?? output.systemMessage ?? "");
}

async function fixture(waitSeconds = 2): Promise<WorkflowFixture> {
  const directory = await mkdtemp(join(tmpdir(), "relayroom-workflow-"));
  const previousState = process.env.RELAYROOM_STATE;
  const previousWait = process.env.RELAYROOM_HOOK_WAIT_SECONDS;
  process.env.RELAYROOM_STATE = join(directory, "state.json");
  process.env.RELAYROOM_HOOK_WAIT_SECONDS = String(waitSeconds);
  const running = await startServer({ port: 0, databasePath: join(directory, "room.db"), pepper, quiet: true });
  return {
    client: new RelayRoomClient(running.url),
    directory,
    running,
    restoreEnvironment() {
      if (previousState === undefined) delete process.env.RELAYROOM_STATE;
      else process.env.RELAYROOM_STATE = previousState;
      if (previousWait === undefined) delete process.env.RELAYROOM_HOOK_WAIT_SECONDS;
      else process.env.RELAYROOM_HOOK_WAIT_SECONDS = previousWait;
    },
  };
}

async function bind(profileName: string, profileValue: Profile, vendor: HookVendor, session: string): Promise<void> {
  await putProfile(profileName, profileValue);
  const output = await handleHook(vendor, hookInput(vendor, "SessionStart", session));
  assert.match(injectedText(vendor, output), /room workdoc|room work tracker/i);
}

test("multi-agent workflow preserves focus, handles blocking messages, and resumes checkpoints", async (t) => {
  const setup = await fixture();
  t.after(async () => {
    await setup.running.close();
    await rm(setup.directory, { recursive: true, force: true });
    setup.restoreEnvironment();
  });
  const { client, running } = setup;

  const created = await client.create({ title: "API migration sprint", name: "Riley-Codex", role: "ios", vendor: "codex", device: "mac" });
  const riley = profile(created, "codex");
  const joinedMorgan = await client.join(created.code, { name: "Morgan-Claude", role: "web", vendor: "claude", device: "pc" });
  const morgan = profile(joinedMorgan, "claude");
  const joinedTaylor = await client.join(created.code, { name: "Taylor-Cursor", role: "review", vendor: "cursor", device: "pc" });
  const taylor = profile(joinedTaylor, "cursor");

  await bind("riley", riley, "codex", "riley-session");
  await bind("morgan", morgan, "claude", "morgan-session");
  await bind("taylor", taylor, "cursor", "taylor-session");

  const rileyTask = "## Current task\nImplement iOS alerts\n\n## Completed evidence\nDecoder tests pass\n\n## Next step\nWire notification settings\n\n## Deferred replies\nNone";
  const taylorTask = "## Current task\nReview API contract\n\n## Completed evidence\nSchema loaded\n\n## Next step\nCheck error responses\n\n## Deferred replies\nNone";
  await client.updateWorkdoc(riley, rileyTask, 1);
  await client.updateWorkdoc(taylor, taylorTask, 1);

  // Riley asks a non-blocking question. Taylor notices it at a boundary but is not
  // interrupted while focused; it is delivered when Taylor naturally goes idle.
  const lowQuestion = (await client.say(riley, "@Taylor-Cursor Can you inspect the pagination edge case?", {
    kind: "question",
    severity: 2,
  })).event;
  const noFocusBreak = await handleHook("cursor", hookInput("cursor", "postToolUse", "taylor-session"));
  assert.deepEqual(noFocusBreak, {});
  const atNaturalStop = await handleHook("cursor", hookInput("cursor", "stop", "taylor-session", { loop_count: 0 }));
  assert.match(injectedText("cursor", atNaturalStop), /pagination edge case/);
  assert.match(injectedText("cursor", atNaturalStop), /answer immediately only when quick or urgent; otherwise send a short deferral/i);

  const deferral = (await client.say(taylor, "@Riley-Codex I am finishing the API review; I will inspect pagination immediately after.", {
    kind: "status",
    severity: 1,
    replyTo: lowQuestion.seq,
  })).event;
  await client.ack(taylor, lowQuestion.seq, lowQuestion.seq);
  assert.equal((await client.getWorkdoc(taylor)).workdoc.content, taylorTask);

  // Morgan asks Riley an urgent question whose answer Riley already knows. The
  // hook surfaces it at the next safe tool boundary, so Riley can answer quickly.
  const quickQuestion = (await client.say(morgan, "@Riley-Codex Which notification preference key is canonical?", {
    kind: "question",
    severity: 4,
  })).event;
  const rileyInterrupted = await handleHook("codex", hookInput("codex", "PostToolUse", "riley-session"));
  const rileyContext = injectedText("codex", rileyInterrupted);
  assert.match(rileyContext, /notification preference key/);
  assert.match(rileyContext, /S4/);
  assert.match(rileyContext, /answer immediately only when quick or urgent/i);
  const quickAnswer = (await client.say(riley, "@Morgan-Claude The canonical key is notification_preferences.", {
    kind: "result",
    severity: 2,
    replyTo: quickQuestion.seq,
  })).event;
  await client.ack(riley, quickQuestion.seq, quickQuestion.seq);
  assert.equal((await client.getWorkdoc(riley)).workdoc.content, rileyTask, "quick known answers do not require abandoning Riley's task");

  // Riley later becomes blocked on Taylor. Blocking overrides the numeric value,
  // and Taylor checkpoints the exact resumption point before switching work.
  const blockingQuestion = (await client.say(riley, "@Taylor-Cursor I cannot finish the release until you confirm the 409 contract.", {
    kind: "question",
    severity: 1,
    blocking: true,
  })).event;
  await updateProfile("taylor", { lastHookCheckAt: new Date(0).toISOString() });
  const taylorInterrupted = await handleHook("cursor", hookInput("cursor", "postToolUse", "taylor-session"));
  const taylorContext = injectedText("cursor", taylorInterrupted);
  assert.match(taylorContext, /S1 BLOCKING/);
  assert.match(taylorContext, /update your RelayRoom workdoc/i);

  const interruptionCheckpoint = "## Current task\nReview API contract\n\n## Completed evidence\nSchema and happy path verified\n\n## Next step\nResume at error response 422, then pagination\n\n## Blocker being handled\nRiley needs the 409 contract\n\n## Deferred replies\nPagination question remains";
  const checkpointed = (await client.updateWorkdoc(taylor, interruptionCheckpoint, 2)).workdoc;
  assert.equal(checkpointed.version, 3);
  const blockingAnswer = (await client.say(taylor, "@Riley-Codex Confirmed: conflict responses use HTTP 409 with code workdoc_conflict.", {
    kind: "result",
    severity: 4,
    replyTo: blockingQuestion.seq,
  })).event;
  await client.ack(taylor, blockingQuestion.seq, blockingQuestion.seq);
  assert.equal((await client.getWorkdoc(taylor)).workdoc.content, interruptionCheckpoint, "Taylor can recover the exact next step after replying");

  // All collaboration is ordered and linked, but delivery is not confused with
  // processing. The agent explicitly advances processed cursors after acting.
  assert.ok(deferral.replyTo === lowQuestion.seq);
  assert.ok(quickAnswer.replyTo === quickQuestion.seq);
  assert.ok(blockingAnswer.replyTo === blockingQuestion.seq);
  const state = await client.state(riley);
  const taylorState = state.participants.find((participant: any) => participant.name === "Taylor-Cursor");
  assert.ok(taylorState.processedSeq >= blockingQuestion.seq);

  // The urgent message was delivered once. Neither a later safe boundary nor
  // the idle hook manufactures another model turn for the same event.
  await updateProfile("taylor", { lastHookCheckAt: new Date(0).toISOString() });
  assert.deepEqual(await handleHook("cursor", hookInput("cursor", "postToolUse", "taylor-session")), {});

  await client.leave(taylor);
  const retained = (await client.getWorkdoc(taylor)).workdoc;
  assert.equal(retained.content, interruptionCheckpoint);
  assert.ok(retained.deleteAfter);
  const retainedDays = (new Date(retained.deleteAfter!).getTime() - Date.now()) / 86_400_000;
  assert.ok(retainedDays > 6.99 && retainedDays <= 7.01);
  assert.deepEqual(await handleHook("cursor", hookInput("cursor", "stop", "taylor-session", { loop_count: 1 })), {}, "leaving stops automatic waiting");

  running.store.db.prepare("UPDATE workdocs SET delete_after = ? WHERE room_id = ? AND participant_id = ?")
    .run(new Date(0).toISOString(), taylor.roomId, taylor.participantId);
  running.store.cleanupExpired();
  assert.equal(running.store.workdocsForRoom(taylor.roomId).some((doc) => doc.participantId === taylor.participantId), false);
  await client.end(riley);
});

test("token-efficiency workflow: silence and unrelated traffic create no model-visible turns; one relevant tag wakes once", async (t) => {
  const setup = await fixture(2);
  t.after(async () => {
    await setup.running.close();
    await rm(setup.directory, { recursive: true, force: true });
    setup.restoreEnvironment();
  });
  const { client } = setup;
  const created = await client.create({ title: "token budget", name: "Worker-Codex", role: "ios", vendor: "codex", device: "mac" });
  const worker = profile(created, "codex");
  const joined = await client.join(created.code, { name: "Peer-Claude", role: "web", vendor: "claude", device: "pc" });
  const peer = profile(joined, "claude");
  await bind("worker", worker, "codex", "worker-session");
  await bind("peer", peer, "claude", "peer-session");

  assert.deepEqual(await handleHook("codex", hookInput("codex", "PostToolUse", "worker-session")), {});
  await client.say(peer, "This S5 broadcast is intentionally not tagged to Worker-Codex.", { kind: "status", severity: 5, blocking: true });
  await updateProfile("worker", { lastHookCheckAt: new Date(0).toISOString() });
  assert.deepEqual(await handleHook("codex", hookInput("codex", "PostToolUse", "worker-session")), {}, "priority alone cannot wake an unrelated agent");

  const checkpointPrompt = await handleHook("codex", hookInput("codex", "Stop", "worker-session", { stop_hook_active: false }));
  assert.equal(checkpointPrompt.decision, "block");
  assert.match(injectedText("codex", checkpointPrompt), /checkpoint/i);
  await client.updateWorkdoc(worker, "## Current task\nWaiting efficiently\n\n## Next step\nHandle a relevant teammate message", 1);

  const waiting = handleHook("codex", hookInput("codex", "Stop", "worker-session", { stop_hook_active: true }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await client.say(peer, "Still not tagged to the worker.", { kind: "status", severity: 5 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const relevant = (await client.say(peer, "@Worker-Codex When convenient, which build passed?", { kind: "question", severity: 2 })).event;
  const wake = await waiting;
  assert.equal(wake.decision, "block");
  assert.match(injectedText("codex", wake), /which build passed/);
  assert.doesNotMatch(injectedText("codex", wake), /Still not tagged/);

  await client.ack(worker, relevant.seq, relevant.seq);
  const noHeartbeat = await handleHook("codex", hookInput("codex", "Stop", "worker-session", { stop_hook_active: true }));
  assert.deepEqual(noHeartbeat, {}, "a timeout emits no empty continuation, heartbeat, or model prompt");
});

test("room-code and compaction workflow: one short invite opens a 72-hour room with isolated resumable workdocs", async (t) => {
  const setup = await fixture();
  t.after(async () => {
    await setup.running.close();
    await rm(setup.directory, { recursive: true, force: true });
    setup.restoreEnvironment();
  });
  const { client } = setup;
  const before = Date.now();
  const created = await client.create({ title: "three-day sprint", name: "Mac-Codex", role: "ios", vendor: "codex", device: "mac" });
  const mac = profile(created, "codex");
  const roomHours = (new Date(created.expiresAt).getTime() - before) / 3_600_000;
  const inviteMinutes = (new Date(created.codeExpiresAt).getTime() - before) / 60_000;
  assert.ok(roomHours > 71.99 && roomHours <= 72.01);
  assert.ok(inviteMinutes > 14.99 && inviteMinutes <= 15.01);

  const joined = await client.join(created.code, { name: "PC-Claude", role: "web", vendor: "claude", device: "pc" });
  const pc = profile(joined, "claude");
  await bind("mac", mac, "codex", "mac-compact-session");
  await bind("pc", pc, "claude", "pc-compact-session");
  const macCheckpoint = "## Current task\nImplement notification preferences\n\n## Completed evidence\nAPI types compiled\n\n## Next step\nAdd the SwiftUI toggle";
  const pcCheckpoint = "## Current task\nImplement preferences endpoint\n\n## Completed evidence\nMigration applied\n\n## Next step\nAdd request validation";
  await client.updateWorkdoc(mac, macCheckpoint, 1);
  await client.updateWorkdoc(pc, pcCheckpoint, 1);
  assert.notEqual((await client.getWorkdoc(mac)).workdoc.participantId, (await client.getWorkdoc(pc)).workdoc.participantId);
  assert.equal((await client.getWorkdoc(mac)).workdoc.content, macCheckpoint);
  assert.equal((await client.getWorkdoc(pc)).workdoc.content, pcCheckpoint);

  await client.say(pc, "@Mac-Codex Compaction-safe pending detail: the endpoint uses snake_case.", { kind: "status", severity: 2 });
  const preCompact = await handleHook("codex", hookInput("codex", "PreCompact", "mac-compact-session", { trigger: "auto" }));
  assert.match(injectedText("codex", preCompact), /preserve the current task/i);
  const afterCompact = await handleHook("codex", hookInput("codex", "SessionStart", "mac-compact-session", { source: "compact" }));
  const restored = injectedText("codex", afterCompact);
  assert.match(restored, /Add the SwiftUI toggle/);
  assert.match(restored, /endpoint uses snake_case/);
  assert.match(restored, /separate from repository documentation and long-term memory/i);

  const macDoc = (await client.getWorkdoc(mac)).workdoc;
  const pcDoc = (await client.getWorkdoc(pc)).workdoc;
  assert.equal(macDoc.content, macCheckpoint);
  assert.equal(pcDoc.content, pcCheckpoint);
  await client.end(mac);
  const closedMac = (await client.getWorkdoc(mac)).workdoc;
  const closedPc = (await client.getWorkdoc(pc)).workdoc;
  assert.ok(closedMac.deleteAfter && closedPc.deleteAfter);
  assert.deepEqual(await handleHook("codex", hookInput("codex", "Stop", "mac-compact-session", { stop_hook_active: false })), {});
});
