import { useState } from 'react';
import type { ShellRequest, ShellState } from '../messaging/contracts.js';
import { BACKEND_ORIGIN } from '../background/backend-client.js';

export function AiConnection({
  state,
  busy,
  act,
}: {
  state: ShellState;
  busy: boolean;
  act: (request: ShellRequest) => Promise<boolean>;
}) {
  const [token, setToken] = useState('');
  const [autoSuggest, setAutoSuggest] = useState(
    state.settings.connections[state.settings.activeProfileId]?.autoSuggest ??
      false,
  );
  const [notice, setNotice] = useState('');
  async function connect() {
    const ok = await act({
      type: 'CONNECT_BACKEND',
      version: 1,
      token,
      autoSuggest,
    });
    if (ok) {
      setToken('');
      setNotice(
        'AI backend connected. Open WhatsApp and select a chat. Existing messages will be ignored.',
      );
    }
  }
  return (
    <section id="ai-connection" className="card form-card">
      <div className="card-heading">
        <div>
          <h2>AI connection</h2>
          <p className="muted">
            Choose your model and enter its key in the local backend.
          </p>
        </div>
        <span
          className={`pill ${state.backend.configured ? 'pill-green' : 'pill-muted'}`}
        >
          {state.backend.configured ? 'Connected' : 'Not connected'}
        </span>
      </div>
      <ol className="setup-steps">
        <li>
          Start the local backend with <code>pnpm dev:api</code>.
        </li>
        <li>
          Open AI setup below. Select a provider, model ID, and its API key.
        </li>
        <li>Copy the pairing code into this form and connect.</li>
      </ol>
      <p className="small muted">
        Business profile ID: <code>{state.settings.activeProfileId}</code>
      </p>
      <button
        className="button secondary"
        type="button"
        onClick={() => {
          void chrome.tabs
            .create({
              url: `${BACKEND_ORIGIN}/setup?profileId=${encodeURIComponent(state.settings.activeProfileId)}`,
            })
            .catch(() =>
              setNotice(
                `Open ${BACKEND_ORIGIN}/setup in your browser after starting the backend.`,
              ),
            );
        }}
      >
        Open AI key setup ↗
      </button>
      <label className="field">
        Backend pairing code
        <input
          type="password"
          autoComplete="off"
          maxLength={512}
          value={token}
          placeholder={
            state.backend.paired
              ? 'Leave blank to keep your current pairing'
              : 'Paste the code from AI setup'
          }
          onChange={(event) => setToken(event.target.value)}
        />
        <span className="field-hint">
          This is not your model API key. The provider key stays in the backend.
        </span>
      </label>
      <label className="consent-option">
        <input
          type="checkbox"
          checked={autoSuggest}
          onChange={(event) => setAutoSuggest(event.target.checked)}
        />
        <span>
          Suggest replies to new incoming messages
          <span className="small muted">
            Sends the new message and your business information to the selected
            AI provider. Existing chat history is ignored.
          </span>
        </span>
      </label>
      <p className="small muted">
        Auto-reply mode also enables generation for new incoming messages, using
        its separate sending consent in Reply preferences.
      </p>
      <div className="button-pair">
        <button
          type="button"
          className="button primary"
          disabled={busy || (!token && !state.backend.paired)}
          onClick={() => {
            void connect();
          }}
        >
          Connect AI backend
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy || !state.backend.paired}
          onClick={() => {
            void act({ type: 'DISCONNECT_BACKEND', version: 1 }).then((ok) => {
              if (ok) {
                setAutoSuggest(false);
                setNotice('Disconnected. Automatic AI suggestions are off.');
              }
            });
          }}
        >
          Disconnect
        </button>
      </div>
      {state.backend.provider && (
        <p className="small muted">
          Provider: {state.backend.provider} · Model: {state.backend.model}
        </p>
      )}
      {state.backend.error && (
        <p className="error-notice" role="alert">
          Connection needs attention: {state.backend.error}. Check the backend
          and pairing code.
        </p>
      )}
      <p className="small muted" role="status">
        {notice}
      </p>
    </section>
  );
}
