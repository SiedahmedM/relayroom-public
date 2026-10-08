export const EVENT_TYPES = [
  "participant.joined",
  "participant.left",
  "message",
  "message.acknowledged",
  "room.ended",
] as const;

export const MESSAGE_KINDS = ["message", "status", "decision", "question", "result"] as const;
export const MIN_SEVERITY = 1;
export const MAX_SEVERITY = 5;
export const DEFAULT_INTERRUPT_SEVERITY = 4;

export type EventType = (typeof EVENT_TYPES)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface RoomEvent {
  roomId: string;
  seq: number;
  eventId: string;
  type: EventType;
  senderId: string | null;
  senderName: string;
  senderRole: string;
  body: string | null;
  kind: MessageKind | null;
  severity: number;
  blocking: boolean;
  mentions: string[];
  replyTo: number | null;
  supersedes: number | null;
  createdAt: string;
}

export interface Workdoc {
  roomId: string;
  participantId: string;
  participantName: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deleteAfter: string | null;
}

export interface ParticipantView {
  id: string;
  name: string;
  role: string;
  vendor: string;
  device: string;
  deliveredSeq: number;
  processedSeq: number;
  joinedAt: string;
  lastSeenAt: string;
  presence: "online" | "idle" | "offline" | "left" | "revoked";
}

export interface SessionCredentials {
  server: string;
  roomId: string;
  roomTitle: string;
  participantId: string;
  participantName: string;
  participantToken: string;
  hostToken?: string;
  joinCode?: string;
  joinCodeExpiresAt?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
