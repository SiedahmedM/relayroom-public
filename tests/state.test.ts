import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { loadState, putProfile, saveState, statePath, type Profile } from "../src/state.js";

const profile: Profile = {
  server: "http://127.0.0.1:8787", roomId: "rm_example", roomTitle: "Example",
  participantId: "pt_example", participantName: "Riley", participantToken: "test-only-participant-token",
  hostToken: "test-only-host-token", lastDeliveredSeq: 0, lastProcessedSeq: 0, createdAt: "2026-01-01T00:00:00Z",
};

test("state updates are atomic, private on Unix, and safe across processes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relayroom-state-"));
  const prior = process.env.RELAYROOM_STATE;
  process.env.RELAYROOM_STATE = join(dir, "private", "state.json");
  t.after(async () => {
    if (prior === undefined) delete process.env.RELAYROOM_STATE;
    else process.env.RELAYROOM_STATE = prior;
    await rm(dir, { recursive: true, force: true });
  });
  await putProfile("riley", profile);
  const run = promisify(execFile);
  await Promise.all(Array.from({ length: 8 }, (_, index) => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {updateProfile} from './src/state.ts'; await updateProfile('riley',{lastDeliveredSeq:${index + 1}});`,
  ], { env: { ...process.env } })));
  assert.equal((await loadState()).profiles.riley!.lastDeliveredSeq, 8);
  assert.deepEqual(await readdir(join(dir, "private")), ["state.json"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(statePath())).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "private"))).mode & 0o777, 0o700);
  }
  const { stdout } = await run(process.execPath, ["--import", "tsx", "src/cli.ts", "profiles", "--json"]);
  assert.equal(stdout.includes(profile.participantToken), false);
  assert.equal(stdout.includes(profile.hostToken!), false);
  const failedPath = join(dir, "destination-directory");
  await mkdir(failedPath);
  process.env.RELAYROOM_STATE = failedPath;
  await assert.rejects(saveState({ version: 1, profiles: {} }));
  assert.equal((await readdir(dir)).some((name) => name.endsWith(".tmp")), false);
});

test("old locks are not stolen from a potentially live writer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relayroom-lock-"));
  const prior = process.env.RELAYROOM_STATE;
  const file = join(dir, "state.json");
  process.env.RELAYROOM_STATE = file;
  t.after(async () => {
    if (prior === undefined) delete process.env.RELAYROOM_STATE;
    else process.env.RELAYROOM_STATE = prior;
    await rm(dir, { recursive: true, force: true });
  });
  await putProfile("riley", profile);
  const before = await readFile(file, "utf8");
  await mkdir(`${file}.lock`);
  await utimes(`${file}.lock`, new Date(0), new Date(0));
  await assert.rejects(putProfile("morgan", profile), /State is locked/);
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal((await stat(`${file}.lock`)).isDirectory(), true);
});
