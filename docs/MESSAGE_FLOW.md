# Message flow

## Current release

Startup/chat switch → baseline existing nodes without reading history → hydration quiet interval → ready diagnostics. Appended incoming text → scoped salted chat/event hashes → validated content event → worker profile/mode/consent/dedup/cooldown/hours gates → authenticated local backend.

The worker syncs operator-owned instructions and business information under the profile pairing capability. Assist requests contain the new message and profile reference; customers cannot replace policy. The backend builds a prompt with untrusted data separated from rules, contacts the configured provider, validates structured output and exact fact tokens, and returns an editable suggestion or localized human-help fallback.

The worker discards responses whose profile/chat/context changed. Customer text and suggestions remain memory-only. Worker restart rebaselines existing tabs rather than replaying history.

A trusted UI click requests insertion of the current edited draft. Worker checks the active target tab; the adapter checks profile/chat/context, strong identity and empty composer. It inserts text, never executes Send. The operator reviews the composer and sends through WhatsApp.

## Deferred workflows

Full retrieval, intent/importance, tickets, notifications, takeover and follow-up alarms are not implemented. Future processing-team acknowledgements must depend on actual persistence and delivery evidence. Persist alarm state first, reconcile after restart and make delivery idempotent. Mock success never proves real delivery. Official automatic sending remains a separate transport.
