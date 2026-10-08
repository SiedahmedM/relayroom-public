# Vendor lifecycle contracts

Last verified against official documentation: **2026-10-07**.

These are documentation checks and adapter tests, not live certification of every vendor release. The installed client controls when a hook runs and whether a continuation survives. RelayRoom uses command hooks only.

## Codex

[Official hook documentation](https://learn.chatgpt.com/docs/hooks).

Configuration lives in `~/.codex/hooks.json`; inline TOML and project layers are also supported. JSON nests `hooks.EVENT[]` matcher groups containing command handlers. RelayRoom installs `SessionStart`, `PostToolUse`, `PreCompact`, and `Stop`.

Input includes `session_id`, `cwd`, and `hook_event_name`. Context output uses `hookSpecificOutput: {hookEventName, additionalContext}`. Stop accepts `{decision: "block", reason: "..."}`, creating a continuation prompt. `stop_hook_active` identifies a continued turn.

Timeout values are seconds; most events default to 600. RelayRoom explicitly requests 15 seconds for checks and 604800 for Stop. That request is not proof of seven-day application availability. `commandWindows` is the documented Windows override.

Non-managed hooks require review of the current definition; changed definitions require renewed trust. Use the vendor's hook review interface. RelayRoom does not bypass trust.

## Claude Code

[Official hook reference](https://code.claude.com/docs/en/hooks).

RelayRoom merges `~/.claude/settings.json` using event arrays of matcher groups and command handlers. It installs `SessionStart`, `PostToolUse`, `PreCompact`, and `Stop`. JSON stdin includes `session_id`, `cwd`, and `hook_event_name`.

Session/tool context uses `hookSpecificOutput: {hookEventName, additionalContext}`. Stop supports `{decision: "block", reason: "..."}`; `stop_hook_active` identifies continued turns. The documented default cap is eight consecutive Stop continuations, reset by tool calls. RelayRoom suppresses repeated unconditional checkpoint prompts.

Timeouts are in seconds; command hooks generally default to 600. The installer requests 15 for checks and 604800 for Stop, without guaranteeing that a host will remain alive.

Review hook settings as executable code with the user's filesystem permissions. Confirm activation in the installed client's hook interface; this audit does not establish a universal reload guarantee. PreCompact notification is not a guaranteed opportunity for another model-written checkpoint.

## Cursor

[Official hook reference](https://cursor.com/docs/hooks).

RelayRoom writes `~/.cursor/hooks.json` with `version: 1` and flat handler arrays under `sessionStart`, `postToolUse`, `preCompact`, and `stop`.

Input includes `hook_event_name`, `conversation_id`, and workspace roots; sessionStart also supplies `session_id`. Context output is `{additional_context: "..."}`. Stop receives `status` and `loop_count`; output `{followup_message: "..."}` can submit another turn. RelayRoom ignores aborted/error Stop events.

The documented default loop limit is five; `loop_limit: null` removes that cap, which the installer explicitly requests. Timeouts are seconds; RelayRoom requests 15 for checks and 604800 for Stop. The reference leaves the platform default unspecified.

SessionStart is fire-and-forget. PreCompact is observational. These cannot enforce a fresh checkpoint. Review configuration before enabling it; this reference does not establish a Codex-style per-definition trust mechanism.

## Verification scope

Tests invoke the real adapters with vendor-shaped JSON, verify context and continuation outputs, reject aborted Cursor continuations, and test configuration preservation/idempotence. Windows also executes the generated Codex launcher with a fixture process to check paths, stdin, and exit status.

No model is called by these tests. Live acceptance still requires two sessions in each installed vendor: checkpoint, send low/urgent mentions, observe deferred/active delivery, interrupt a wait, resume, and inspect vendor logs.

No hook can wake a fully closed application. RelayRoom does not own an app-server or SDK session, and makes no guarantee of mid-reasoning preemption.
