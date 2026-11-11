# Security and privacy

## Current surface

The current local release has storage/sidePanel permissions, a WhatsApp content script and exact WhatsApp/loopback host grants. The worker verifies UI and content senders separately. Customer text and live drafts remain in memory; settings and bounded hashed deduplication metadata persist locally. The fictional sample uses session storage. Automated verification uses synthetic chats and an injected provider.

## Data handling

Default raw-message storage is false, phone masking is true, and log retention defaults to 30 days. Profile schemas reject disabling masking. Runtime storage/logging must enforce these policies; a schema default alone is not enforcement.

Incoming text is transient pipeline input. Ticket question persistence is optional and must be removed unless allowed by the profile. Never include raw message text, phone numbers, names or document identifiers in diagnostics or audit logs. Hash chat keys with a per-installation salt and profile scope. Hashes remain potentially identifying data and need retention policies too.

## Trust boundaries

Validate extension events, imported profiles, mappings, selector packs, sheet responses, API requests and AI output. Verify runtime ownership and sender origin separately. Use text rendering for external content. Treat customer and sheet text as untrusted; do not evaluate JavaScript or follow embedded instructions.

LLM credentials stay in backend process environment variables. The setup page submits the key to loopback, clears its input and receives only a profile-scoped pairing capability. It never writes the key to browser storage. Explicit Remember connection on this PC stores backend credentials in the private, Git-ignored `.env.connections` file with restrictive permissions; session-only keys expire on restart. Host/Origin checks, setup cookie/CSRF, profile authorization, request/rate limits, timeouts and bounded errors are implemented. No raw-body logging is enabled. Keep this local personal tool on loopback; hosted authentication and encrypted durable credentials remain separate work.

Preset model destinations are fixed. Custom compatible providers require a public HTTPS base URL, validation of every resolved address and a connection pinned to a validated address while verifying the original TLS hostname. Private/special ranges, redirects, credentials in URLs and nonstandard ports are rejected. Keys are reused only for the same provider and canonical destination; stale configuration objects cannot retrieve replacement credentials. Customer messages cannot select the provider, URL or key. See the additional-provider section in [architecture](ARCHITECTURE.md) for compatibility and test limits.

## Extension constraints

Bundle all executable code. Use strict MV3 CSP, minimum permissions and optional host grants where practical. Add identity only when private Sheets OAuth is implemented. Observe only new incoming active-chat messages and never access private WhatsApp internals, contacts, statuses, profile photos or historical chats.

The extension inserts drafts only after a trusted UI action and active-tab/chat/context validation; uncertain identity and nonempty composers block insertion. It never executes Send. The user sends using WhatsApp itself. Takeover and alarm handling remain planned and must meet restart/isolation requirements when implemented.

## Release evidence

Before release: inspect client bundles for secrets, dependency advisories, permissions, redaction, retention deletion, profile isolation, injection defenses and truthful escalation. See [the threat model](THREAT_MODEL.md) and [release checklist](RELEASE_CHECKLIST.md). No production-security claim is made by the initial scaffold.
