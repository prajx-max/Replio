# @assistant/extension

MV3 popup, side panel, business settings, worker and thin WhatsApp DOM adapter. Build with root `pnpm build`, then load `apps/extension/dist` through Chrome Developer mode. Run the local backend and follow the root README to configure instructions, business information and pairing.

Permissions are storage, sidePanel and scripting; host grants cover only WhatsApp Web and the loopback backend on port 3000. Scripting restores missing packaged adapters in existing WhatsApp tabs. The WhatsApp grant enables the content script and chat-tab verification. Loopback enables provider-independent requests without exposing provider keys to the extension. No broad tabs permission, private WhatsApp modules, contact scraping or remote executable code is used.

The standalone bundled content script detects readiness/new incoming text, hashes chat identity, reports diagnostics, inserts approved drafts and executes worker-authorized native sending in opted-in Auto-reply mode. Business rules, consent and delivery claims stay outside the adapter. Worker routes validate extension UI versus content-script sender, tab, frame and URL separately. Storage access is restricted to trusted extension contexts.

Business settings, pairing capabilities, salt, bounded hash-only delivery/deduplication metadata and per-chat pauses persist locally. Live customer text and model drafts remain memory only and are discarded on restart. The fictional optional sample uses session storage. Existing settings receive additive defaults rather than being reset.

The adapter baselines startup/chat-switch history, waits for chat hydration and ignores outgoing/prepended history. Conservative identity/list checks may miss messages during hydration rather than replay history. Insert requires an active target tab, matching profile/chat/context, strong identity or the exact latest incoming source anchor, and an empty composer. Auto-reply additionally verifies mode/consent, visibility, unchanged source text/ID, no later rows, freshness, worker authorization and durable reservation before clicking native Send. Draft only never clicks Send. Enable Auto-reply in Reply preferences; use Pause/Resume in the workspace.

`dist-fixture` adds local fixture origins exclusively for automated tests. Artifact verification checks those origins are absent from production manifest/worker/content output. Never load the fixture build for real chats.

Version 0.2.1 adds the scripting permission for bounded bridge recovery: only packaged content.js is injected, in the top-frame isolated world of existing WhatsApp tabs. Host grants are unchanged. The Reconnect WhatsApp button and worker startup restore absent receivers, rebaseline existing nodes and prevent duplicate observers. See architecture for the permission rationale and recovery tests.
