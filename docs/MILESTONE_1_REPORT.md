# Milestone 1 report

## Delivered

An installable Chrome Manifest V3 shell with React popup, reply side panel and options page. The production folder is apps/extension/dist. The service worker coordinates validated requests and settings; a fictional bakery sample produces a typed ASSISTANT_DECISION_READY event and editable draft.

Settings persist in chrome.storage.local. Fictional sample results use chrome.storage.session and survive worker recreation. The pages stay synchronized through storage change notifications. The worker serializes mutations and rejects stale profile edits by revision; unsaved form input stays visible on conflict. Corrupt stored settings are surfaced without silent reset.

The manifest requests only storage and sidePanel. It includes no host access or content scripts. Scripts, styles and dependencies are bundled locally under a strict CSP. WhatsApp is labelled adapter pending. The fixed English sample is explicitly fictional, and Insert/Send remain disabled.

## Changed files

```text
apps/extension/
  manifest.config.ts, vite.config.ts
  popup.html, sidepanel.html, options.html
  src/background/{service-worker,message-router,mock-profile,mock-flow}.ts
  src/storage/settings-repository.ts
  src/messaging/{contracts,client}.ts
  src/popup/{Popup,main}.tsx
  src/sidepanel/{SidePanel,DraftEditor,main}.tsx
  src/options/{Options,main}.tsx
  src/ui/{shared,mount}.tsx, use-assistant.ts
  src/styles/{app,base}.css
  tests/{helpers,storage-router.test}.ts, ui.test.tsx
  tsconfig.json, tsconfig.tests.json, env types, package.json, README.md
e2e/extension.spec.ts
playwright.config.ts
scripts/verify-build.mjs
Root scripts, TypeScript, lint, formatting, pnpm configuration and lockfile
CI workflow and architecture/specification/security/testing/install docs
```

## Verification

The Milestone 0 baseline was checked successfully before implementation. React/Vite dependencies and browser types were resolved to compatible exact versions. pnpm 11 workspace settings now include the project-local store configuration, fixing filtered installs that previously selected the global store.

| Check                                       | Result                                                            |
| ------------------------------------------- | ----------------------------------------------------------------- |
| Frozen dependency install                   | Passed                                                            |
| Formatting                                  | Passed                                                            |
| Lint                                        | Passed                                                            |
| Strict TypeScript (source, tests and tools) | Passed                                                            |
| Vitest                                      | 52 tests passed in 3 files                                        |
| Production build                            | Passed; popup, options, side panel, worker and manifest generated |
| Build invariants                            | Passed; permissions, CSP and local entry files checked            |
| Chromium smoke test                         | Passed; actual unpacked MV3 workflow completed in 4.0 seconds     |
| Combined final check                        | Passed; format, lint, types, tests, build and browser workflow    |

Tests cover profile defaults, persistence/recreation, concurrent changes, storage failure recovery, malformed stored data, sender validation, request validation, disabled/profile mismatch gates, scoped mock events, stale revisions, popup actions, draft editing/reset, disabled send controls, profile save/reload, invalid timezone, escaped untrusted text and malformed/unavailable worker responses.

Validation found and fixed a type-only import, an overloaded Chrome test stub, an editor that initially rendered blank before an effect populated the reply, and asynchronous toggle feedback. Draft editors now initialize from the event and reset by event identity. The enabled switch immediately reflects the pending change and restores the saved value if persistence fails, with a dedicated regression test. The browser test uses the combobox's accessible role/name rather than an ambiguous nested label. No failed check is treated as passed.

Browser installation initially failed with connection resets and DNS failures. The same Chrome for Testing 156.0.8078.4 build was downloaded from its official Google Storage redirect using resumable ranges and verified against the archive checksum returned by that HTTPS endpoint. A copy in the standard global browser cache could not spawn on this host and was removed. The smoke test now automatically detects the verified workspace browser on Windows; normal CI uses Playwright-managed Chromium. Temporary archive/part files were cleaned up while keeping the working browser.

The final Windows command passed without environment overrides:

```powershell
pnpm check
```

The smoke test verified packaged popup/panel/options rendering, a typed sample reply, disabled send/insert, session restoration after reload, saved business settings, page synchronization, preserved stale-form edits and responsive widths. Screenshots in artifacts/milestone-1 were inspected for the popup, panel, desktop settings and mobile settings. CI has been configured but has not run on GitHub; Linux and the native Chrome toolbar-side-panel surface remain separate verification environments.

## Run manually

1. Run pnpm build.
2. Open Chrome at chrome://extensions and turn on Developer mode.
3. Choose Load unpacked and select apps/extension/dist in this repository.
4. Open the toolbar popup → Open reply workspace → Try a sample enquiry.
5. Open Business settings, save edits and verify them after reload.

See [the full manual checklist](MANUAL_TEST_PLAN.md). Actual Chrome toolbar-to-side-panel presentation is a manual check; browser automation opens the same packaged pages in tabs.

## Limits and next milestone

No WhatsApp DOM observation, historical chat processing, draft insertion, sending, Google Sheets sync, real knowledge retrieval, AI, tickets, alarms or human-takeover implementation exists yet. Business preferences persist for future use; they do not transform the fixed English sample. Multi-profile CRUD is deferred to Milestone 7. The backend/core/knowledge packages remain placeholders.

Next is Milestone 2: centralized selector registry, readiness and chat detection, baseline-and-ignore history, incoming-only observation, deduplication, diagnostics and approved draft/send actions tested on a local fixture. Stop after this milestone's checkpoint before beginning that adapter work.
