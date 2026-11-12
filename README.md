# Replio — AI Business WhatsApp Assistant

A local Chrome MV3 assistant that observes new incoming WhatsApp Web text and generates replies using your business instructions, information and chosen model API. Choose editable drafts or opt-in Auto-reply.

## Start

Use Node **24.22.1** and pnpm **11.25.0**. From this repository:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev:api
```

Keep the backend running. Open [model setup](http://127.0.0.1:3000/setup) in your browser. Use the exact business profile ID shown in extension settings. Choose OpenAI, Gemini, Anthropic, Groq, DeepSeek, OpenRouter, Mistral AI, xAI, Together AI or **Custom (OpenAI-compatible)**. Enter a model ID supported by your account and its API key, leave **Remember connection on this PC** checked on your trusted computer, and save. Pair once using the displayed pairing code. Remembered connections retain the same key, model and pairing after a backend restart. **Test model connection** makes one short paid-provider request only when clicked.

For another provider, choose **Custom (OpenAI-compatible)** and enter its **API base URL**, such as `https://api.example.com/v1`. Replio appends `/chat/completions`; the provider must support that API and return the required JSON reply. Use the exact **Model ID** from the provider, including an organization prefix if required. Start with **JSON mode**. If the model rejects that option, choose **Prompted JSON (without JSON mode)**, save and test again. Invalid or incomplete model output is never used as a customer reply. Custom endpoints require a public HTTPS hostname on port 443; local/private network servers and providers using other API protocols are not supported by this option.

Enter a new key when changing providers or the custom base URL. Leaving the key blank reuses it only for the same provider and destination. After installing this provider update, restart the backend, refresh setup, and reload the extension to use the new choices.

1. Open Chrome's `chrome://extensions`, enable Developer mode and load unpacked `apps/extension/dist`. If already installed, reload the extension and WhatsApp tab to apply the new content script and permissions.
2. Open the extension's **Business settings**. Fill **Reply instructions** with your preferred behavior and **Business information** with verified facts. Save. Keep real keys out of both fields.
3. Paste the backend pairing code into the AI connection section. Choose whether new incoming messages may be sent automatically to your selected provider for suggestions, then click **Connect AI backend**. Without that opt-in, use the workspace's explicit generation button.
4. Open WhatsApp Web and select a chat. Wait for **Chat ready**. Existing messages are ignored. A new incoming text can generate a suggestion using the selected profile.
5. **Draft only** is the default: review/edit, click **Insert into WhatsApp**, then send from WhatsApp. For automatic sending, choose **Business settings → Reply preferences → Auto-reply**, check **Allow automatic sending without review**, and **Save changes**. Keep WhatsApp in the active tab unless background replies are enabled, and wait for Chat ready before the next incoming message. Existing messages are ignored when saving the mode.

Auto-reply generates, inserts and clicks WhatsApp's native Send button for new incoming text without a Generate/Insert/Send click. Missing confirmed facts receive a fixed standard fallback instead of an unsupported model answer. Manual draft tools remain optional. With background replies off, it stops for an inactive/hidden tab. In every mode it stops for a changed source/chat, an existing operator draft, a later operator reply, working hours or cooldown restrictions. Use **Pause auto-reply for this chat** for human takeover; only explicit Resume releases it. Uncertain attempts are never automatically retried. “Sent to WhatsApp” means the composer cleared, not verified network delivery. DOM changes can still require selector updates under diagnostics.

The adapter follows equivalent editor remounts within the same footer after writing its own reply into an empty composer. Paragraph/line-break representations, emoji alt text and nonbreaking spaces are compared as displayed text; real editing cancels sending. An existing draft is never adopted just because its words match the suggestion. Clear an old stuck draft once after upgrading; subsequent eligible new messages send automatically while the chat stays active.

Messages arriving close together show **Waiting to reply…** and resume automatically after the cooldown, using only the latest pending message. Change **Reply preferences → Minimum time between replies (seconds)** to adjust the interval (default 10; 0 disables the cooldown). Keep the intended chat selected until its reply finishes. Pause, chat/settings changes, reconnect and restart cancel queued work; they never replay old messages. Intervals longer than the source's automatic reply window produce an explanatory notice rather than an indefinite wait.

The observer keeps its live message boundary when the service worker restarts. Startup recovery reannounces the existing observer instead of resetting it; each new message registers its current context before generation. Replacing a sent row with the same unique public ID does not make the next incoming row disappear. Ambiguous or unanchored list replacements still rebaseline conservatively. No continuous keepalive or historical-message replay is added.

To let the assistant choose the next chat, enable **Business settings → Reply preferences → Auto-reply → Open new unread chats automatically**, then **Save changes**. Keep WhatsApp Web open with the chat list present; it must be active unless background replies are enabled. Once the side panel says **Watching the chat list for new unread messages**, a fresh unread count can open its conversation, mark it read and trigger a reply. If two chats receive texts together, the second waits while the first reply is being generated and sent.

To answer conversations that **already have unread badges**, also check **Include chats that are already unread** and save. Return to WhatsApp Web and keep the chat list visible. The assistant works through the initially displayed unread chats one by one and answers the newest verified incoming text in each. Opening the chat can mark the entire conversation read. The side panel shows the queued count and tells you if a draft or dialog needs attention. You can leave the currently selected chat empty.

With background replies off, switching to Business settings or another tab pauses this pass. Returning to WhatsApp resumes the unopened candidates after checking their current identities and badge counts. A chat already opened by the assistant is never added back automatically. Manual interaction with the chat list or conversation cancels the pass. Diagnostics report the last visible list's detected row and numeric-badge counts, even while WhatsApp is hidden.

With the existing-unread option off, monitoring starts from the current counts and waits for new arrivals. The worker checks takeover and business hours before navigating. If the destination or its unread boundary cannot be verified, the workspace asks for manual review.

When WhatsApp briefly detaches a chat row during a reorder, Replio can follow the unread count change once it verifies the row's identity again. It can also resume an unopened candidate after a brief sidebar replacement within the original reply window. If a visible unread chat is skipped, the workspace and diagnostic report show the reason when available.

## Background replies and overnight use

In **Business settings → Reply preferences → Auto-reply**, enable **Allow automatic sending without review**, then **Reply while WhatsApp is in the background**, and save. Keep one WhatsApp Web tab open, Chrome running and the backend connected. Replio can reply while you use another tab, without switching focus back to WhatsApp. Enable **Open new unread chats automatically** as well to process other chats. Background mode requires exactly one WhatsApp tab to avoid competing observers; close extra WhatsApp tabs before using it. Existing unread chats still require their separate option.

For overnight use, also enable **Keep computer awake while Replio runs**, allow Chrome's optional permission and save. This requests prevention of sleep caused by inactivity while background mode and its WhatsApp tab are available. The screen may dim or turn off. Turn the setting or assistant off to release the request. Closing WhatsApp, disconnecting the business or removing the permission also releases it. This does not override manually choosing Sleep, shutdown, lid-close policies or an OS policy that ignores wake requests. Chrome, the backend and internet access must remain available.

Replio temporarily disables automatic memory discarding for its eligible WhatsApp tab and restores that tab's previous setting when background mode ends. Chrome or WhatsApp can still freeze, unload or disconnect the page; timers can be delayed in the background. After a freeze or reload, existing mounted messages are baselined rather than replayed. An always-on service is needed for operation while the laptop is actually asleep or off; this extension does not provide that service.

If Chrome starts before the backend, Replio can hold an eligible unread chat for up to a minute while the backend starts. It checks the badge again before opening the chat. If the wait expires and **Include chats that are already unread** is enabled, reload WhatsApp to start a new scan of visible unread badges.

If a reply is missed, copy **Business settings → WhatsApp adapter diagnostics** after a fresh test message, before reloading or changing the selected chat. The report shows backend connection, current generation and delivery status, browser eligibility and message observation counts. It excludes customer text and keys. `WORKER_ACCEPTED` acknowledges receipt of the event.

## Admin follow-ups

Open **Admin follow-ups** from the assistant sidebar or Business settings. Callback requests, answers requiring human help and model failures appear here with a chat label, reason, saved time and **Open / In progress / Resolved** status. Use the chat label to find the customer in WhatsApp and message or call personally, then mark the entry resolved. Reopen an entry if more work is needed. Status changes apply to the inbox; use the existing per-chat Pause/Resume control when taking over a conversation.

Callback requests are recorded immediately even when another reply is pending. The assistant acknowledges a successful save with “I’ve added your request to the admin follow-up inbox for manual review.” It replaces unsupported promises such as “Our team will reach you soon” with this truthful wording. If saving fails, it asks the customer to contact the team directly. Check the inbox regularly: this release records work locally and does not send a separate team notification or arrange a callback.

To use your own acknowledgement, open **Business settings → Follow-up reply**. Enter **Saved follow-up reply**, or click **Use suggested reply** for “Our team will reach out to you soon.” Confirm **Our team will handle saved follow-ups and contact customers as promised**, then save. This per-business confirmation records your team's commitment to handle the inbox. The text is sent exactly as written after a successful save. Blank or unconfirmed text keeps the localized standard acknowledgement. Reply instructions do not control this message. Keep the reply to short plain text without links, exact times/prices or claims that a team was already notified. If saving the request cannot be confirmed, the fixed manual-contact response is always used.

The inbox is saved in this Chrome profile on this PC and survives worker/browser restarts. By default it retains the chat label, reason and status, with phone identifiers masked. To retain exact queries, enable **Business settings → Privacy & storage → Save customer questions in follow-ups on this PC**, then save. Turning this off removes previously saved questions. **Follow-up retention (days)** defaults to 30 and can be changed from 1 to 365; expired entries are removed on the next inbox read/write. Capacity is 512 unexpired entries; a full inbox shows an error rather than claiming a new request was saved.

## Keys and privacy

The API-key field belongs to the local backend page. Keys are sent only to that loopback backend, loaded into its process environment and used for requests to the selected provider destination. They are cleared from the input after submission and are never returned to the extension or stored in browser storage. **Remember connection on this PC** saves credentials and pairing in the Git-ignored backend `.env.connections` file, restricted to the current user and SYSTEM on Windows (mode 0600 on other platforms). This is environment configuration, not encrypted storage: keep the file private, exclude it from shared backups and do not copy it to other businesses. Uncheck Remember for session-only storage; that choice requires setup and pairing again after restart. **Remove this model key and revoke pairing** deletes the saved connection and revokes its capability. Optional `.env` startup configuration is documented in `.env.example`; never commit either environment file.

Upgrading from 0.3.3: old session-only keys/pairings cannot be recovered after they have expired. Configure and pair once with Remember checked. The desktop backend shortcut can then be used after restarts without repeating setup. An UNAUTHORIZED notice now opens setup for the correct business; it never bypasses pairing. A backend restart does not replay messages received while it was unavailable; test with a fresh incoming message.

The extension stores business settings, a profile-scoped pairing capability, hashed deduplication/delivery metadata, per-chat pauses and local admin follow-up records. Live customer text and suggestions remain in memory; only the separately opted-in follow-up question may persist under the profile's retention policy. New text is shared with the selected provider only after suggestion/Auto-reply opt-in or an explicit generation action. Provider-side handling follows that provider's account policy.

## Development and verification

```sh
pnpm exec playwright install chromium
pnpm check
```

On Linux, install browser dependencies with `pnpm exec playwright install --with-deps chromium`. `pnpm check` includes formatting, lint, strict types, unit/integration tests, production/fixture builds and four Chromium workflows. Individual commands are `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e`.

Production output is `apps/extension/dist`; `dist-fixture` is only for synthetic browser tests and must not be installed for real use. The backend's compiled entry is `apps/api/dist/server.js`.

## Scope

Implemented: new incoming-text adapter, startup/chat-switch baselines, diagnostics, editable instructions and business information, nine provider integrations plus custom compatible endpoints, backend key-entry interface, pairing, guarded suggestions, approved insertion, opt-in web Auto-reply and persistent chat pause. The optional bakery preview is fictional and cannot insert or send.

This is a local development release. Structured output and exact-number/URL guards reduce unsupported answers but do not prove semantic truth. Auto-reply intentionally removes review for eligible replies; use verified business facts and test the instructions in your own test chat. Business information is currently an operator-entered knowledge record, not a Sheets retrieval pipeline. Local admin work records are implemented; Sheets, mapping, shared backend ticketing, external notifications, follow-up alarms, multi-profile creation, production hosting and official automatic sending remain roadmap work. No real WhatsApp account or paid model key is used by automated tests.

See [architecture](docs/ARCHITECTURE.md), [release report](docs/WHATSAPP_AI_RELEASE_REPORT.md), [manual checks](docs/MANUAL_TEST_PLAN.md), and [implementation plan](docs/IMPLEMENTATION_PLAN.md). The supplied workflow is preserved as reference in `docs/BUILD_WORKFLOW_SOURCE.md`; embedded prompts do not authorize unrelated external actions.

After updating, click Reload for Replio — AI Business Assistant in `chrome://extensions`, confirm version **0.7.3**, then reload WhatsApp. If recovery reports unavailable, check Chrome → extension Details → Site access allows https://web.whatsapp.com. Keep the backend running for AI generation. Opening Business settings checks the saved local backend connection after a worker restart.
