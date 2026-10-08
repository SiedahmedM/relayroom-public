import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { ApiError } from "./model.js";
import { RateLimiter } from "./rate-limit.js";
import { SqliteStore } from "./store.js";
import { booleanField, integerField, mentionsFrom, messageKind, objectBody, textField } from "./validation.js";
import { WaitHub } from "./wait-hub.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  databasePath: string;
  pepper: string;
  publicUrl?: string;
  retentionHours?: number;
  quiet?: boolean;
  trustedProxyAddresses?: string[];
}

export interface RunningServer {
  server: Server;
  store: SqliteStore;
  url: string;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(encoded);
}

function text(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 64 * 1024) {
      req.resume();
      throw new ApiError(413, "body_too_large", "Request body exceeds 64 KiB.");
    }
    chunks.push(buffer);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization;
  if (!value?.startsWith("Bearer ") || value.length < 20) {
    throw new ApiError(401, "missing_token", "A bearer token is required.");
  }
  return value.slice(7);
}

function hostToken(req: IncomingMessage): string {
  const value = req.headers["x-host-token"];
  if (typeof value !== "string" || value.length < 20) throw new ApiError(401, "missing_host_token", "An X-Host-Token header is required.");
  return value;
}

function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

function requestIp(req: IncomingMessage, trustedProxies: Set<string>): string {
  const remote = normalizeIp(req.socket.remoteAddress ?? "unknown");
  const forwarded = req.headers["x-forwarded-for"];
  // A trusted proxy must overwrite this header with exactly one client address.
  if (trustedProxies.has(remote) && typeof forwarded === "string" && isIP(forwarded.trim())) {
    return normalizeIp(forwarded.trim());
  }
  return remote;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  if (options.pepper.length < 24) throw new Error("RELAYROOM_SECRET_PEPPER must be at least 24 characters.");
  const proxyAddresses = options.trustedProxyAddresses ?? [];
  if (proxyAddresses.some((ip) => !isIP(ip))) throw new Error("Trusted proxies must be literal IP addresses.");
  const trustedProxies = new Set(proxyAddresses.map(normalizeIp));
  const publicUrl = options.publicUrl ? new URL(options.publicUrl) : undefined;
  if (publicUrl && (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password
    || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash)) {
    throw new Error("RELAYROOM_PUBLIC_URL must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }
  const retentionHours = options.retentionHours ?? 72;
  if (!Number.isInteger(retentionHours) || retentionHours < 12 || retentionHours > 168) {
    throw new Error("RELAYROOM_RETENTION_HOURS must be an integer from 12 to 168.");
  }
  if (options.databasePath !== ":memory:") mkdirSync(dirname(options.databasePath), { recursive: true });
  const store = new SqliteStore(options.databasePath, options.pepper);
  const hub = new WaitHub();
  const limiter = new RateLimiter();
  let baseUrl = publicUrl?.origin;
  const polls = new Map<string, number>();
  let totalPolls = 0;

  const server = createServer(async (req, res) => {
    const started = Date.now();
    let status = 500;
    let logRoute = "unmatched";
    try {
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw new ApiError(400, "invalid_url", "Expected an origin-relative request target.");
      // Never derive credential destinations from a client-supplied Host header.
      const url = new URL(req.url, baseUrl ?? "http://localhost");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        logRoute = "/health";
        status = 200;
        return json(res, status, { ok: true, protocol: "relayroom/2", now: new Date().toISOString() });
      }

      if (method === "POST" && url.pathname === "/v1/rooms") {
        logRoute = "/v1/rooms";
        limiter.check(`create:${requestIp(req, trustedProxies)}`, 10, 60_000);
        const body = objectBody(await readJson(req));
        const result = store.createRoom({
          title: textField(body, "title", { max: 120 })!,
          name: textField(body, "name", { max: 64 })!,
          role: textField(body, "role", { max: 64, fallback: "agent" })!,
          vendor: textField(body, "vendor", { max: 32, fallback: "other" })!,
          device: textField(body, "device", { max: 64, fallback: "unknown" })!,
          maxParticipants: integerField(body, "maxParticipants", { min: 2, max: 8, fallback: 8 })!,
          inviteMinutes: integerField(body, "inviteMinutes", { min: 1, max: 1_440, fallback: 15 })!,
          retentionHours: integerField(body, "retentionHours", { min: 12, max: 168, fallback: retentionHours })!,
          publicServer: baseUrl ?? url.origin,
        });
        hub.publish(result.roomId);
        status = 201;
        return json(res, status, result);
      }

      const joinMatch = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/join$/);
      if (method === "POST" && joinMatch) {
        logRoute = "/v1/rooms/:code/join";
        limiter.check(`join:${requestIp(req, trustedProxies)}`, 30, 60_000);
        let code: string;
        try { code = decodeURIComponent(joinMatch[1]!); }
        catch { throw new ApiError(400, "invalid_code", "Malformed invite code."); }
        const body = objectBody(await readJson(req));
        const result = store.joinRoom({
          code,
          name: textField(body, "name", { max: 64 })!,
          role: textField(body, "role", { max: 64, fallback: "agent" })!,
          vendor: textField(body, "vendor", { max: 32, fallback: "other" })!,
          device: textField(body, "device", { max: 64, fallback: "unknown" })!,
          publicServer: baseUrl ?? url.origin,
        });
        hub.publish(result.roomId);
        status = 201;
        return json(res, status, result);
      }

      const route = url.pathname.match(/^\/v1\/rooms\/(rm_[A-Za-z0-9_-]+)\/(messages|events|acks|state|workdoc|leave|end|export|invite)$/);
      if (!route) throw new ApiError(404, "not_found", "Route not found.");
      const roomId = route[1]!;
      const action = route[2]!;
      logRoute = `/v1/rooms/:roomId/${action}`;

      if (method === "POST" && action === "messages") {
        const participant = store.authenticateParticipant(roomId, bearer(req));
        limiter.check(`send:${participant.id}`, 60, 60_000);
        const body = objectBody(await readJson(req));
        const message = textField(body, "body", { max: 16_384 })!;
        const idempotencyKey = textField(body, "idempotencyKey", { max: 128 })!;
        const event = store.appendEvent(roomId, {
          type: "message",
          sender: participant,
          body: message,
          kind: messageKind(body.kind),
          severity: integerField(body, "severity", { min: 1, max: 5, fallback: 1 })!,
          blocking: booleanField(body, "blocking", { fallback: false })!,
          mentions: mentionsFrom(message),
          replyTo: integerField(body, "replyTo", { min: 1, max: Number.MAX_SAFE_INTEGER, optional: true }) ?? null,
          supersedes: integerField(body, "supersedes", { min: 1, max: Number.MAX_SAFE_INTEGER, optional: true }) ?? null,
          idempotencyKey,
        });
        hub.publish(roomId);
        status = 201;
        return json(res, status, { event });
      }

      if (method === "GET" && action === "events") {
        const participant = store.authenticateParticipant(roomId, bearer(req), true);
        const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
        const waitSeconds = Math.min(30, Math.max(0, Number.parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
        let events = store.eventsAfter(roomId, after);
        if (events.length === 0 && waitSeconds > 0) {
          if ((polls.get(participant.id) ?? 0) >= 2 || totalPolls >= 256) {
            throw new ApiError(429, "too_many_polls", "Too many concurrent long polls.");
          }
          const abort = new AbortController();
          const disconnected = () => abort.abort();
          res.once("close", disconnected);
          polls.set(participant.id, (polls.get(participant.id) ?? 0) + 1);
          totalPolls += 1;
          try {
            if (res.destroyed) abort.abort();
            await hub.wait(roomId, waitSeconds * 1_000, abort.signal);
            events = store.eventsAfter(roomId, after);
          } finally {
            res.off("close", disconnected);
            const remaining = (polls.get(participant.id) ?? 1) - 1;
            if (remaining) polls.set(participant.id, remaining);
            else polls.delete(participant.id);
            totalPolls -= 1;
          }
        }
        status = 200;
        return json(res, status, { events, latestSeq: events.at(-1)?.seq ?? after });
      }

      if (method === "POST" && action === "acks") {
        const participant = store.authenticateParticipant(roomId, bearer(req));
        const body = objectBody(await readJson(req));
        const deliveredSeq = integerField(body, "deliveredSeq", { min: 0, max: Number.MAX_SAFE_INTEGER, optional: true });
        const processedSeq = integerField(body, "processedSeq", { min: 0, max: Number.MAX_SAFE_INTEGER, optional: true });
        if (deliveredSeq === undefined && processedSeq === undefined) throw new ApiError(400, "invalid_cursor", "Provide deliveredSeq or processedSeq.");
        const participantView = store.acknowledge(participant, deliveredSeq, processedSeq);
        status = 200;
        return json(res, status, { participant: participantView });
      }

      if (method === "GET" && action === "state") {
        store.authenticateParticipant(roomId, bearer(req), true);
        status = 200;
        return json(res, status, store.state(roomId));
      }

      if (method === "GET" && action === "workdoc") {
        const participant = store.authenticateParticipant(roomId, bearer(req), true, true);
        status = 200;
        return json(res, status, { workdoc: store.getWorkdoc(participant) });
      }

      if (method === "PUT" && action === "workdoc") {
        const participant = store.authenticateParticipant(roomId, bearer(req));
        const body = objectBody(await readJson(req));
        const content = textField(body, "content", { max: 8_192 })!;
        const expectedVersion = integerField(body, "expectedVersion", { min: 1, max: Number.MAX_SAFE_INTEGER, optional: true });
        status = 200;
        return json(res, status, { workdoc: store.updateWorkdoc(participant, content, expectedVersion) });
      }

      if (method === "POST" && action === "leave") {
        const participant = store.authenticateParticipant(roomId, bearer(req));
        const event = store.leave(participant);
        hub.publish(roomId);
        status = 200;
        return json(res, status, { event });
      }

      if (method === "POST" && action === "end") {
        store.authenticateHost(roomId, hostToken(req));
        const event = store.end(roomId);
        hub.publish(roomId);
        status = 200;
        return json(res, status, { event, transcript: store.exportMarkdown(roomId) });
      }

      if (method === "GET" && action === "export") {
        store.authenticateParticipant(roomId, bearer(req), true);
        status = 200;
        return text(res, status, store.exportMarkdown(roomId), "text/markdown; charset=utf-8");
      }

      if (method === "POST" && action === "invite") {
        store.authenticateHost(roomId, hostToken(req));
        const body = objectBody(await readJson(req));
        const inviteMinutes = integerField(body, "inviteMinutes", { min: 1, max: 1_440, fallback: 15 })!;
        status = 200;
        return json(res, status, store.rotateInvite(roomId, inviteMinutes));
      }

      throw new ApiError(405, "method_not_allowed", "Method not allowed.");
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, "internal_error", "An internal error occurred.");
      status = apiError.status;
      if (!(error instanceof ApiError) && !options.quiet) console.error("relayroom: internal request error");
      if (status === 413) res.setHeader("connection", "close");
      if (!res.headersSent) json(res, status, { error: { code: apiError.code, message: apiError.message } });
      else res.end();
    } finally {
      if (!options.quiet) console.log(JSON.stringify({ method: req.method, path: logRoute, status, durationMs: Date.now() - started }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port ?? 8787;
  baseUrl ??= `http://127.0.0.1:${actualPort}`;
  const cleanupTimer = setInterval(() => store.cleanupExpired(), 60 * 60 * 1_000);
  cleanupTimer.unref();

  return {
    server,
    store,
    url: baseUrl,
    async close() {
      clearInterval(cleanupTimer);
      hub.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      store.close();
    },
  };
}
