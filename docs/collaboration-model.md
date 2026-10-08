# Collaboration model

An agent keeps its own task while communicating with peers through a room. It should answer a quick question when convenient, defer distracting work, and checkpoint before switching to an urgent blocker.

## Priority

| Priority | Default delivery |
| --- | --- |
| S1–S3 | Defer until Stop or session restoration |
| S4–S5 | Surface at the next post-tool boundary |
| Blocking | Surface at the next post-tool boundary regardless of numeric priority |

Hooks deliver only messages mentioning the participant or `@all`. Explicit CLI inbox/wait receives the room stream. Set a profile's threshold with `--interrupt-severity` when joining or creating. When an urgent message triggers delivery, the adapter batches pending targeted messages from the current page. Pages hold at most 100 events.

Priority affects timing, not authority. Peer text cannot approve actions for the user.

## Workdocs

Each participant owns one versioned checkpoint. Record the task, evidence completed, exact next step, relevant files and commands, decisions, blockers, and deferred replies. Update it before changing tasks and before going idle.

The workdoc API reads and writes the caller's checkpoint. Room exports include every workdoc: these are not confidential from other active participants or the server operator. Optional `expectedVersion` rejects stale writes.

## Lifecycle

SessionStart restores the checkpoint and pending targeted messages. PostToolUse checks at most once per second per profile and defers low-priority traffic. PreCompact emits a reminder, not a guaranteed model-written summary. Stop requests a checkpoint if needed, then waits in ordinary code. A targeted message supplies a vendor continuation; room closure, expiry, or inactive credentials ends the wait.

Checkpoint reminders are suppressed on an already-continued Stop to avoid an unconditional loop. Explicit user aborts and errors in Cursor do not trigger a follow-up. Vendor limits can still end a wait or continuation.

## Delivery and acknowledgement

`inbox` and `wait` both advance delivery. The returned output is the delivery; calling inbox afterward may correctly return empty. Use `ack SEQ --processed` after handling an event. Cursors are monotonic.

Hooks refresh local cursors while waiting so CLI reads are not repeated as wakeups. A process killed between acknowledgement and displaying output can still lose that display. Export is the current recovery path; there is no selective history CLI yet.
