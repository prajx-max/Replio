import { useState } from 'react';
import { DraftEditor } from './DraftEditor.js';
import { LiveWorkspace } from './LiveWorkspace.js';
import { useAssistant } from '../ui/use-assistant.js';
import {
  Brand,
  Card,
  ErrorNotice,
  Loading,
  StatusPill,
  openSettings,
  openFollowups,
} from '../ui/shared.js';
import type { AssistantClient } from '../messaging/client.js';

export function SidePanel({ client }: { client?: AssistantClient }) {
  const { state, error, busy, act } = useAssistant(client);
  const [navigationError, setNavigationError] = useState('');
  const demo = state?.demo;
  const event = demo?.event;
  const decision =
    event?.type === 'ASSISTANT_DECISION_READY' ? event.payload.decision : null;
  const eventKey =
    event?.type === 'ASSISTANT_DECISION_READY' ? event.payload.eventKey : '';
  if (!state) return <Loading error={error} />;
  const profile = state.settings.profiles.find(
    (item) => item.id === state.settings.activeProfileId,
  );
  const enabled =
    state.settings.enabled &&
    profile !== undefined &&
    profile.replyMode !== 'OFF';
  const sampleEnabled = enabled && profile.replyMode === 'DRAFT_ONLY';
  return (
    <main className="panel-page">
      <header className="topbar">
        <Brand />
        <button
          className="text-button"
          onClick={() => {
            void openSettings().catch(() =>
              setNavigationError('Settings could not open.'),
            );
          }}
        >
          Settings <span aria-hidden="true">↗</span>
        </button>
      </header>
      <div className="panel-heading">
        <span className="eyebrow">REPLY WORKSPACE</span>
        <div className="heading-row">
          <h1>Make every reply count.</h1>
          <StatusPill enabled={enabled} />
        </div>
        <p className="muted">{profile?.name}</p>
      </div>
      <ErrorNotice message={error || navigationError} />
      <LiveWorkspace state={state} busy={busy} act={act} />
      <section
        className="card handoff-shortcut"
        aria-label="Admin follow-up inbox"
      >
        <p className="small muted">
          {
            state.handoffs.filter(
              (item) =>
                item.profileId === state.settings.activeProfileId &&
                item.status !== 'RESOLVED',
            ).length
          }{' '}
          follow-ups need attention
        </p>
        <button
          className="button secondary wide"
          type="button"
          onClick={() => {
            void openFollowups().catch(() =>
              setNavigationError('Admin follow-ups could not open.'),
            );
          }}
        >
          Open admin follow-ups
        </button>
      </section>
      <details className="sample-preview">
        <summary>Optional sample preview</summary>
        <div className="sample-banner">
          <span className="sample-symbol" aria-hidden="true">
            ✦
          </span>
          <div>
            <strong>Fictional bakery preview</strong>
            <p>
              Fictional conversation. This sample does not read or send WhatsApp
              messages.
            </p>
          </div>
        </div>
        <section className="conversation-card">
          <div className="section-label">
            <span>CONVERSATION</span>
            <span className="pill pill-muted">Sample</span>
          </div>
          <div className="customer">
            <span className="avatar" aria-hidden="true">
              SC
            </span>
            <div>
              <strong>Sample customer</strong>
              <span className="small muted">Fictional bakery enquiry</span>
            </div>
          </div>
          <div className="message-bubble">
            {demo?.customerMessage ??
              'Try a sample enquiry to see how a suggested reply will appear.'}
          </div>
          <button
            className="button secondary wide"
            disabled={busy || !sampleEnabled}
            onClick={() => {
              void act({
                version: 1,
                type: 'RUN_MOCK',
                profileId: state.settings.activeProfileId,
              });
            }}
          >
            {busy
              ? 'Preparing sample…'
              : demo
                ? 'Run sample again'
                : 'Try a sample enquiry'}{' '}
            <span aria-hidden="true">→</span>
          </button>
          {!sampleEnabled && (
            <p className="small muted">
              Enable the assistant and draft-only mode in settings to try the
              sample.
            </p>
          )}
        </section>
        {decision?.kind === 'ANSWER' ? (
          <>
            <div className="insight-row">
              <span className="pill pill-green">Normal priority</span>
              <span>English</span>
              <span>Price enquiry</span>
            </div>
            <DraftEditor key={eventKey} reply={decision.reply} />
            <Card title="Based on sample knowledge">
              <div className="source-record">
                <span className="source-icon" aria-hidden="true">
                  ▤
                </span>
                <div>
                  <strong>{decision.citations[0]?.title}</strong>
                  <p className="small muted">
                    ₹650 / 500 g · Eggless available · 6 hours advance
                  </p>
                </div>
              </div>
              <p className="small muted">
                A fixed sample reply. Live AI suggestions use your business
                information and reply instructions.
              </p>
            </Card>
          </>
        ) : (
          <section className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              ↗
            </span>
            <h2>Your next great reply starts here.</h2>
            <p>
              Run the sample to preview a draft, its source, and confidence.
            </p>
          </section>
        )}
      </details>
      <footer className="panel-footer">
        <span className="lock-icon" aria-hidden="true">
          ◇
        </span>
        {!enabled
          ? 'Assistant paused.'
          : profile?.replyMode === 'AUTO_REPLY_WEB'
            ? 'Auto-reply enabled · Pause a chat anytime.'
            : 'You review. You decide. You send.'}
      </footer>
    </main>
  );
}
