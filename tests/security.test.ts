import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { startServer, type ServerOptions } from "../src/server.js";

const options: ServerOptions = { port: 0, databasePath: ":memory:", pepper: "test-only-security-pepper-32-bytes", quiet: true };
const roomBody = JSON.stringify({ title: "API migration", name: "Riley" });

for (const mode of ["default", "untrusted", "trusted", "chain"] as const) {
  test(`create limits use the socket unless a configured proxy supplies one valid IP: ${mode}`, async (t) => {
    const running = await startServer({ ...options,
      trustedProxyAddresses: mode === "untrusted" ? ["192.0.2.1"] : mode === "default" ? [] : ["127.0.0.1"],
    });
    t.after(() => running.close());
    for (let index = 0; index < 11; index++) {
      const ip = `192.0.2.${index + 1}`;
      const response = await fetch(`${running.url}/v1/rooms`, { method: "POST", body: roomBody,
        headers: { "x-forwarded-for": mode === "chain" ? `${ip}, 192.0.2.200` : ip },
      });
      assert.equal(response.status, index === 10 && mode !== "trusted" ? 429 : 201);
      await response.json();
    }
  });
}

test("join limits cannot be bypassed with spoofed forwarding headers", async (t) => {
  const running = await startServer(options);
  t.after(() => running.close());
  for (let index = 0; index < 31; index++) {
    const response = await fetch(`${running.url}/v1/rooms/invalid/join`, {
      method: "POST", body: JSON.stringify({ name: "Morgan" }), headers: { "x-forwarded-for": `192.0.2.${index + 1}` },
    });
    assert.equal(response.status, index === 30 ? 429 : 404);
    await response.json();
  }
});

test("Host input never becomes the saved credential destination; logs exclude capabilities", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (value: string) => logs.push(value));
  const running = await startServer({ ...options, quiet: false });
  t.after(() => running.close());
  const data = await new Promise<any>((resolve, reject) => {
    const req = request(`${running.url}/v1/rooms`, { method: "POST", headers: { host: "attacker.invalid" } }, (res) => {
      let text = "";
      res.on("data", (chunk) => text += chunk);
      res.on("end", () => resolve(JSON.parse(text)));
    });
    req.on("error", reject);
    req.end(roomBody);
  });
  assert.equal(data.server, running.url);
  await (await fetch(`${running.url}/v1/rooms/${data.code}/join`, { method: "POST", body: JSON.stringify({ name: "Morgan" }) })).json();
  await (await fetch(`${running.url}/unknown-secret?token=private-query`)).json();
  const output = logs.join("\n");
  for (const value of [data.code, data.roomId, data.participantToken, data.hostToken, "unknown-secret", "private-query"]) {
    assert.equal(output.includes(value), false);
  }
  assert.match(output, /:code\/join/);
});

test("HTTP and UTF-8 content limits reject oversized input with safe errors", async (t) => {
  const running = await startServer(options);
  t.after(() => running.close());
  const oversized = await fetch(`${running.url}/v1/rooms`, { method: "POST", body: "x".repeat(65_537) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json() as any).error.code, "body_too_large");
  const malformed = await fetch(`${running.url}/v1/rooms/%ZZ/join`, { method: "POST", body: "{}" });
  assert.equal(malformed.status, 400);
  const created = await (await fetch(`${running.url}/v1/rooms`, { method: "POST", body: roomBody })).json() as any;
  const headers = { authorization: `Bearer ${created.participantToken}` };
  const message = await fetch(`${running.url}/v1/rooms/${created.roomId}/messages`, {
    method: "POST", headers, body: JSON.stringify({ body: "🙂".repeat(4097), idempotencyKey: "oversize" }),
  });
  assert.equal(message.status, 400);
  const workdoc = await fetch(`${running.url}/v1/rooms/${created.roomId}/workdoc`, {
    method: "PUT", headers, body: JSON.stringify({ content: "🙂".repeat(2049) }),
  });
  assert.equal(workdoc.status, 400);
});

test("long polls are bounded per participant and disconnect releases capacity", async (t) => {
  const running = await startServer(options);
  t.after(() => running.close());
  const created = await (await fetch(`${running.url}/v1/rooms`, { method: "POST", body: roomBody })).json() as any;
  const url = `${running.url}/v1/rooms/${created.roomId}/events?after=1&wait=30`;
  const headers = { authorization: `Bearer ${created.participantToken}` };
  const aborts = [new AbortController(), new AbortController()];
  const pending = aborts.map((abort) => fetch(url, { headers, signal: abort.signal }).catch(() => undefined));
  t.after(() => { for (const abort of aborts) abort.abort(); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const rejected = await fetch(url, { headers });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json() as any).error.code, "too_many_polls");
  aborts[0]!.abort();
  await pending[0];
  await new Promise((resolve) => setTimeout(resolve, 100));
  const replacement = fetch(url.replace("wait=30", "wait=1"), { headers });
  assert.equal((await replacement).status, 200);
  aborts[1]!.abort();
  await pending[1];
});

test("server rejects invalid proxy, URL, and retention configuration", async () => {
  for (const extra of [
    { trustedProxyAddresses: ["*"] },
    { publicUrl: "https://user:password@relay.example.com" },
    { publicUrl: "https://relay.example.com/path" },
    { publicUrl: "file:///tmp/server" },
    { retentionHours: Number.NaN },
  ]) await assert.rejects(startServer({ ...options, ...extra }));
});
