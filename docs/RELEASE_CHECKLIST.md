# Release checklist

This is a local development adapter/AI release. Full production acceptance remains separate. Verification evidence and limits are recorded in WHATSAPP_AI_RELEASE_REPORT.md.

## Current release gate

- [ ] Frozen dependencies and pinned Node/pnpm; complete pnpm check on target machine.
- [ ] Production bundle has only WhatsApp/loopback host grants and no fixture origins.
- [ ] Adapter ignores history/outgoing/duplicates; uncertain identity blocks insertion.
- [ ] Keys stay backend-side, setup clears input, pairing/revocation and ownership work.
- [ ] Instructions persist; factual and unsupported drafts are reviewed by an operator.
- [ ] Synthetic browser workflow inserts a draft and never sends.
- [ ] Real provider/account and live DOM compatibility are manually verified before use.

## Future production gate

- [ ] Hosted authentication/tenant isolation and durable encrypted credential management.
- [ ] Full retrieval/mapping/cache validation and live multilingual model evaluations.
- [ ] Ticket persistence, confirmed notifications, takeover, alarms and restart recovery.
- [ ] Data retention/deletion, backup/restore, dependency/security/accessibility audits.
- [ ] Chrome Web Store privacy/disclosure, support and rollback documentation.
- [ ] Official transport separately authorized and verified before automatic sending.
