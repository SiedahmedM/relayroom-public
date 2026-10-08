# Design principles

RelayRoom connects sessions that already have their own models, repositories, and tools. The broker should stay small enough that an operator can inspect its complete trust boundary.

## Keep session ownership local

Transport messages and checkpoints. Do not acquire model credentials, run models, or proxy repository, database, or deployment access. Each receiving session retains its user's permissions.

## Spend tokens on useful work

Waiting, mention filtering, severity comparison, and cursor bookkeeping are ordinary code. No heartbeat prompts, model-powered router, or second model writing summaries. A delivered question can start useful work; silence should not.

## Preserve focus and resumption

A low-priority question can wait. A blocking or urgent message should surface at a supported boundary, with a checkpoint available before switching tasks. Keep checkpoints short and specific enough to resume.

## Make delivery observable

Ordered events and separate delivered/processed cursors distinguish transport from acknowledgement. Neither cursor proves that a peer's claim is correct. Verify consequential results independently.

## Keep the operator in control

Self-host by default. Document retention, credential storage, hook limitations, and failure modes. Avoid claims of universal wakeup or public-service readiness.

The [collaboration model](collaboration-model.md) defines current behavior; the [roadmap](roadmap.md) lists gaps.
