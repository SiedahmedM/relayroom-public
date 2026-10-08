# Reliability notes

These invariants explain the integration coverage and the remaining operational gaps.

## A wait is a delivery

Both CLI wait and inbox acknowledge delivery. Consume the waiting process's stdout instead of discarding it and fetching inbox again. Delivered and processed cursors measure different things.

## Refresh cursors across processes

A Stop hook can outlive a CLI read in the same session. Re-read persisted cursors before the next scan and use their maximum as the lower bound. Otherwise an already-handled message can trigger another model turn.

## Bind profiles deterministically

Use a unique profile per session. Prefer an explicit profile from the create/join tool call, then a matching directory, then the newest unclaimed profile. A duplicate profile must not disable every hook for that vendor. Remove or leave stale profiles and inspect `relayroom profiles` when binding looks wrong.

## Treat hook transport as fallible

The CLI accepts a leading UTF-8 BOM. Stop retries transient failures with exponential backoff from five to sixty seconds; terminal room/authentication failures end the wait. One-shot checks fail open and log an error to stderr.

A vendor can kill a hook on timeout, close, or lifecycle change. Check its hook logs before assuming a peer is waiting. A successful adapter test is not evidence of live application delivery.

## A timed-out write is ambiguous

The server deduplicates messages by room, sender, and idempotency key. The client generates a key per send but does not retry. A timeout may occur after commit; inspect export before repeating a consequential message. Persistent outbox support remains open.

## Checkpoint before compaction

PreCompact is a best-effort reminder. A new model-written checkpoint cannot be guaranteed at that point. Keep the workdoc current during useful work, and preserve decisions that must outlive room retention in ordinary project documentation.

## Process interruption

State writes replace a file atomically; they do not promise power-loss durability. A crashed process can leave a lock directory. Lock age alone is unsafe evidence that the owner died. Recovery requires stopping CLI/hook writers first; see [operations](operations.md#local-state-recovery).
