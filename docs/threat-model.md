# Threat model

RelayRoom is intended for a trusted self-hosted environment. It is not an anonymous hosted service or an authorization channel.

## Capabilities and identity

Join codes contain 60 random bits and expire after 15 minutes by default. Participant and host tokens each contain 256 random bits. SQLite stores SHA-256 hashes of the secret pepper, a separator, and each capability. Protect the pepper separately from database backups.

Participant tokens identify a sender within one room; the server ignores any sender identity in message JSON. Host tokens end rooms and rotate invites. Rotation invalidates the previous invite, not existing participant tokens.

There is no participant-revocation or token-rotation endpoint. Ending a room blocks new collaboration but does not revoke historical read access. A leaked participant token requires restricting access to the server and operator-led credential/data remediation. Do not claim that ending a room erases a disclosure.

## Network boundary

The Node server and Compose host port bind to loopback by default. Put remote access behind TLS and network access controls. Room creation requires no global key or account.

Create/join limits use the socket address. Only literal addresses in `RELAYROOM_TRUSTED_PROXIES` can supply `X-Forwarded-For`, and only a single valid IP is accepted. A trusted proxy must overwrite the header and prevent bypass access. Chains and malformed values fall back to the socket. No forwarded header is used to determine credential destinations.

The server never constructs response server URLs from Host. Set `RELAYROOM_PUBLIC_URL` to your own origin for remote clients.

## Resource limits

Requests are capped at 64 KiB, message text at 16 KiB UTF-8, and workdocs at 8 KiB UTF-8. Create attempts are limited to 10/minute/address, join attempts to 30/minute/address, and sends to 60/minute/participant. There are at most two concurrent long polls per participant and 256 per process; each poll lasts at most 30 seconds and releases on disconnect.

These are local safeguards. Rate limits reset on restart, and there is no total disk quota, account system, distributed limit, or comprehensive denial-of-service protection. Authenticated reads and exports can be expensive. Keep untrusted internet traffic outside the service.

## Data and logs

The operator can read messages, metadata, and workdocs. There is no end-to-end encryption or built-in database encryption. Workdocs have individual write access; room exports expose them to active participants.

Application logs include method, route template, status, and duration. They omit raw paths, room IDs, invite codes, queries, tokens, and message bodies. Configure reverse-proxy logs similarly: join codes appear in incoming paths. Exported transcripts, vendor hook logs, backups, and local profiles can contain sensitive data.

Retention deletes database records on an hourly sweep. SQLite free pages, WAL files, backups, exports, and vendor transcripts may retain content. Logical deletion is not secure erasure.

## Local state

New state directories use Unix mode 0700, and credential files use 0600. Writes use exclusively created, random temporary files, atomic rename, and cleanup on failure. Cooperating writers serialize through a lock directory; a five-second acquisition timeout reports recovery instructions instead of stealing an old lock.

Existing parent-directory permissions are not repaired. Windows uses the account's filesystem ACLs, not DPAPI; macOS uses files, not Keychain. Protect the OS account and do not place state in a shared directory. Hook configuration is executable code and must be reviewed.

## Prompt injection

Authentication proves participant identity, not authority. Interrupt, idle-wake, and restored contexts label peer/stored text as untrusted. A peer can still send malicious instructions. These labels are not a model sandbox and cannot guarantee resistance to prompt injection. The receiving user's permissions and review remain the authority for consequential actions.

Severity and blocking flags change delivery timing only. RelayRoom does not approve tool permissions or execute commands from messages.
