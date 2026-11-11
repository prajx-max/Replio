# Threat model

Initial design review; controls marked planned require implementation evidence before release.

Milestone 1 evidence: the shell router verifies own extension-page ID/origin/path/frame before reading or changing storage; strict schemas reject malformed and unsupported requests; tests cover stale revisions, data preservation and profile-scoped demo state. The build checks permissions, CSP and absence of content scripts. Future WhatsApp sender/approval checks, provider ownership, logs and alarms remain unimplemented.

| Threat / boundary                  | Risk                                      | Planned mitigation                                                             | Verification milestone |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ | ---------------------- |
| Customer or sheet text → assistant | Prompt injection / fabricated facts       | Separate untrusted data, retrieved facts only, structured output, safe handoff | 3, 6                   |
| Content script → worker            | Spoofed send or settings command          | Strict events plus trusted sender, tab/frame/origin and approval verification  | 1, 2                   |
| Profile switch → cache / draft     | Cross-business information exposure       | Profile-scoped keys, ownership checks, invalidate stale drafts                 | 3–7                    |
| DOM replacement → observer         | Historical processing or duplicate drafts | Baseline each chat/list, deduplication, bounded observer                       | 2                      |
| Logs / diagnostics → exports       | Phone or message disclosure               | Masking, metadata-only logging, salted scoped hashes, retention                | 5, 6, 8                |
| Remote source → provider           | SSRF / executable remote code             | Validated HTTPS, destination policy, redirect checks, data-only parsing        | 4, 6                   |
| Backend → LLM / notifications      | Secret exposure or unverified delivery    | Server-only env keys, redaction, confirmed receipts, failure handling          | 5, 6                   |
| Worker restart / alarm retry       | Lost or duplicate follow-up               | Persist first, idempotency, reconciliation and cancellation checks             | 5                      |
| Browser storage access             | Customer data exposure                    | Minimal raw storage, retention, export redaction, scoped access                | 4, 5, 8                |
| Extension build / dependencies     | Supply-chain compromise                   | Exact versions, lockfile, frozen CI, bundle review and audit                   | 0, 8                   |

Assets: customer text, business knowledge, profile policy, ticket state, notification evidence, credentials and operator approval. Trusted components are packaged code, operator settings and authenticated backend authorization. Customers, sheet content, imported JSON, the host DOM and model output are untrusted.

Residual risks: WhatsApp DOM changes, browser-compromise access, uncertain language detection, stale knowledge, operator approval mistakes and external notification failures. Surface failures in diagnostics and prefer human handoff. Contracts check shape, not truth or authenticity.

## Current local release evidence

The combined adapter/AI release implements separate sender validation for content and UI routes, loopback Host/Origin checks, setup CSRF, profile-scoped random pairing, fixed vendor destinations with redirect rejection, bounded requests/timeouts/rates, runtime environment keys and no raw-body logging. Fixture tests verify history/dedup/stale-draft behavior and zero send actions. Keys are not returned to the extension. Setup test responses and model replies are bounded and validated; configured-key echoes become safe fallbacks.

Residual boundaries: any process controlling the operator's local machine/browser can access local capabilities; loopback setup is a personal-tool boundary, not production multi-user authentication. Provider accounts may retain submitted data under their own policies. Prompt separation, evidence IDs and exact-token checks do not establish semantic truth, including multilingual action claims. A malicious DOM can disrupt identity/observation, so insertion fails closed on uncertain identity. The user must review every reply and use native Send. Real WhatsApp compatibility and live model quality remain manual checks. No durable workflow, ticket or alarm guarantees are made.
