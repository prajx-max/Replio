# Milestone 0 report

## Delivered

Initialized the empty workspace as a Git repository with a pnpm monorepo, seven package boundaries, strict TypeScript builds, ESLint, Prettier, Vitest, initial Zod contracts, documentation and Windows/Linux CI.

The contracts cover business profiles, structured knowledge, incoming messages, grounded draft decisions, ticket/follow-up data, API shapes and fourteen versioned extension event variants. Tests validate privacy defaults, invalid configuration, malformed events, explicit-send markers and notification metadata requirements.

## File tree

```text
.
├── .github/workflows/ci.yml
├── apps/
│   ├── api/
│   │   ├── src/{routes,services,providers,repositories,middleware,tests}/
│   │   ├── src/index.ts
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── extension/
│       ├── public/icons/
│       ├── src/{background,content/whatsapp,popup,sidepanel,options}/
│       ├── src/{diagnostics,storage,messaging,styles}/
│       ├── src/index.ts
│       ├── README.md
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   ├── contracts/
│   │   ├── src/{entities,events,api,index}.ts
│   │   ├── tests/contracts.test.ts
│   │   ├── README.md
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tests.json
│   ├── core/src/{intent,importance,reply,escalation,language,privacy}/
│   ├── knowledge/src/{providers,mapping,normalization,search,cache}/
│   ├── ui/src/
│   └── test-fixtures/{src,whatsapp-page}/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── BUILD_WORKFLOW_SOURCE.md
│   ├── GOOGLE_SHEETS_TEMPLATE.md
│   ├── IMPLEMENTATION_PLAN.md
│   ├── MANUAL_TEST_PLAN.md
│   ├── MESSAGE_FLOW.md
│   ├── MILESTONE_0_REPORT.md
│   ├── PRODUCT_SPEC.md
│   ├── RELEASE_CHECKLIST.md
│   ├── SECURITY_AND_PRIVACY.md
│   ├── TESTING.md
│   └── THREAT_MODEL.md
├── scripts/verify-build.mjs
├── AGENTS.md
├── README.md
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig{,.base,.tools}.json
├── vitest.config.ts
├── eslint.config.mjs
├── .env.example
└── Git, editor, Node, pnpm and Prettier configuration
```

Each placeholder workspace also includes package.json, tsconfig.json, README.md, and src/index.ts. Empty feature directories are tracked with .gitkeep. Builds emit ignored dist directories.

## Commands and verification

Initial inspection: file listing, source workflow reads, runtime versions and Git status. Initialized Git with `git init --initial-branch=main`. Resolved tool versions from official registry metadata. Ran `node --check scripts/verify-build.mjs` successfully.

Dependency installation initially failed on DNS/registry timeouts. A diagnostic retry also exposed incorrectly typed pnpm timeout arguments; the corrected command uses install-specific options. The successful install command was `pnpm install --store-dir=.pnpm-store --fetch-retries=1 --fetch-timeout=600000 --reporter=append-only`. The frozen install then completed in under one second using the cache. Sandbox filesystem restrictions required running pnpm checks with elevated tool permissions.

| Command                                   | Result                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm install` with timeout options above | Passed; 131 installed packages                                              |
| `pnpm install --frozen-lockfile`          | Passed; lockfile current                                                    |
| `pnpm format`                             | Passed                                                                      |
| `pnpm lint`                               | Passed; no warnings                                                         |
| `pnpm typecheck`                          | Passed after replacing a global URL reference with Zod's protocol validator |
| `pnpm test`                               | Passed; 23 tests in one test file                                           |
| `pnpm build`                              | Passed; seven workspace outputs and built-contract ESM import verified      |
| `pnpm check`                              | Passed; format check, lint, typecheck, tests and build                      |
| `git diff --cached --check`               | Passed; Markdown hard line breaks are permitted by .gitattributes           |

The individual test/lint commands and final combined check were actually run on Windows. CI is configured but has not run on GitHub; Linux verification remains for CI. Browser/manual account tests are not applicable to this milestone because no extension has been implemented.

## Assumptions and limits

- Use this existing folder as the repository root rather than creating a nested folder.
- Follow the supplied workflow's Milestone 0 boundary before implementing the extension.
- Use installed Node 24 LTS and pnpm 11; pin TypeScript 6 because the selected linter does not support TypeScript 7.
- Require no real accounts or credentials in the scaffold.
- Empty app builds prove package configuration, not a working Chrome extension or API.
- Contract validation proves data shape only. Authorization, actual approval, profile ownership, retrieval grounding, notification delivery and alarm recovery belong to future runtime milestones.

## Next milestone

Milestone 1: React/Vite MV3 shell, service worker, popup, side panel, options, persistent storage, typed event routing and a mock business/assistant flow. Load it unpacked and verify settings persistence. DOM observation begins in Milestone 2.
