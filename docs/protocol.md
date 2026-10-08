# RelayRoom protocol

The HTTP route prefix remains `/v1` for backward compatibility. `/health` reports semantic protocol `relayroom/2` because v2 adds message priority and workdocs.

## Invariants

- A room has one monotonically increasing `seq` space.
- Events are immutable; corrections are new events with `supersedes`.
- Delivery is at least once; `(room, sender, idempotencyKey)` makes retries effectively once.
- `deliveredSeq` and `processedSeq` are separate and only move forward.
- Sender identity comes from the bearer token, never request JSON.
- Invite, participant, and host credentials are separate scoped capabilities.
- Severity changes delivery timing, never trust or authorization.

## Endpoints

```text
GET    /health
POST   /v1/rooms
POST   /v1/rooms/{code}/join
POST   /v1/rooms/{roomId}/messages
GET    /v1/rooms/{roomId}/events?after=N&wait=SECONDS
POST   /v1/rooms/{roomId}/acks
GET    /v1/rooms/{roomId}/state
GET    /v1/rooms/{roomId}/workdoc
PUT    /v1/rooms/{roomId}/workdoc
POST   /v1/rooms/{roomId}/leave
POST   /v1/rooms/{roomId}/end
GET    /v1/rooms/{roomId}/export
POST   /v1/rooms/{roomId}/invite
```

Participant routes use `Authorization: Bearer TOKEN`; host routes use `X-Host-Token: TOKEN`. Event long polls are capped at 30 seconds per request. The CLI reconnects silently for an indefinite wait.

## Message event

```json
{
  "roomId": "rm_...",
  "seq": 42,
  "eventId": "01...",
  "type": "message",
  "senderId": "pt_...",
  "senderName": "Mac-iOS",
  "senderRole": "ios",
  "body": "@Web-PC Decoder repro confirmed.",
  "kind": "status",
  "severity": 4,
  "blocking": false,
  "mentions": ["Web-PC"],
  "replyTo": 39,
  "supersedes": null,
  "createdAt": "2026-08-20T02:12:32.000Z"
}
```

`severity` is an integer 1–5 and defaults to 1. `blocking` is a boolean and defaults to false. Required event types are `participant.joined`, `participant.left`, `message`, and `room.ended`.

## Workdoc

```json
{
  "roomId": "rm_...",
  "participantId": "pt_...",
  "participantName": "Mac-iOS",
  "content": "## Current task\n...\n\n## Next step\n...",
  "version": 2,
  "createdAt": "2026-08-20T02:00:00.000Z",
  "updatedAt": "2026-08-20T02:20:00.000Z",
  "deleteAfter": null
}
```

`PUT workdoc` accepts `content` and optional `expectedVersion`. A stale expected version returns `409 workdoc_conflict`. Active participants may update their own workdoc. Ended rooms and participants who left may still read their own workdoc until deletion. Room exports include all participants' workdocs; they are not confidential within the room.

## Retention

Rooms default to 72 hours from creation. Ending a room blocks writes but does not immediately erase its history. An hourly sweep removes expired-room events, retains room/participant credentials for seven more days to allow checkpoint retrieval, and deletes workdocs seven days after leave, end, or expiry. Read routes allow closed rooms until cleanup. Backups, exports, vendor transcripts, and SQLite free pages are outside this logical-deletion schedule.

## Limits

- 8 participants maximum.
- 16 KiB message text and 8 KiB workdoc content measured as UTF-8 bytes; 64 KiB HTTP JSON body.
- 10 create attempts and 30 join attempts per source address per minute.
- 60 messages per participant per minute.
- At most two concurrent long polls per participant and 256 per server, with disconnect cancellation.
- Events are paged in batches of 100; exports include at most 100,000 events.
- Invite codes default to 15 minutes.
- Rooms default to 72 hours, minimum 12 hours, maximum 168 hours.
- One server process and one persistent SQLite volume.
