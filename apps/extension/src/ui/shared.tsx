import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Settings } from '../messaging/contracts.js';

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M5 4h14v12H9l-4 4V4Z" />
          <path d="M9 8h6M9 12h4" />
        </svg>
      </span>
      <span>
        Replio <span className="brand-sub">— AI Business Assistant</span>
      </span>
    </div>
  );
}
export function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span className={`pill ${enabled ? 'pill-green' : 'pill-muted'}`}>
      <span className="status-dot" />
      {enabled ? 'Enabled' : 'Paused'}
    </span>
  );
}
export function EnabledSwitch({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => Promise<boolean>;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  return (
    <label className="switch">
      <input
        type="checkbox"
        aria-label="Assistant enabled"
        checked={pending ?? enabled}
        disabled={disabled || pending !== null}
        onChange={(event) => {
          const next = event.target.checked;
          setPending(next);
          void onChange(next).finally(() => setPending(null));
        }}
      />
      <span />
    </label>
  );
}
export function ErrorNotice({ message }: { message: string }) {
  return message ? (
    <div className="error-notice" role="alert">
      {message}
    </div>
  ) : null;
}
export function Loading({ error }: { error: string }) {
  return (
    <main className="loading">
      <Brand />
      <h1>Getting things ready</h1>
      <ErrorNotice message={error} />
      {!error && <p role="status">Loading your business settings…</p>}
      <p className="muted">
        If this keeps happening, reload the extension from chrome://extensions.
      </p>
    </main>
  );
}
export function ProfileSelect({
  settings,
  disabled,
  onChange,
}: {
  settings: Settings;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <label className="field">
      Active business
      <select
        value={settings.activeProfileId}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {settings.profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
    </label>
  );
}
export function Card({
  title,
  children,
  className = '',
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
export function openSettings() {
  if (typeof chrome !== 'undefined') return chrome.runtime.openOptionsPage();
  return Promise.reject(
    new Error('Open settings from the installed extension.'),
  );
}
export function openFollowups() {
  if (typeof chrome !== 'undefined')
    return chrome.tabs.create({
      url: chrome.runtime.getURL('options.html#follow-ups'),
    });
  return Promise.reject(
    new Error('Open follow-ups from the installed extension.'),
  );
}
