import { useState } from 'react';
import {
  AutoSendResultSchema,
  SelectorPackSchema,
  ServiceErrorSchema,
} from '@assistant/contracts';
import type { ShellRequest, ShellState } from '../messaging/contracts.js';

const replyErrors = new Set<string>([
  ...ServiceErrorSchema.options,
  'BACKEND_ERROR',
  'BACKEND_OFFLINE',
  'COOLDOWN',
  'COOLDOWN_TOO_LONG',
  'DELAY_TOO_LONG',
  'DELIVERY_STORAGE_ERROR',
  'INACTIVE_OR_CHANGED_CHAT',
  'MESSAGE_EXPIRED',
  'SETTINGS_CHANGED',
]);
const deliveryReasons = new Set<string>([
  ...AutoSendResultSchema.shape.reason.options,
  'ALREADY_ATTEMPTED',
  'COOLDOWN',
  'DELIVERY_CAPACITY',
  'DELIVERY_STORAGE_ERROR',
  'HUMAN_REVIEW_REQUIRED',
  'INACTIVE_OR_CHANGED_CHAT',
]);

function diagnosticCode(value: string | undefined, allowed: Set<string>) {
  if (!value) return null;
  return allowed.has(value) ? value : 'UNKNOWN';
}

export function AdapterDiagnostics({
  state,
  busy,
  act,
}: {
  state: ShellState;
  busy: boolean;
  act: (request: ShellRequest) => Promise<boolean>;
}) {
  const [text, setText] = useState(() =>
    JSON.stringify(state.settings.selectors, null, 2),
  );
  const [notice, setNotice] = useState('');
  const profile = state.settings.profiles.find(
    (item) => item.id === state.settings.activeProfileId,
  );
  const structure = state.live?.status.structure;
  const context = state.live?.status.context;
  const suggestion = state.live?.suggestion;
  const hiddenGuidance =
    structure?.backgroundReplies === true
      ? 'WhatsApp is hidden. The adapter has background replies enabled; keep Chrome, WhatsApp and the backend running.'
      : profile?.backgroundReplies
        ? 'WhatsApp is hidden. Background replies are saved, but the adapter has not confirmed them. Reload WhatsApp to apply the saved settings.'
        : 'WhatsApp is currently hidden. Return to its tab to continue.';
  const report = JSON.stringify(
    {
      installedVersion:
        typeof chrome !== 'undefined' && chrome.runtime?.getManifest
          ? chrome.runtime.getManifest().version
          : 'unknown',
      savedSelectorVersion: state.settings.selectors.version,
      savedPolicy: {
        revision: state.settings.revision,
        enabled: state.settings.enabled,
        replyMode: profile?.replyMode ?? null,
        webAutoSendOptIn: profile?.webAutoSendOptIn ?? false,
        autoOpenUnread: profile?.autoOpenUnread ?? false,
        includeExistingUnread: profile?.includeExistingUnread ?? false,
        backgroundReplies: profile?.backgroundReplies ?? false,
        keepAwake: profile?.keepAwake ?? false,
      },
      adapterReported: Boolean(state.live),
      observation: state.live?.status.observation ?? null,
      backgroundRuntime: state.backgroundRuntime ?? null,
      backend: {
        paired: state.backend.paired,
        configured: state.backend.configured,
        error: diagnosticCode(state.backend.error, replyErrors),
      },
      currentReply: {
        messagePresent: Boolean(state.live?.message),
        paused: Boolean(
          context &&
          state.settings.takeovers[context.chatKey]?.profileId ===
            context.profileId,
        ),
        suggestion: suggestion?.state ?? null,
        generationError: diagnosticCode(suggestion?.error, replyErrors),
        delivery: suggestion?.delivery?.state ?? null,
        deliveryReason: diagnosticCode(
          suggestion?.delivery?.reason,
          deliveryReasons,
        ),
      },
      unreadNavigation: state.live?.status.unread ?? null,
      unreadChatsPending: state.live?.status.unreadPending ?? null,
      unreadWaitingFor: state.live?.status.unreadBlockedBy ?? null,
      unreadSidebar: state.live?.status.unreadDiagnostics ?? null,
      includeExistingUnread: profile?.includeExistingUnread ?? false,
      matches: state.live?.status.matches ?? null,
      structure: structure ?? null,
    },
    null,
    2,
  );
  async function save() {
    try {
      const selectors = SelectorPackSchema.parse(JSON.parse(text) as unknown);
      if (await act({ type: 'SAVE_SELECTORS', version: 1, selectors }))
        setNotice(
          'Selector pack saved. Open chats were rebaselined; old messages were ignored.',
        );
    } catch {
      setNotice(
        'Invalid selector JSON. Keep all eight selector groups, one to eight CSS candidates per group, and a positive version.',
      );
    }
  }
  return (
    <section className="card" id="diagnostics">
      <h2>WhatsApp adapter diagnostics</h2>
      <p className="small muted">
        Saved selectors: v{state.settings.selectors.version} · Running adapter:{' '}
        {state.live?.status.structure?.buildVersion ?? 'version unavailable'}
      </p>
      <p className="small muted">
        Status:{' '}
        {state.adapterStatus === 'READY'
          ? 'Ready'
          : 'Waiting for WhatsApp and an open chat'}
        . Selectors may need adjustment when WhatsApp changes its layout.
      </p>
      {!state.live && (
        <p className="error-notice" role="status">
          No WhatsApp tab has reported yet. Reload WhatsApp Web after installing
          or reloading this extension, then select a chat. Check Chrome’s
          extension site access allows web.whatsapp.com.
        </p>
      )}
      {state.live && !state.live.status.ready && (
        <p className="small muted" role="status">
          The adapter is connected. Open a chat and check the missing
          chatHeader, messageList or composer entries below.
          Incoming/outgoing/text entries can be absent in an empty chat.
        </p>
      )}
      {state.live && (
        <div className="status-list">
          {Object.entries(state.live.status.matches).map(([name, index]) => (
            <div key={name}>
              <span>{name}</span>
              <strong>
                {index >= 0 ? `Fallback ${index + 1} matched` : 'Not found'}
              </strong>
            </div>
          ))}
        </div>
      )}
      {state.live?.status.unreadDiagnostics && (
        <p className="small muted" role="status">
          Last visible chat list:{' '}
          {state.live.status.unreadDiagnostics.lastVisibleListFound
            ? `${state.live.status.unreadDiagnostics.lastVisibleRows} rows detected, ${state.live.status.unreadDiagnostics.lastVisibleUnreadRows} with numeric unread badges.`
            : 'not detected.'}{' '}
          {state.live.status.unreadDiagnostics.visible === false &&
            hiddenGuidance}
        </p>
      )}
      <details>
        <summary>Copy structural diagnostic report</summary>
        <p className="small muted">
          Versions, saved reply settings, adapter flags, tab visibility, message
          counts, reply status codes and sanitized wrapper metadata only. No
          chat text, phone numbers, message IDs, keys or pairing codes are
          included.
        </p>
        <label className="field">
          Structural diagnostic report
          <textarea readOnly rows={12} value={report} />
        </label>
        <button
          className="button secondary"
          onClick={() => {
            void navigator.clipboard.writeText(report).then(
              () =>
                setNotice(
                  'Structural report copied. Paste it into the support chat.',
                ),
              () =>
                setNotice(
                  'Select the structural report above and copy it manually.',
                ),
            );
          }}
        >
          Copy diagnostic report
        </button>
        <p className="small muted" role="status">
          {notice}
        </p>
      </details>
      <details>
        <summary>Advanced selector configuration</summary>
        <p className="small muted">
          JSON data only. Paste or copy this pack to import or export selectors.
          Invalid CSS is ignored and falls back to the next candidate.
        </p>
        <label className="field">
          Selector pack JSON
          <textarea
            rows={12}
            maxLength={24000}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button
          className="button secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            void save();
          }}
        >
          Save selector pack
        </button>
        <p className="small muted" role="status">
          {notice}
        </p>
      </details>
    </section>
  );
}
