import { DatabaseSync } from "node:sqlite";
import { ApiError, type EventType, type MessageKind, type ParticipantView, type RoomEvent, type Workdoc } from "./model.js";
import { hashSecret, joinCode, normalizeJoinCode, opaqueId, secret, ulid } from "./crypto.js";

interface RoomRow {
  id: string;
  title: string;
  code_hash: string;
  code_expires_at: string;
  max_participants: number;
  next_seq: number;
  host_hash: string;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
}

interface ParticipantRow {
  id: string;
  room_id: string;
  name: string;
  role: string;
  vendor: string;
  device: string;
  token_hash: string;
  delivered_seq: number;
  processed_seq: number;
  joined_at: string;
  last_seen_at: string;
  left_at: string | null;
  revoked_at: string | null;
}

interface EventRow {
  room_id: string;
  seq: number;
  event_id: string;
  type: EventType;
  sender_id: string | null;
  sender_name: string;
  sender_role: string;
  body: string | null;
  kind: MessageKind | null;
  severity: number;
  blocking: number;
  mentions_json: string;
  reply_to: number | null;
  supersedes: number | null;
  idempotency_key: string | null;
  created_at: string;
}

interface WorkdocRow {
  room_id: string;
  participant_id: string;
  participant_name: string;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
  delete_after: string | null;
}

export interface CreateRoomInput {
  title: string;
  name: string;
  role: string;
  vendor: string;
  device: string;
  maxParticipants: number;
  inviteMinutes: number;
  retentionHours: number;
  publicServer: string;
}

export interface JoinRoomInput {
  code: string;
  name: string;
  role: string;
  vendor: string;
  device: string;
  publicServer: string;
}

export interface AppendInput {
  type: EventType;
  sender: ParticipantRow | null;
  senderName?: string;
  senderRole?: string;
  body?: string | null;
  kind?: MessageKind | null;
  severity?: number;
  blocking?: boolean;
  mentions?: string[];
  replyTo?: number | null;
  supersedes?: number | null;
  idempotencyKey?: string | null;
}

export class SqliteStore {
  readonly db: DatabaseSync;

  constructor(path: string, private readonly pepper: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        code_expires_at TEXT NOT NULL,
        max_participants INTEGER NOT NULL,
        next_seq INTEGER NOT NULL DEFAULT 1,
        host_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        vendor TEXT NOT NULL,
        device TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        delivered_seq INTEGER NOT NULL DEFAULT 0,
        processed_seq INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        left_at TEXT,
        revoked_at TEXT,
        UNIQUE(room_id, name)
      );
      CREATE TABLE IF NOT EXISTS events (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT NOT NULL,
        sender_role TEXT NOT NULL,
        body TEXT,
        kind TEXT,
        severity INTEGER NOT NULL DEFAULT 1,
        blocking INTEGER NOT NULL DEFAULT 0,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        reply_to INTEGER,
        supersedes INTEGER,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(room_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency
        ON events(room_id, sender_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL AND sender_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS events_after ON events(room_id, seq);
      CREATE INDEX IF NOT EXISTS participants_room ON participants(room_id);
      CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms(expires_at);
      CREATE TABLE IF NOT EXISTS workdocs (
        room_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        participant_name TEXT NOT NULL,
        content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delete_after TEXT,
        PRIMARY KEY(room_id, participant_id)
      );
      CREATE INDEX IF NOT EXISTS workdocs_expiry ON workdocs(delete_after);
    `);
    const eventColumns = new Set((this.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!eventColumns.has("severity")) this.db.exec("ALTER TABLE events ADD COLUMN severity INTEGER NOT NULL DEFAULT 1");
    if (!eventColumns.has("blocking")) this.db.exec("ALTER TABLE events ADD COLUMN blocking INTEGER NOT NULL DEFAULT 0");
    const missingWorkdocs = this.db.prepare(`
      SELECT p.* FROM participants p
      LEFT JOIN workdocs w ON w.room_id = p.room_id AND w.participant_id = p.id
      WHERE w.participant_id IS NULL
    `).all() as unknown as ParticipantRow[];
    for (const participant of missingWorkdocs) {
      this.createWorkdocUnsafe(participant.room_id, participant, participant.joined_at);
      const room = this.roomById(participant.room_id);
      const closedAt = participant.left_at ?? room?.ended_at ?? (room && room.expires_at <= new Date().toISOString() ? room.expires_at : null);
      if (closedAt) {
        this.db.prepare("UPDATE workdocs SET delete_after = ? WHERE room_id = ? AND participant_id = ?")
          .run(this.workdocDeleteAfter(closedAt), participant.room_id, participant.id);
      }
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private hash(value: string): string {
    return hashSecret(value, this.pepper);
  }

  createRoom(input: CreateRoomInput) {
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.retentionHours * 3_600_000).toISOString();
    const codeExpiresAt = new Date(now.getTime() + input.inviteMinutes * 60_000).toISOString();
    const roomId = opaqueId("rm");
    const participantId = opaqueId("pt");
    const hostToken = secret();
    const participantToken = secret();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = joinCode();
      try {
        return this.transaction(() => {
          this.db.prepare(`
            INSERT INTO rooms (id, title, code_hash, code_expires_at, max_participants, host_hash, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(roomId, input.title, this.hash(normalizeJoinCode(code)), codeExpiresAt, input.maxParticipants, this.hash(hostToken), createdAt, expiresAt);
          this.db.prepare(`
            INSERT INTO participants (id, room_id, name, role, vendor, device, token_hash, joined_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(participantId, roomId, input.name, input.role, input.vendor, input.device, this.hash(participantToken), createdAt, createdAt);
          const event = this.appendEventUnsafe(roomId, {
            type: "participant.joined",
            sender: this.participantById(participantId),
            body: `${input.name} joined the room.`,
          });
          this.createWorkdocUnsafe(roomId, this.participantById(participantId), createdAt);
          return {
            server: input.publicServer,
            roomId,
            roomTitle: input.title,
            code,
            codeExpiresAt,
            expiresAt,
            hostToken,
            participant: this.publicParticipant(this.participantById(participantId)),
            participantToken,
            event,
          };
        });
      } catch (error) {
        if (String(error).includes("rooms.code_hash")) continue;
        throw error;
      }
    }
    throw new ApiError(500, "code_generation_failed", "Could not allocate a unique room code.");
  }

  joinRoom(input: JoinRoomInput) {
    return this.transaction(() => {
      const room = this.db.prepare("SELECT * FROM rooms WHERE code_hash = ?").get(this.hash(normalizeJoinCode(input.code))) as RoomRow | undefined;
      this.assertRoomActive(room);
      if (room!.code_expires_at <= new Date().toISOString()) {
        throw new ApiError(410, "invite_expired", "This room code has expired. Ask the host to rotate it.");
      }
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM participants WHERE room_id = ? AND left_at IS NULL AND revoked_at IS NULL").get(room!.id) as { count: number };
      if (count.count >= room!.max_participants) throw new ApiError(409, "room_full", "This room is full.");
      const existing = this.db.prepare("SELECT id FROM participants WHERE room_id = ? AND lower(name) = lower(?)").get(room!.id, input.name);
      if (existing) throw new ApiError(409, "name_taken", "That participant name is already in use in this room.");

      const participantId = opaqueId("pt");
      const participantToken = secret();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO participants (id, room_id, name, role, vendor, device, token_hash, joined_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(participantId, room!.id, input.name, input.role, input.vendor, input.device, this.hash(participantToken), now, now);
      const participant = this.participantById(participantId);
      const event = this.appendEventUnsafe(room!.id, {
        type: "participant.joined",
        sender: participant,
        body: `${input.name} joined the room.`,
      });
      this.createWorkdocUnsafe(room!.id, participant, now);
      return {
        server: input.publicServer,
        roomId: room!.id,
        roomTitle: room!.title,
        expiresAt: room!.expires_at,
        participant: this.publicParticipant(participant),
        participantToken,
        event,
      };
    });
  }

  authenticateParticipant(roomId: string, token: string, allowEnded = false, allowInactive = false): ParticipantRow {
    const room = this.roomById(roomId);
    this.assertRoomActive(room, allowEnded);
    const participant = this.db.prepare("SELECT * FROM participants WHERE room_id = ? AND token_hash = ?").get(roomId, this.hash(token)) as ParticipantRow | undefined;
    if (!participant || participant.revoked_at || (!allowInactive && participant.left_at)) {
      throw new ApiError(401, "invalid_participant_token", "The participant token is invalid or inactive.");
    }
    const now = new Date().toISOString();
    this.db.prepare("UPDATE participants SET last_seen_at = ? WHERE id = ?").run(now, participant.id);
    participant.last_seen_at = now;
    return participant;
  }

  authenticateHost(roomId: string, token: string): RoomRow {
    const room = this.roomById(roomId);
    if (!room || room.host_hash !== this.hash(token)) throw new ApiError(401, "invalid_host_token", "The host token is invalid.");
    return room;
  }

  appendEvent(roomId: string, input: AppendInput): RoomEvent {
    return this.transaction(() => this.appendEventUnsafe(roomId, input));
  }

  private appendEventUnsafe(roomId: string, input: AppendInput): RoomEvent {
    if (input.idempotencyKey && input.sender) {
      const prior = this.db.prepare("SELECT * FROM events WHERE room_id = ? AND sender_id = ? AND idempotency_key = ?").get(roomId, input.sender.id, input.idempotencyKey) as EventRow | undefined;
      if (prior) return this.eventFromRow(prior);
    }
    const room = this.roomById(roomId);
    this.assertRoomActive(room);
    const seq = room!.next_seq;
    const now = new Date().toISOString();
    const eventId = ulid();
    const senderName = input.sender?.name ?? input.senderName ?? "RelayRoom";
    const senderRole = input.sender?.role ?? input.senderRole ?? "system";
    this.db.prepare(`
      INSERT INTO events (
        room_id, seq, event_id, type, sender_id, sender_name, sender_role, body, kind, severity, blocking,
        mentions_json, reply_to, supersedes, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      roomId, seq, eventId, input.type, input.sender?.id ?? null, senderName, senderRole,
      input.body ?? null, input.kind ?? null, input.severity ?? 1, input.blocking ? 1 : 0,
      JSON.stringify(input.mentions ?? []), input.replyTo ?? null,
      input.supersedes ?? null, input.idempotencyKey ?? null, now,
    );
    this.db.prepare("UPDATE rooms SET next_seq = next_seq + 1 WHERE id = ?").run(roomId);
    return this.eventFromRow(this.db.prepare("SELECT * FROM events WHERE room_id = ? AND seq = ?").get(roomId, seq) as unknown as EventRow);
  }

  eventsAfter(roomId: string, after: number, limit = 100): RoomEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(roomId, after, limit) as unknown as EventRow[]).map((row) => this.eventFromRow(row));
  }

  acknowledge(participant: ParticipantRow, deliveredSeq: number | undefined, processedSeq: number | undefined): ParticipantView {
    const room = this.roomById(participant.room_id);
    this.assertRoomActive(room);
    const maxSeq = room!.next_seq - 1;
    if ((deliveredSeq ?? 0) > maxSeq || (processedSeq ?? 0) > maxSeq) {
      throw new ApiError(400, "invalid_cursor", `A cursor cannot exceed the latest sequence (${maxSeq}).`);
    }
    const resultingDelivered = Math.max(participant.delivered_seq, deliveredSeq ?? participant.delivered_seq);
    const resultingProcessed = Math.max(participant.processed_seq, processedSeq ?? participant.processed_seq);
    if (resultingProcessed > resultingDelivered) {
      throw new ApiError(400, "invalid_cursor", "processedSeq cannot exceed deliveredSeq.");
    }
    this.db.prepare(`
      UPDATE participants SET
        delivered_seq = max(delivered_seq, ?),
        processed_seq = max(processed_seq, ?),
        last_seen_at = ?
      WHERE id = ?
    `).run(resultingDelivered, resultingProcessed, new Date().toISOString(), participant.id);
    return this.publicParticipant(this.participantById(participant.id));
  }

  state(roomId: string) {
    const room = this.roomById(roomId)!;
    const participants = this.db.prepare("SELECT * FROM participants WHERE room_id = ? ORDER BY joined_at").all(roomId) as unknown as ParticipantRow[];
    return {
      room: {
        id: room.id,
        title: room.title,
        latestSeq: room.next_seq - 1,
        createdAt: room.created_at,
        expiresAt: room.expires_at,
        endedAt: room.ended_at,
      },
      participants: participants.map((row) => this.publicParticipant(row)),
    };
  }

  leave(participant: ParticipantRow): RoomEvent {
    return this.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare("UPDATE participants SET left_at = ?, last_seen_at = ? WHERE id = ?").run(now, now, participant.id);
      this.db.prepare("UPDATE workdocs SET delete_after = ? WHERE room_id = ? AND participant_id = ?")
        .run(this.workdocDeleteAfter(now), participant.room_id, participant.id);
      return this.appendEventUnsafe(participant.room_id, {
        type: "participant.left",
        sender: participant,
        body: `${participant.name} left the room.`,
      });
    });
  }

  end(roomId: string): RoomEvent {
    return this.transaction(() => {
      const room = this.roomById(roomId);
      if (!room) throw new ApiError(404, "room_not_found", "Room not found.");
      if (room.ended_at) {
        return this.eventsAfter(roomId, Math.max(0, room.next_seq - 2), 1)[0]!;
      }
      const event = this.appendEventUnsafe(roomId, {
        type: "room.ended",
        sender: null,
        body: "The host ended the room.",
      });
      this.db.prepare("UPDATE rooms SET ended_at = ? WHERE id = ?").run(new Date().toISOString(), roomId);
      this.db.prepare("UPDATE workdocs SET delete_after = ? WHERE room_id = ? AND delete_after IS NULL")
        .run(this.workdocDeleteAfter(), roomId);
      return event;
    });
  }

  rotateInvite(roomId: string, inviteMinutes: number): { code: string; codeExpiresAt: string } {
    const code = joinCode();
    const codeExpiresAt = new Date(Date.now() + inviteMinutes * 60_000).toISOString();
    this.db.prepare("UPDATE rooms SET code_hash = ?, code_expires_at = ? WHERE id = ?").run(this.hash(normalizeJoinCode(code)), codeExpiresAt, roomId);
    return { code, codeExpiresAt };
  }

  exportMarkdown(roomId: string): string {
    const state = this.state(roomId);
    const events = this.eventsAfter(roomId, 0, 100_000);
    const lines = [
      `# ${state.room.title}`,
      "",
      `Room: \`${state.room.id}\``,
      `Created: ${state.room.createdAt}`,
      `Ended: ${state.room.endedAt ?? "active"}`,
      "",
      "## Participants",
      "",
      ...state.participants.map((p) => `- ${p.name} — ${p.role}, ${p.vendor}, ${p.device}`),
      "",
      "## Workdocs",
      "",
      ...this.workdocsForRoom(roomId).flatMap((doc) => [
        `### ${doc.participantName}`,
        "",
        `Updated: ${doc.updatedAt}`,
        "",
        doc.content,
        "",
      ]),
      "## Transcript",
      "",
    ];
    for (const event of events) {
      const label = event.kind ? ` [${event.kind.toUpperCase()}]` : "";
      lines.push(`### ${event.seq}. ${event.senderName}${label}`, "", `${event.createdAt}`, "", event.body ?? `_${event.type}_`, "");
    }
    return `${lines.join("\n")}\n`;
  }

  cleanupExpired(): number {
    const now = new Date().toISOString();
    return this.transaction(() => {
      const expired = this.db.prepare("SELECT id, expires_at FROM rooms WHERE expires_at <= ?").all(now) as Array<{ id: string; expires_at: string }>;
      for (const room of expired) {
        this.db.prepare("UPDATE workdocs SET delete_after = ? WHERE room_id = ? AND delete_after IS NULL")
          .run(this.workdocDeleteAfter(room.expires_at), room.id);
      }
      this.db.prepare("DELETE FROM events WHERE room_id IN (SELECT id FROM rooms WHERE expires_at <= ?)").run(now);
      const roomPurgeBefore = new Date(new Date(now).getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
      const result = this.db.prepare("DELETE FROM rooms WHERE expires_at <= ?").run(roomPurgeBefore);
      this.db.prepare("DELETE FROM workdocs WHERE delete_after IS NOT NULL AND delete_after <= ?").run(now);
      return Number(result.changes);
    });
  }

  getWorkdoc(participant: ParticipantRow): Workdoc {
    const row = this.db.prepare("SELECT * FROM workdocs WHERE room_id = ? AND participant_id = ?")
      .get(participant.room_id, participant.id) as WorkdocRow | undefined;
    if (!row) throw new ApiError(404, "workdoc_not_found", "Workdoc not found.");
    return this.workdocFromRow(row);
  }

  updateWorkdoc(participant: ParticipantRow, content: string, expectedVersion?: number): Workdoc {
    const current = this.getWorkdoc(participant);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new ApiError(409, "workdoc_conflict", `Workdoc is at version ${current.version}; refresh before overwriting it.`);
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE workdocs SET content = ?, version = version + 1, updated_at = ?, delete_after = NULL
      WHERE room_id = ? AND participant_id = ?
    `).run(content, now, participant.room_id, participant.id);
    return this.getWorkdoc(participant);
  }

  workdocsForRoom(roomId: string): Workdoc[] {
    return (this.db.prepare("SELECT * FROM workdocs WHERE room_id = ? ORDER BY created_at").all(roomId) as unknown as WorkdocRow[])
      .map((row) => this.workdocFromRow(row));
  }

  roomById(roomId: string): RoomRow | undefined {
    return this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as RoomRow | undefined;
  }

  private participantById(id: string): ParticipantRow {
    const row = this.db.prepare("SELECT * FROM participants WHERE id = ?").get(id) as ParticipantRow | undefined;
    if (!row) throw new ApiError(404, "participant_not_found", "Participant not found.");
    return row;
  }

  private assertRoomActive(room: RoomRow | undefined, allowClosed = false): asserts room is RoomRow {
    if (!room) throw new ApiError(404, "room_not_found", "Room not found.");
    if (!allowClosed && room.expires_at <= new Date().toISOString()) throw new ApiError(410, "room_expired", "This room has expired.");
    if (!allowClosed && room.ended_at) throw new ApiError(410, "room_ended", "This room has ended.");
  }

  private publicParticipant(row: ParticipantRow): ParticipantView {
    const age = Date.now() - new Date(row.last_seen_at).getTime();
    const presence = row.revoked_at ? "revoked" : row.left_at ? "left" : age < 45_000 ? "online" : age < 300_000 ? "idle" : "offline";
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      vendor: row.vendor,
      device: row.device,
      deliveredSeq: row.delivered_seq,
      processedSeq: row.processed_seq,
      joinedAt: row.joined_at,
      lastSeenAt: row.last_seen_at,
      presence,
    };
  }

  private eventFromRow(row: EventRow): RoomEvent {
    return {
      roomId: row.room_id,
      seq: row.seq,
      eventId: row.event_id,
      type: row.type,
      senderId: row.sender_id,
      senderName: row.sender_name,
      senderRole: row.sender_role,
      body: row.body,
      kind: row.kind,
      severity: row.severity,
      blocking: row.blocking === 1,
      mentions: JSON.parse(row.mentions_json) as string[],
      replyTo: row.reply_to,
      supersedes: row.supersedes,
      createdAt: row.created_at,
    };
  }

  private createWorkdocUnsafe(roomId: string, participant: ParticipantRow, now: string): void {
    const content = [
      `# ${participant.name} — room work tracker`,
      "",
      "Current task: Not recorded yet.",
      "Status: Joined the room.",
      "Next step: Record the first concrete task before starting work.",
      "Context to preserve: None yet.",
      "Files and commands: None yet.",
      "Pending replies: None.",
    ].join("\n");
    this.db.prepare(`
      INSERT INTO workdocs (room_id, participant_id, participant_name, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(roomId, participant.id, participant.name, content, now, now);
  }

  private workdocFromRow(row: WorkdocRow): Workdoc {
    return {
      roomId: row.room_id,
      participantId: row.participant_id,
      participantName: row.participant_name,
      content: row.content,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deleteAfter: row.delete_after,
    };
  }

  private workdocDeleteAfter(from = new Date().toISOString()): string {
    return new Date(new Date(from).getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString();
  }
}
