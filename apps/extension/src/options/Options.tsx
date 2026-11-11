import { useEffect, useRef, useState } from 'react';
import { BusinessProfileSchema, LanguageSchema } from '@assistant/contracts';
import type { BusinessProfile } from '@assistant/contracts';
import type { AssistantClient } from '../messaging/client.js';
import type { ProfileEdit } from '../messaging/contracts.js';
import { ProfileEditSchema } from '../messaging/contracts.js';
import { useAssistant } from '../ui/use-assistant.js';
import { AiConnection } from './AiConnection.js';
import { AdapterDiagnostics } from './AdapterDiagnostics.js';
import { AdminFollowups } from './HandoffInbox.js';
import {
  Brand,
  Card,
  EnabledSwitch,
  ErrorNotice,
  Loading,
  StatusPill,
} from '../ui/shared.js';

interface ProfileFormProps {
  profile: BusinessProfile;
  revision: number;
  busy: boolean;
  save: (edit: ProfileEdit) => Promise<boolean>;
}
const fieldsFrom = (
  profile: BusinessProfile,
  revision: number,
): ProfileEdit => ({
  profileId: profile.id,
  expectedRevision: revision,
  name: profile.name,
  tone: profile.tone,
  defaultLanguage: profile.defaultLanguage,
  timezone: profile.timezone,
  workingHours: profile.workingHours.description,
  replyMode:
    profile.replyMode === 'AUTO_SAFE_OFFICIAL_TRANSPORT'
      ? 'DRAFT_ONLY'
      : profile.replyMode,
  webAutoSendOptIn: profile.webAutoSendOptIn,
  autoOpenUnread: profile.autoOpenUnread,
  includeExistingUnread: profile.includeExistingUnread,
  backgroundReplies: profile.backgroundReplies,
  keepAwake: profile.keepAwake,
  perChatCooldownSeconds: profile.behavior.perChatCooldownSeconds,
  replyInstructions: profile.replyInstructions,
  businessInformation: profile.businessInformation,
  followupReply: profile.followupReply,
  followupCommitmentConfirmed: profile.followupCommitmentConfirmed,
  storeRawMessages: profile.privacy.storeRawMessages,
  logRetentionDays: profile.privacy.logRetentionDays,
});
function ProfileForm({ profile, revision, busy, save }: ProfileFormProps) {
  const [fields, setFields] = useState(() => fieldsFrom(profile, revision));
  const [dirty, setDirty] = useState(false);
  const editing = useRef(false);
  const [validation, setValidation] = useState('');
  const [saved, setSaved] = useState(false);
  const [powerPending, setPowerPending] = useState(false);
  const [powerNotice, setPowerNotice] = useState('');
  const powerRequest = useRef(0);
  useEffect(() => {
    return () => {
      powerRequest.current++;
    };
  }, [profile.id]);
  useEffect(() => {
    let current = true;
    if (
      fields.keepAwake &&
      typeof chrome !== 'undefined' &&
      chrome.permissions?.contains
    )
      void chrome.permissions
        .contains({ permissions: ['power'] })
        .then((allowed) => {
          if (current && !allowed)
            setPowerNotice(
              'Chrome permission is missing. Turn Keep computer awake off and on to allow it again.',
            );
        })
        .catch(() => {
          if (current)
            setPowerNotice(
              'Chrome could not check the keep-awake permission. Turn the option off and on to try again.',
            );
        });
    return () => {
      current = false;
    };
  }, [fields.keepAwake]);
  useEffect(() => {
    // A first input can precede the previous render's passive effect. Check
    // synchronous edit ownership rather than that effect's stale dirty value.
    if (!editing.current) setFields(fieldsFrom(profile, revision));
  }, [profile, revision, dirty]);
  function update(change: Partial<ProfileEdit>) {
    powerRequest.current++;
    setPowerPending(false);
    setPowerNotice('');
    editing.current = true;
    setFields((current) => ({ ...current, ...change }));
    setDirty(true);
    setSaved(false);
  }
  function requestKeepAwake(checked: boolean) {
    if (!checked) {
      update({ keepAwake: false });
      return;
    }
    const requestId = ++powerRequest.current;
    setPowerPending(true);
    setPowerNotice('');
    try {
      // Request in the checkbox's user gesture, before awaiting any other work.
      const permission = chrome.permissions.request({ permissions: ['power'] });
      void permission
        .then((allowed) => {
          if (requestId !== powerRequest.current) return;
          if (allowed) update({ keepAwake: true });
          else
            setPowerNotice(
              'Chrome did not allow keep-awake. Background replies can still run while the computer is awake.',
            );
        })
        .catch(() => {
          if (requestId === powerRequest.current)
            setPowerNotice(
              'Could not request Chrome keep-awake permission. Reload the extension and try again.',
            );
        })
        .finally(() => {
          if (requestId === powerRequest.current) setPowerPending(false);
        });
    } catch {
      setPowerPending(false);
      setPowerNotice(
        'Could not request Chrome keep-awake permission. Reload the extension and try again.',
      );
    }
  }
  async function submit() {
    const parsed = ProfileEditSchema.safeParse(fields);
    if (!parsed.success) {
      setValidation(
        parsed.error.issues.map((issue) => issue.message).join('. '),
      );
      return;
    }
    setValidation('');
    if (await save(parsed.data)) {
      editing.current = false;
      setDirty(false);
      setSaved(true);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <section id="business" className="card form-card">
        <div className="card-heading">
          <div>
            <h2>Business profile</h2>
            <p className="muted">Give your assistant a little context.</p>
          </div>
          <span className="pill pill-muted">Sample profile</span>
        </div>
        <label className="field">
          Business name
          <input
            required
            maxLength={200}
            value={fields.name}
            onChange={(event) => update({ name: event.target.value })}
          />
        </label>
        <div className="field-grid">
          <label className="field">
            Industry
            <input value={profile.industry} readOnly />
          </label>
          <label className="field">
            Timezone
            <input
              required
              maxLength={100}
              value={fields.timezone}
              placeholder="Asia/Kolkata"
              onChange={(event) => update({ timezone: event.target.value })}
            />
          </label>
        </div>
        <label className="field">
          Business hours
          <input
            required
            maxLength={500}
            value={fields.workingHours}
            onChange={(event) => update({ workingHours: event.target.value })}
          />
          <span className="field-hint">
            Describe your hours here. This text field does not restrict when
            replies are sent.
          </span>
        </label>
      </section>
      <section id="preferences" className="card form-card">
        <h2>Reply preferences</h2>
        <p className="muted">Set the voice you want to build on.</p>
        <div className="field-grid">
          <label className="field">
            Tone
            <select
              value={fields.tone}
              onChange={(event) =>
                update({
                  tone: BusinessProfileSchema.shape.tone.parse(
                    event.target.value,
                  ),
                })
              }
            >
              <option value="friendly">Friendly</option>
              <option value="professional">Professional</option>
              <option value="formal">Formal</option>
              <option value="casual">Casual</option>
            </select>
          </label>
          <label className="field">
            Default language
            <select
              value={fields.defaultLanguage}
              onChange={(event) =>
                update({
                  defaultLanguage: LanguageSchema.parse(event.target.value),
                })
              }
            >
              <option value="en">English</option>
              <option value="kn">Kannada · ಕನ್ನಡ</option>
              <option value="te">Telugu · తెలుగు</option>
              <option value="ta">Tamil · தமிழ்</option>
              <option value="hi">Hindi · हिन्दी</option>
            </select>
          </label>
        </div>
        <p className="small muted">
          These preferences apply to live AI suggestions. The optional fixed
          sample remains in English.
        </p>
        <fieldset className="mode-fieldset">
          <legend>Reply mode</legend>
          <label
            className={`mode-option ${fields.replyMode === 'DRAFT_ONLY' ? 'selected' : ''}`}
          >
            <input
              type="radio"
              name="replyMode"
              value="DRAFT_ONLY"
              checked={fields.replyMode === 'DRAFT_ONLY'}
              onChange={() =>
                update({
                  replyMode: 'DRAFT_ONLY',
                  webAutoSendOptIn: false,
                  autoOpenUnread: false,
                  includeExistingUnread: false,
                  backgroundReplies: false,
                  keepAwake: false,
                })
              }
            />
            <span>
              <strong>Draft only</strong>
              <span className="small muted">
                Review every suggestion before you send.
              </span>
            </span>
            <span className="pill pill-green">Recommended</span>
          </label>
          <label
            className={`mode-option ${fields.replyMode === 'AUTO_REPLY_WEB' ? 'selected' : ''}`}
          >
            <input
              type="radio"
              name="replyMode"
              value="AUTO_REPLY_WEB"
              checked={fields.replyMode === 'AUTO_REPLY_WEB'}
              onChange={() => update({ replyMode: 'AUTO_REPLY_WEB' })}
            />
            <span>
              <strong>Auto-reply</strong>
              <span className="small muted">
                Generate and send eligible replies in the active WhatsApp chat.
              </span>
            </span>
          </label>
          {fields.replyMode === 'AUTO_REPLY_WEB' && (
            <label className="consent-option">
              <input
                type="checkbox"
                checked={fields.webAutoSendOptIn}
                onChange={(event) =>
                  update({
                    webAutoSendOptIn: event.target.checked,
                    autoOpenUnread:
                      event.target.checked && fields.autoOpenUnread === true,
                    includeExistingUnread:
                      event.target.checked &&
                      fields.includeExistingUnread === true,
                    backgroundReplies:
                      event.target.checked && fields.backgroundReplies === true,
                    keepAwake:
                      event.target.checked && fields.keepAwake === true,
                  })
                }
              />
              <span>
                Allow automatic sending without review
                <span className="small muted">
                  New incoming text and business information go to your selected
                  AI provider. Keep WhatsApp open. Missing facts receive a
                  standard fallback reply. Pause any chat from the workspace.
                </span>
              </span>
            </label>
          )}
          {fields.replyMode === 'AUTO_REPLY_WEB' && fields.webAutoSendOptIn && (
            <label className="consent-option">
              <input
                type="checkbox"
                checked={Boolean(fields.backgroundReplies)}
                onChange={(event) =>
                  update({
                    backgroundReplies: event.target.checked,
                    keepAwake:
                      event.target.checked && fields.keepAwake === true,
                  })
                }
              />
              <span>
                Reply while WhatsApp is in the background
                <span className="small muted">
                  Continue automatic replies when you switch tabs or minimize
                  Chrome. Keep one WhatsApp Web tab, Chrome and the backend
                  open. The computer must stay awake and connected.
                </span>
              </span>
            </label>
          )}
          {fields.replyMode === 'AUTO_REPLY_WEB' &&
            fields.webAutoSendOptIn &&
            fields.backgroundReplies && (
              <div>
                <label className="consent-option">
                  <input
                    type="checkbox"
                    checked={Boolean(fields.keepAwake)}
                    disabled={powerPending || busy}
                    onChange={(event) => requestKeepAwake(event.target.checked)}
                  />
                  <span>
                    Keep computer awake while Replio runs
                    <span className="small muted">
                      Allow Chrome to prevent idle sleep while background
                      replies are enabled. Your screen can turn off. Manual
                      sleep, closing the lid, shutting down or closing Chrome
                      can still stop replies.
                    </span>
                  </span>
                </label>
                {powerPending && (
                  <p className="small muted" role="status">
                    Waiting for Chrome permission…
                  </p>
                )}
                {powerNotice && (
                  <p className="small muted" role="status">
                    {powerNotice}
                  </p>
                )}
              </div>
            )}
          {fields.replyMode === 'AUTO_REPLY_WEB' && fields.webAutoSendOptIn && (
            <label className="consent-option">
              <input
                type="checkbox"
                checked={Boolean(fields.autoOpenUnread)}
                onChange={(event) =>
                  update({
                    autoOpenUnread: event.target.checked,
                    includeExistingUnread:
                      event.target.checked &&
                      fields.includeExistingUnread === true,
                  })
                }
              />
              <span>
                Open new unread chats automatically
                <span className="small muted">
                  Keep the WhatsApp chat list open. When a chat gets a new
                  unread text, the assistant can open it, mark it as read and
                  reply.
                </span>
              </span>
            </label>
          )}
          {fields.replyMode === 'AUTO_REPLY_WEB' &&
            fields.webAutoSendOptIn &&
            fields.autoOpenUnread && (
              <label className="consent-option">
                <input
                  type="checkbox"
                  checked={Boolean(fields.includeExistingUnread)}
                  onChange={(event) =>
                    update({ includeExistingUnread: event.target.checked })
                  }
                />
                <span>
                  Include chats that are already unread
                  <span className="small muted">
                    When monitoring starts, open chats with unread badges in the
                    visible list, one at a time. Reply to the latest verified
                    unread text in each chat.
                  </span>
                </span>
              </label>
            )}
          <label
            className={`mode-option ${fields.replyMode === 'OFF' ? 'selected' : ''}`}
          >
            <input
              type="radio"
              name="replyMode"
              value="OFF"
              checked={fields.replyMode === 'OFF'}
              onChange={() =>
                update({
                  replyMode: 'OFF',
                  webAutoSendOptIn: false,
                  autoOpenUnread: false,
                  includeExistingUnread: false,
                  backgroundReplies: false,
                  keepAwake: false,
                })
              }
            />
            <span>
              <strong>Off</strong>
              <span className="small muted">
                Pause assistant replies for this business.
              </span>
            </span>
          </label>
        </fieldset>
        <label className="field">
          Minimum time between replies (seconds)
          <input
            type="number"
            min={0}
            max={86400}
            step={1}
            required
            value={
              Number.isNaN(fields.perChatCooldownSeconds)
                ? ''
                : (fields.perChatCooldownSeconds ??
                  profile.behavior.perChatCooldownSeconds)
            }
            onChange={(event) =>
              update({ perChatCooldownSeconds: event.target.valueAsNumber })
            }
          />
          <span className="field-hint">
            New messages received close together wait automatically. Only the
            latest message is answered. Use 0 for no cooldown.
          </span>
        </label>
        <label className="field">
          Reply instructions
          <textarea
            rows={6}
            maxLength={8000}
            value={fields.replyInstructions}
            placeholder="For example: Reply politely, use the customer’s language, keep replies brief, and ask our team when unsure."
            onChange={(event) =>
              update({ replyInstructions: event.target.value })
            }
          />
          <span className="field-hint">
            Rules for tone, language and escalation. Do not paste API keys here.
            Set saved-request wording under Follow-up reply below.
          </span>
        </label>
        <label className="field">
          Business information
          <textarea
            rows={7}
            maxLength={16000}
            value={fields.businessInformation}
            placeholder="Add confirmed products, exact prices, hours, availability, document requirements and policies."
            onChange={(event) =>
              update({ businessInformation: event.target.value })
            }
          />
          <span className="field-hint">
            The AI uses these facts. Missing facts produce a human-help draft
            rather than a guess.
          </span>
        </label>
      </section>
      <section
        id="followup-reply"
        className="card form-card"
        aria-labelledby="followup-reply-title"
      >
        <h2 id="followup-reply-title">Follow-up reply</h2>
        <p className="muted">
          Choose what customers see after a callback request or unresolved
          question is saved for your admin.
        </p>
        <label className="field">
          Saved follow-up reply
          <textarea
            rows={3}
            maxLength={1000}
            aria-label="Saved follow-up reply"
            aria-describedby="followup-reply-hint"
            value={fields.followupReply ?? ''}
            placeholder="Our team will reach out to you soon."
            onChange={(event) => update({ followupReply: event.target.value })}
          />
          <span className="field-hint" id="followup-reply-hint">
            Sent exactly as written for successfully saved follow-ups. Leave
            blank to keep the standard acknowledgement in the customer’s
            language. Reply instructions do not change this message.
          </span>
        </label>
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            update({
              followupReply: 'Our team will reach out to you soon.',
            })
          }
        >
          Use suggested reply
        </button>
        <label className="consent-option">
          <input
            type="checkbox"
            aria-label="Our team will handle saved follow-ups and contact customers as promised"
            aria-describedby="followup-commitment-hint"
            checked={Boolean(fields.followupCommitmentConfirmed)}
            onChange={(event) =>
              update({ followupCommitmentConfirmed: event.target.checked })
            }
          />
          <span>
            Our team will handle saved follow-ups and contact customers as
            promised
            <span className="small muted" id="followup-commitment-hint">
              Confirm this to use your custom message. Until then, the assistant
              keeps the standard acknowledgement.
            </span>
          </span>
        </label>
        <p className="small muted">
          Your reply is used only after the request is saved successfully. If
          saving cannot be confirmed, the assistant asks the customer to contact
          your team directly.
        </p>
      </section>
      <section id="privacy" className="card form-card">
        <h2>Privacy &amp; storage</h2>
        <label className="consent-option">
          <input
            type="checkbox"
            checked={Boolean(fields.storeRawMessages)}
            onChange={(event) =>
              update({ storeRawMessages: event.target.checked })
            }
          />
          <span>
            <strong>Save customer questions in follow-ups on this PC</strong>
            <span className="small muted">
              Off by default. Follow-ups still save the chat label, reason and
              status. Turn this on to keep the full question for your admin.
              Turning it off removes previously saved questions.
            </span>
          </span>
        </label>
        <label className="field">
          Follow-up retention (days)
          <input
            type="number"
            min={1}
            max={365}
            step={1}
            required
            value={
              Number.isNaN(fields.logRetentionDays)
                ? ''
                : (fields.logRetentionDays ?? profile.privacy.logRetentionDays)
            }
            onChange={(event) =>
              update({ logRetentionDays: event.target.valueAsNumber })
            }
          />
          <span className="field-hint">
            Older follow-ups are removed automatically after this period.
          </span>
        </label>
      </section>
      <ErrorNotice message={validation} />
      {dirty && revision !== fields.expectedRevision && (
        <div className="error-notice" role="alert">
          Settings changed elsewhere. Your edits are kept here. Reload this page
          to review the latest version before saving.
          <button
            type="button"
            className="text-button"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      )}
      <div className="save-bar">
        <span className="small muted" role="status">
          {saved
            ? 'Settings saved'
            : dirty
              ? 'You have unsaved changes'
              : 'All changes saved'}
        </span>
        <button
          type="submit"
          className="button primary"
          disabled={busy || !dirty || revision !== fields.expectedRevision}
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

export function Options({ client }: { client?: AssistantClient }) {
  const { state, error, busy, act } = useAssistant(client);
  if (!state) return <Loading error={error} />;
  const profile = state.settings.profiles.find(
    (item) => item.id === state.settings.activeProfileId,
  );
  if (!profile) return <Loading error="The active profile is missing." />;
  return (
    <div className="options-page">
      <header className="options-topbar">
        <Brand />
        <span className="pill pill-muted">WhatsApp + AI suggestions</span>
      </header>
      <div className="options-layout">
        <aside className="settings-sidebar">
          <span className="eyebrow">YOUR WORKSPACE</span>
          <div className="business-tile">
            <span className="avatar">SC</span>
            <div>
              <strong>{profile.name}</strong>
              <span className="small muted">Sample business</span>
            </div>
          </div>
          <nav aria-label="Settings sections">
            <a href="#business" className="nav-active">
              Business profile <span aria-hidden="true">↗</span>
            </a>
            <a href="#preferences">Reply preferences</a>
            <a href="#followup-reply">Follow-up reply</a>
            <a href="#follow-ups">Admin follow-ups</a>
            <a href="#privacy">Privacy & storage</a>
            <a href="#connections">Connections</a>
          </nav>
          <div className="sidebar-note">
            <span aria-hidden="true">◇</span>
            <p>
              Good support starts with trust.
              <br />
              Choose how your assistant replies.
            </p>
          </div>
        </aside>
        <main className="settings-main">
          <div className="settings-heading">
            <div>
              <span className="eyebrow">MAKE IT YOURS</span>
              <h1>
                Your business.
                <br />
                Your way of helping.
              </h1>
              <p className="muted">
                A few thoughtful defaults for better conversations.
              </p>
            </div>
            <StatusPill enabled={state.settings.enabled} />
          </div>
          <div className="control-row card">
            <div>
              <strong>Assistant enabled</strong>
              <p className="small muted">
                Switch off to pause replies for this business.
              </p>
            </div>
            <EnabledSwitch
              enabled={state.settings.enabled}
              disabled={busy}
              onChange={(enabled) =>
                act({ version: 1, type: 'SET_ENABLED', enabled })
              }
            />
          </div>
          <ErrorNotice message={error} />
          <ProfileForm
            key={profile.id}
            profile={profile}
            revision={state.settings.revision}
            busy={busy}
            save={(edit) => act({ version: 1, type: 'SAVE_PROFILE', edit })}
          />
          <AdminFollowups
            key={`handoffs-${profile.id}`}
            state={state}
            busy={busy}
            act={act}
          />
          <AiConnection
            key={`connection-${profile.id}`}
            state={state}
            busy={busy}
            act={act}
          />
          <AdapterDiagnostics state={state} busy={busy} act={act} />
          <section id="storage-summary">
            <Card title="Storage summary">
              <div className="status-list">
                <div>
                  <span>Customer questions in follow-ups</span>
                  <strong>
                    {profile.privacy.storeRawMessages
                      ? 'Saved on this PC'
                      : 'Not stored'}
                  </strong>
                </div>
                <div>
                  <span>Phone masking</span>
                  <strong>Always on</strong>
                </div>
                <div>
                  <span>Follow-up retention</span>
                  <strong>{profile.privacy.logRetentionDays} days</strong>
                </div>
                <div>
                  <span>Settings location</span>
                  <strong>This browser</strong>
                </div>
              </div>
              <p className="small muted">
                Settings, follow-up records and hashed duplicate identifiers are
                saved locally. Customer questions are saved only when you enable
                that option above; other live messages and replies stay in
                worker memory. New incoming text is sent to your selected
                provider only after you connect a backend and enable AI
                suggestions or Auto-reply, or explicitly generate a reply.
                Provider data policies still apply.
              </p>
            </Card>
          </section>
          <section id="connections">
            <Card title="Connections">
              <div className="connection-row">
                <span className="connection-icon" aria-hidden="true">
                  ▤
                </span>
                <div>
                  <strong>Sample bakery knowledge</strong>
                  <p className="small muted">
                    Static demonstration · No live sync
                  </p>
                </div>
                <span className="pill pill-muted">Sample</span>
              </div>
              <div className="connection-row">
                <span className="connection-icon" aria-hidden="true">
                  ↗
                </span>
                <div>
                  <strong>WhatsApp Web</strong>
                  <p className="small muted">
                    {profile.includeExistingUnread
                      ? 'Open existing and newly unread chats'
                      : profile.autoOpenUnread
                        ? 'Open chats with new unread messages'
                        : 'New messages in the open chat only'}
                  </p>
                </div>
                <span className="pill pill-muted">
                  {state.adapterStatus === 'READY' ? 'Ready' : 'Waiting'}
                </span>
              </div>
              <p className="small muted">
                Google Sheets setup arrives in Milestone 4. Multiple business
                profiles arrive in Milestone 7.
              </p>
            </Card>
          </section>
          <footer className="settings-footer">
            Replio — AI Business Assistant · Built around your business.
          </footer>
        </main>
      </div>
    </div>
  );
}
