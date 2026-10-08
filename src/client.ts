import { randomUUID } from "node:crypto";
import type { MessageKind, RoomEvent, Workdoc } from "./model.js";
import type { Profile } from "./state.js";

interface RequestOptions {
  method?: string;
  participantToken?: string;
  hostToken?: string;
  body?: unknown;
  timeoutMs?: number;
  accept?: string;
}

export class ClientError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export class RelayRoomClient {
  constructor(private readonly server: string) {}

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: options.accept ?? "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.participantToken) headers.authorization = `Bearer ${options.participantToken}`;
    if (options.hostToken) headers["x-host-token"] = options.hostToken;
    let response: Response;
    try {
      response = await fetch(`${this.server.replace(/\/$/, "")}${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 35_000),
      });
    } catch (error) {
      throw new ClientError(0, "network_error", `Cannot reach ${this.server}: ${(error as Error).message}`);
    }
    const raw = await response.text();
    if (!response.ok) {
      try {
        const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string } };
        throw new ClientError(response.status, parsed.error?.code ?? "request_failed", parsed.error?.message ?? raw);
      } catch (error) {
        if (error instanceof ClientError) throw error;
        throw new ClientError(response.status, "request_failed", raw || response.statusText);
      }
    }
    if ((options.accept ?? "").includes("text/markdown")) return raw as T;
    return JSON.parse(raw) as T;
  }

  create(input: Record<string, unknown>) {
    return this.request<any>("/v1/rooms", { method: "POST", body: input });
  }

  join(code: string, input: Record<string, unknown>) {
    return this.request<any>(`/v1/rooms/${encodeURIComponent(code)}/join`, { method: "POST", body: input });
  }

  say(profile: Profile, body: string, options: { kind: MessageKind; severity?: number; blocking?: boolean; replyTo?: number; supersedes?: number; idempotencyKey?: string }) {
    return this.request<{ event: RoomEvent }>(`/v1/rooms/${profile.roomId}/messages`, {
      method: "POST",
      participantToken: profile.participantToken,
      body: {
        body,
        kind: options.kind,
        severity: options.severity ?? 1,
        blocking: options.blocking ?? false,
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
        ...(options.supersedes ? { supersedes: options.supersedes } : {}),
      },
    });
  }

  events(profile: Profile, after: number, waitSeconds: number) {
    return this.request<{ events: RoomEvent[]; latestSeq: number }>(
      `/v1/rooms/${profile.roomId}/events?after=${after}&wait=${waitSeconds}`,
      { participantToken: profile.participantToken, timeoutMs: (waitSeconds + 5) * 1_000 },
    );
  }

  ack(profile: Profile, deliveredSeq?: number, processedSeq?: number) {
    return this.request<any>(`/v1/rooms/${profile.roomId}/acks`, {
      method: "POST",
      participantToken: profile.participantToken,
      body: {
        ...(deliveredSeq !== undefined ? { deliveredSeq } : {}),
        ...(processedSeq !== undefined ? { processedSeq } : {}),
      },
    });
  }

  state(profile: Profile) {
    return this.request<any>(`/v1/rooms/${profile.roomId}/state`, { participantToken: profile.participantToken });
  }

  getWorkdoc(profile: Profile) {
    return this.request<{ workdoc: Workdoc }>(`/v1/rooms/${profile.roomId}/workdoc`, { participantToken: profile.participantToken });
  }

  updateWorkdoc(profile: Profile, content: string, expectedVersion?: number) {
    return this.request<{ workdoc: Workdoc }>(`/v1/rooms/${profile.roomId}/workdoc`, {
      method: "PUT",
      participantToken: profile.participantToken,
      body: { content, ...(expectedVersion !== undefined ? { expectedVersion } : {}) },
    });
  }

  leave(profile: Profile) {
    return this.request<any>(`/v1/rooms/${profile.roomId}/leave`, { method: "POST", participantToken: profile.participantToken });
  }

  end(profile: Profile) {
    if (!profile.hostToken) throw new Error("Only the room host can end this room.");
    return this.request<{ event: RoomEvent; transcript: string }>(`/v1/rooms/${profile.roomId}/end`, {
      method: "POST",
      hostToken: profile.hostToken,
    });
  }

  export(profile: Profile) {
    return this.request<string>(`/v1/rooms/${profile.roomId}/export`, {
      participantToken: profile.participantToken,
      accept: "text/markdown",
    });
  }

  rotateInvite(profile: Profile, inviteMinutes: number) {
    if (!profile.hostToken) throw new Error("Only the room host can rotate the invite.");
    return this.request<{ code: string; codeExpiresAt: string }>(`/v1/rooms/${profile.roomId}/invite`, {
      method: "POST",
      hostToken: profile.hostToken,
      body: { inviteMinutes },
    });
  }
}

export type { Profile } from "./state.js";
