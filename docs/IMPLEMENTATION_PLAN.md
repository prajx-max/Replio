# Implementation plan

## Starting point and assumptions

The workspace was empty when inspected on 2026-10-24. Use the existing folder as the repository root. The supplied workflow starts with Milestone 0 and requires stopping at each milestone boundary. No credentials, live WhatsApp account, deployment, or external team notification is required yet.

## Milestone 0 plan

1. Initialize Git and scaffold pnpm workspace boundaries for both apps and five packages.
2. Configure strict TypeScript, ESLint, Prettier, Vitest, shared scripts, and Windows/Linux CI.
3. Define runtime-validated profile, knowledge, message, decision, ticket, follow-up, API, and versioned extension event contracts.
4. Test invalid boundary input, privacy defaults, manual-send markers, exact answer text, and notification metadata requirements.
5. Document the specification, architecture, security constraints, testing, and release gates.
6. Install dependencies, run every check, inspect generated exports and Git diff, and record results.
7. Commit the verified milestone and stop. The next milestone begins after review.

## Roadmap

Milestone 0 is committed at `37e7760`. Milestone 1 implementation plan: extend the workspace with React/Vite browser builds; add a minimal MV3 manifest and three pages; persist validated profile settings through a trusted worker router; deliver a clearly fictional typed sample reply; test storage, routing, UI and a real unpacked Chromium load; document installation and stop before DOM observation.

Milestone 1 is implemented and verified: 52 unit/UI tests, the production bundle and an unpacked Chromium workflow pass. See [the Milestone 1 report](MILESTONE_1_REPORT.md) for evidence, installation and limitations. The next implementation boundary is Milestone 2.

| Milestone | Deliverable                                          | Acceptance gate                                           |
| --------- | ---------------------------------------------------- | --------------------------------------------------------- |
| 0         | Repository, contracts, docs, CI                      | Install, format, lint, types, tests, build                |
| 1         | MV3 shell, worker, popup, panel, settings, typed bus | Load unpacked, persistent profile, mock flow              |
| 2         | Thin WhatsApp adapter and local fixture              | Ignore history/outgoing; detect once; manual draft/send   |
| 3         | Static knowledge, mapping, lexical retrieval         | Exact facts, safe unknowns, multilingual retrieval        |
| 4         | Sheets providers, wizard, cache and sync             | Visible validation errors, offline fallback, isolation    |
| 5         | Importance, tickets, takeover, alarms                | Truthful success/failure, idempotency, restart recovery   |
| 6         | Secure API, grounded AI, evaluations                 | Secrets stay server-side, safe failures, 60 eval cases    |
| 7         | Multi-profile onboarding and migration               | Profile-specific knowledge, settings and strict isolation |
| 8         | Security, accessibility, release, official mock      | Audit, diagnostic redaction, release checklist            |

## Decisions deferred

React/Vite extension bundling is selected and pinned when the shell is introduced. Fastify, SQLite repository adapters, LLM SDKs, and notification integrations are selected when their milestones begin. Private Google OAuth remains an interface until explicitly implemented. Real account or notification tests require a dedicated setup; CI uses local fixtures.

## Authorized adapter and AI release — 2026-10-28

The user explicitly requested the WhatsApp adapter, AI backend, predefined business instructions and a model API-key interface together. This authorizes one combined release across the adapter and selected AI milestone scope, overriding the usual one-milestone stop for this request only. It does not complete every feature in milestones 3–8.

Implemented scope: baseline/observe new incoming text, ordered selector diagnostics, hashed chat identity, stale-safe draft insertion, profile instructions and one operator-entered knowledge record, loopback API, OpenAI/Gemini/Anthropic providers, backend-only runtime keys, pairing, manual or consented generation, and fixture/browser verification. There is no programmatic web send. The operator sends from WhatsApp itself.

Deferred: full retrieval/mapping/Sheets, durable repositories, tickets/notifications, takeover and alarms, profile creation/import, hosted multi-user auth, live multilingual quality evaluations, official transport and production release audit. Native Node HTTP and fetch replace a framework/SDK dependency for this bounded local service; SQLite remains deferred because no customer-message persistence is introduced.

Stop at this integrated boundary after verification and handoff. The next milestone should be selected explicitly. See [release report](WHATSAPP_AI_RELEASE_REPORT.md).

## Authorized web Auto-reply extension — 2026-11-01

After live reading and AI generation worked, the user explicitly chose “Send automatically—change the project rule”. This authorizes one bounded extension release, 0.3.0, superseding the earlier manual-only web rule. It does not authorize the remaining roadmap or reinterpret the official transport mode.

Scope: distinct `AUTO_REPLY_WEB` and separate profile consent; default DRAFT_ONLY and existing settings preserved; generation-only backend compatibility; active-tab/source/composer revalidation and fresh worker authorization; persisted hash-only delivery reservation before Send; fail-closed handling of ambiguous attempts; persistent per-profile/chat pause with explicit resume; visible draft/sending/sent/blocked/unconfirmed states. Automatic generation occurs only for new incoming events. Manual retry produces a draft. Saving settings, reconnecting, resuming and restarting never replay history.

Acceptance: meaningful regressions for disabled mode, missing consent, inactive tab, human-help replies, working hours, source edits/removal, later messages/operator replies, manual composer edits, settings/takeover races, storage failure, profile isolation, duplicate delivery and worker restart; a synthetic unpacked Chrome workflow verifies zero default sends, one opted-in send and pause behavior. Complete all repository checks and stop at this boundary. Sheets, tickets, notifications, alarms, inactive-chat monitoring, bulk sending, hosting and official transport remain deferred.

## Current repair boundary — cooldown continuation 0.3.1

The user's next defect report shows COOLDOWN after two incoming messages. Reproduce the interrupted-generation failure, then fix only live-reply throttling: coalesce pending text to the latest event, wait without invalidating both replies, continue automatically after the configured generation/send cooldown, expose the interval and a truthful waiting state, and preserve all send/ownership/privacy gates. Bounded transport rechecks may advance in-memory work; no alarm permissions, historical reads or durable raw-text scheduling are introduced.

Acceptance: regression coverage for an in-flight second message, a burst after a completed send, zero cooldown, duplicate events, wrong-owner polling, cancellation, freshness expiry, worker recreation and settings persistence; the unpacked Chromium workflow must receive two texts inside the actual cooldown and send only the latest queued reply without a manual Generate action. Verify the full repository checks, rebuild the production artifact, document limitations and stop. Remaining roadmap boundaries are unchanged.

## Current repair boundary — unattended open-chat replies 0.3.2

The user confirmed generation works and requested replies without Generate/Insert/Send clicks; their screenshot shows COMPOSER_BUSY with the generated text still in the composer. Reproduce raw-text/editor-identity false failures, then retain scoped ownership of an insertion into an initially empty composer while tolerating equivalent formatting and editor remounts. Real editing, footer/context changes and all existing send gates must still cancel. Auto-reply may use only the existing fixed localized fallback when a response needs human help; manual/DRAFT_ONLY generation stays a draft. This does not authorize inactive-chat monitoring, bulk messaging, unknown-draft adoption, action claims, or durable follow-ups.

Acceptance: unit and actual Chromium tests for NBSP/paragraph representations, editor replacement, exact draft identity, automatic fallback, preservation of pre-existing text, and trusted editing followed by restored text. Keep API pairing/backend credentials unchanged, run the full repository checks, rebuild version 0.3.2 and stop at this repair boundary.

## Current repair boundary — repeated replies and worker wakeup 0.3.3

The user reports that the first automatic reply succeeds but a later new message is lost, with the workspace reset to Waiting. Reproduce startup resetting an existing observer and a sent tail-row remount swallowing the subsequent incoming row. Split automatic startup resume from explicit baseline reset; force context registration before every new event; preserve same-container row continuity only through a unique known public tail ID. Retain conservative baselines for missing/ambiguous anchors, changed chats/configuration and fresh installs. No history replay, raw-text persistence, keepalive permissions, provider changes or inactive-chat automation.

Acceptance: regressions for resume without history extraction, repeated identical text with distinct IDs, unchanged-diagnostics context registration, changed-profile resume, ambiguous anchors and older/missing bridges. Actual Chromium must send first/second/third replies in the same chat while the extension worker is stopped and woken twice and sent rows are remounted. Run all required checks, rebuild 0.3.3, document the verified scope and stop.

## Current repair boundary — restart-stable backend connection 0.3.4

The user reports UNAUTHORIZED after repeated backend restarts and requests a lasting fix. The existing session-only provider configuration and random pairing are lost on every backend exit. Add an explicit Remember connection on this PC setup choice that saves only backend environment configuration (provider, model, profile ID, key and stable pairing), with private file permissions, validated bounded load, atomic writes, truthful failures, persistent revocation and a session-only option. Keep provider keys out of extension/browser storage and logs. The extension must explain pairing failure separately from rejected provider keys and open setup for the active profile. No anonymous re-pair, authentication bypass, historical replay or customer-text persistence.

Acceptance: real HTTP tests across backend recreation preserve the same pairing and provider credentials, reject cross-profile ownership, persist removal, preserve active configuration after save failure, and refuse corrupted files without secret echoes. The unpacked Chromium workflow must receive and automatically answer a fresh message after the backend is closed/recreated without entering a key or reconnecting the extension. Run all required checks, rebuild 0.3.4, document the one-time upgrade setup and stop. Sheets, hosted auth, tickets and other roadmap work remain deferred.

## Current milestone — Open a newly unread chat and reply (extension 0.4.0)

On 2026-11-06 the user requested automatic opening and replying when another chat becomes unread. This authorizes navigation in the foreground WhatsApp tab after a separate Auto-reply setting is saved. Scope covers observing a fresh unread count, opening that row, confirming the newest incoming text inside the opened chat, and passing it through the existing reply flow. The extension baselines previous unread counts and respects drafts, pause, working hours, freshness and duplicate claims.

Verify Chromium navigation for two concurrent arrivals, correct source and recipient, and a pre-existing unread row. Exercise missing proof, history, hidden tabs, manual drafts, stale grants, restarts and saved mode changes. Run all project checks, rebuild 0.4.0 and stop at this boundary.

## Current milestone — Answer chats already unread at enable (0.4.1)

The user clarified that multiple chats already had unread badges when the assistant was enabled. Add a separately saved business preference to include the initially rendered unread conversations. Verify a current badge at navigation time and the matching unread boundary in the opened chat. Route the latest eligible text through the same worker consent, pause and durable send checks. Preserve fresh-arrival-only behavior for existing profiles until the operator chooses the new setting.

Acceptance requires multiple pre-existing unread conversations answered in sequence in Chromium, each response bound to its own source, and coverage of remounted rows, disabled consent and blocked navigation. Run the full repository checks and build the extension at this boundary.

## Current repair boundary — Resume the unopened unread pass (0.4.2)

The user reports an empty queue after enabling existing-unread handling. Their 0.4.1 report confirms the adapter is connected but cannot distinguish tab visibility from missing sidebar controls. Repair the reproducible visibility reset that discards an unfinished initial pass. Keep unopened existing candidates across tab hiding and equivalent sidebar remounts, revalidate them on return and request fresh grants. Never requeue a clicked chat or admit arrivals observed while hidden. Add privacy-safe list/badge diagnostics without loosening source or send proof.

Verify startup interruption, pending authorization invalidation, changed badges, completed-pass nonreplay, live-arrival cancellation and two existing-unread replies after switching through settings in actual Chromium. Run all repository checks, build 0.4.2 and stop at this repair boundary. Live Chrome inspection remains unavailable in this session because the Windows computer-use helper pipe is missing; synthetic tests cannot establish that every current WhatsApp layout matches the configured selectors.

## Current repair boundary — Detect rendered unread counters (0.4.3)

On 2026-11-08 the user reports that only the selected conversation receives replies. A report captured with another chat still unread detects 19 chat rows and zero numeric badges. Repair bounded semantic badge reading for nested numbers, compound accessible row labels and visually rendered aria-hidden counters. Add a validated selector-pack fallback that matches opaque public unread-marker background and text colors before reading a bounded numeric badge; never read arbitrary previews or use private WhatsApp modules. Keep destination/unread-boundary proof and all worker send checks. A temporary not-ready current context must wait rather than permanently discard a candidate.

Verify both concurrent fresh arrivals and the opted-in existing-unread pass in Chromium using nested, decorative counters without accessible unread labels or test IDs. Include negative cases for hidden counters, ambiguous numbers, unknown/transparent/equal theme colors and numeric previews. Preserve customized selector packs during migration. Run all required checks, build 0.4.3 and stop at this repair boundary. Live Chrome window-state capture currently times out; do not claim the exact live badge markup was inspected.

## Current milestone — Local admin follow-up inbox (0.5.0)

On 2026-11-08 the user requested a place for the admin to see callback requests and questions the assistant cannot resolve, then personally message or call the customer. This authorizes a bounded local inbox slice of milestone 5: persist callback/unresolved work, show chat label/reason/time/optional question, and allow Open/In progress/Resolved/Reopen. Capture callbacks immediately, including while AI work is coalesced. Persist before acknowledging a saved request; storage failure must produce truthful manual-contact wording. A model promise of future contact is replaced with the saved/manual-review acknowledgement rather than taken as proof of a callback or notification.

Default storage contains masked chat labels and scoped hashes only. Full customer questions require the existing per-profile privacy opt-in, exposed in settings with configurable retention. Revocation must remove stored questions; profile isolation, worker restart, duplicate source events and failed writes need regression coverage. The inbox lives in trusted Chrome local storage on this PC, uses the existing storage permission and has a bounded capacity. No external notification, automatic customer follow-up, backend team delivery, contact scraping or new alarm/notification permission is authorized by this milestone.

Acceptance: worker/store/router/core/UI regressions for failure paths, duplicate delivery, restart, active-profile ownership, consent/privacy races, unsupported facts and existing send gates; actual unpacked Chromium must capture an unresolved request and a provider-independent callback, update admin statuses, retain them through worker restart, and honor opt-in/removal of saved questions. Run every repository check, build 0.5.0, record verification and stop at this boundary. The remaining milestone-5 scheduling/real notifications and other roadmap work stay deferred.

## Current milestone — Editable saved follow-up reply (0.5.1)

On 2026-11-09 the user requested their own customer-facing follow-up wording, specifically “Our team will reach out to you soon,” after learning that Reply instructions do not control the fixed acknowledgement. Add a separate saved-follow-up text field and per-business confirmation that the team monitors the inbox and will contact customers as promised. Existing profiles default to the fixed localized acknowledgement. Only a valid nonempty confirmed message can replace the success acknowledgement after durable ticket persistence; the unconfirmed-save response remains fixed.

The custom field is trusted operator policy, not a model instruction. Keep provider-generated promises blocked, reject unsupported past notification/action claims and ungrounded exact facts in this field, preserve final ticket/source/context/consent/send checks, and omit extension-only fields from generation API sync for running-backend compatibility. Verify profile isolation, omitted-field preservation, save failure, commitment revocation and exact custom/default replies in Chromium. Run all repository checks, build 0.5.1 and stop at this boundary. No real team notifications or callback scheduling are introduced.

## Current milestone — Replio display name (0.5.2)

On 2026-11-09 the user requested renaming the product to “Replio — AI Business Assistant.” Update the shared wordmark, extension listing/action title, browser-page titles, settings footer, model-setup header/title and current installation instructions. Preserve compatibility identifiers and stored settings/credentials. This is a display-only patch with the existing icon and layout; verify the normal build/checks and inspect the generated desktop/mobile screenshots, then stop at this boundary.

## Current milestone — More AI providers and custom models (0.6.0)

On 2026-11-09 the user requested provider choices beyond OpenAI, Gemini and Anthropic. Add Groq, DeepSeek, OpenRouter, Mistral, xAI and Together presets plus a custom public HTTPS OpenAI-compatible Chat Completions base URL. Let the operator supply the exact model ID, backend-only API key and JSON mode or prompted JSON response preference. Preserve native provider integrations and enforce the existing reply validation for every model.

Custom destinations require URL validation, public DNS address checks, connection pinning, redirect rejection and bounded/time-limited requests. Changing the provider or custom destination requires a new key; remember/restart must preserve valid settings and pairing without exposing credentials. Add setup UI, persistence, protocol, failure and endpoint-safety regressions and a real browser setup workflow. Run every required check, build 0.6.0, document compatibility limits and stop at this provider milestone.

## Current milestone — Background replies and optional idle-sleep prevention (0.7.0)

On 2026-11-10 the user requested continued replies while switching tabs and during laptop sleep. Add separate per-business background consent within Auto-reply, allowing automatic replies and verified unread navigation in the sole eligible WhatsApp tab while another tab is active. Retain foreground-only manual insertion and all source/chat/profile, takeover, hours, composer, consent and duplicate-delivery checks. Missing background consent keeps the existing foreground behavior. Multiple WhatsApp tabs must not become concurrent background workers.

Add optional Keep computer awake while Replio runs with a user-gesture request for Chrome's optional power permission. Use system-level idle-sleep prevention so the display may turn off, release it when no longer eligible, and reconcile worker restarts. Manage the selected tab's auto-discard setting with restoration of its prior value. Real sleep, shutdown, forced freezing/discarding, closed Chrome/WhatsApp/backend and lost connectivity cannot deliver continuous replies; do not claim otherwise or change OS power plans. Freeze/resume cancels stale work and baselines history.

Verify background sends, sequential unread replies, revocation, duplicate tabs, manual drafts, freeze/resume, runtime cleanup/restart and default foreground restrictions with unit and actual Chromium workflows using fictional contacts. Verify optional permission denial/revocation without changing the operator's live power settings. Run all required checks, build 0.7.0 and stop. Hosted always-on transport remains a separate milestone.

## Current repair boundary — Minimized-window diagnosis (0.7.1)

On 2026-11-10 the user reported missed messages with Chrome minimized, confirmed saved background consent and a single WhatsApp tab, and supplied a 0.7.0 report showing WATCHING while hidden. Reproduce native minimization and worker idle suspension with isolated fictional chats. Expose validated saved/adapter background settings, browser eligibility blockers and bounded observation counters so the live failure can be identified. Correct misleading hidden-tab guidance. Preserve all sending/source checks and avoid speculative historical-message replay or forced visibility. Run required checks and build this diagnostic patch; do not claim the reported live delivery failure is fixed without evidence. Further repair follows the failing live observation.

## Current repair boundary — Backend restart recovery (0.7.2)

The crash recovery report shows background eligibility and an earlier accepted incoming event. Live settings display Not connected even though the backend accepts the saved pairing. Restore connection status after worker restart with a bounded read-only check. Retain unopened, verified unread candidates briefly when the local backend is temporarily offline, with bounded retries and the same consent, source, destination and duplicate checks. Report current generation and delivery status with approved error codes and no message or credential values. Verify offline recovery, deadline and authorization failures with fictional messages, then run the full checks and build 0.7.2. Confirm the actual account's delivery separately.

## Current repair boundary — Unread sidebar continuity (0.7.3)

The user shows a reply sent in the open conversation while another visible unread badge stays unopened. Reproduce lost unread arrivals when WhatsApp detaches and reattaches an observed row, rewrites its title with the same value, or replaces the sidebar while a verified candidate waits. Retain brief row continuity only with stable identity and preserve original freshness. Retry an unread check invalidated by a concurrent settings revision within a bounded window. Explain skipped unread checks with sanitized reasons. Preserve the single eligible tab, pause, hours, draft, consent, destination proof and duplicate guards. Verify synthetic sidebar reordering and concurrent replies, run the full checks and build 0.7.3. Confirm the live behavior separately.
