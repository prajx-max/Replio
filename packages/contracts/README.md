# @assistant/contracts

Shared runtime validation and inferred types for all application boundaries.

- `entities.ts`: business profiles, knowledge records, incoming messages, decisions, tickets and follow-ups.
- `events.ts`: version 1 strict extension event union.
- `api.ts`: initial backend request and response schemas.

Use exported schemas to parse unknown input at boundaries and infer types from them. Package exports target compiled ESM and declarations in dist. Tests import source directly so they can run before a production build.

Default profiles use DRAFT_ONLY and do not store raw messages. An explicit-click marker, citation, hashed identifier or notification timestamp validates structure only. Runtime code must still verify approval provenance, profile ownership, grounding and actual notification success.
