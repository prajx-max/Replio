import { useEffect, useState } from 'react';
import { useAssistant } from '../ui/use-assistant.js';
import {
  Brand,
  EnabledSwitch,
  ErrorNotice,
  Loading,
  ProfileSelect,
  StatusPill,
  openSettings,
} from '../ui/shared.js';
import type { AssistantClient } from '../messaging/client.js';

export function Popup({ client }: { client?: AssistantClient }) {
  const { state, error, busy, act } = useAssistant(client);
  const [windowId, setWindowId] = useState<number>();
  const [navigationError, setNavigationError] = useState('');
  useEffect(() => {
    if (typeof chrome !== 'undefined' && chrome.windows?.getCurrent) {
      void chrome.windows.getCurrent().then(
        (window) => setWindowId(window.id),
        () => setNavigationError('The current browser window is unavailable.'),
      );
    }
  }, []);
  if (!state) return <Loading error={error} />;
  const profile = state.settings.profiles.find(
    (item) => item.id === state.settings.activeProfileId,
  );
  function openPanel() {
    if (windowId === undefined) return;
    // Invoke directly in the click handler, preserving Chrome's user gesture.
    void chrome.sidePanel
      .open({ windowId })
      .catch(() =>
        setNavigationError(
          'The side panel could not open. Try again from the extension popup.',
        ),
      );
  }
  return (
    <main className="popup-page">
      <header className="topbar">
        <Brand />
        <StatusPill enabled={state.settings.enabled} />
      </header>
      <div className="popup-intro">
        <span className="eyebrow">YOUR SUPPORT, SIMPLIFIED</span>
        <h1>
          A little help.
          <br />A human touch.
        </h1>
        <p className="muted">Thoughtful replies, with you in control.</p>
      </div>
      <div className="control-row">
        <div>
          <strong>Assistant enabled</strong>
          <p className="small muted">Ready when you are</p>
        </div>
        <EnabledSwitch
          enabled={state.settings.enabled}
          disabled={busy}
          onChange={(enabled) =>
            act({ version: 1, type: 'SET_ENABLED', enabled })
          }
        />
      </div>
      <ProfileSelect
        settings={state.settings}
        disabled={busy}
        onChange={(profileId) => {
          void act({ version: 1, type: 'SET_ACTIVE_PROFILE', profileId });
        }}
      />
      <div className="status-list">
        <div>
          <span>Reply mode</span>
          <strong>
            {profile?.replyMode === 'OFF'
              ? 'Off'
              : profile?.replyMode === 'AUTO_REPLY_WEB'
                ? 'Auto-reply'
                : 'Draft only'}
          </strong>
        </div>
        <div>
          <span>WhatsApp</span>
          <strong className="muted">
            {state.adapterStatus === 'READY' ? 'Chat ready' : 'Adapter pending'}
          </strong>
        </div>
        <div>
          <span>Knowledge</span>
          <strong>Sample data</strong>
        </div>
      </div>
      <ErrorNotice message={error || navigationError} />
      <button
        className="button primary wide"
        onClick={openPanel}
        disabled={windowId === undefined}
      >
        Open reply workspace <span aria-hidden="true">↗</span>
      </button>
      <button
        className="button quiet wide"
        onClick={() => {
          void openSettings().catch(() =>
            setNavigationError('Settings could not open.'),
          );
        }}
      >
        Business settings <span aria-hidden="true">→</span>
      </button>
      <footer className="footer-note">Milestone 1 · Sample flow only</footer>
    </main>
  );
}
