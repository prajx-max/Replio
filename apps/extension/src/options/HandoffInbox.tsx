import { useState } from 'react';
import type { HandoffRecord } from '@assistant/contracts';
import type { ShellRequest, ShellState } from '../messaging/contracts.js';
import { ErrorNotice } from '../ui/shared.js';

type Filter = HandoffRecord['status'] | 'ALL';
const statusLabel: Record<HandoffRecord['status'], string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
};

export function AdminFollowups({
  state,
  busy,
  act,
}: {
  state: ShellState;
  busy: boolean;
  act: (request: ShellRequest) => Promise<boolean>;
}) {
  const [filter, setFilter] = useState<Filter>('OPEN');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const profile = state.settings.profiles.find(
    (item) => item.id === state.settings.activeProfileId,
  );
  if (!profile) return null;
  const records = state.handoffs.filter(
    (item) => item.profileId === profile.id,
  );
  const visible = records.filter(
    (item) => filter === 'ALL' || item.status === filter,
  );
  const pendingCount = records.filter(
    (item) => item.status !== 'RESOLVED',
  ).length;
  async function setStatus(
    record: HandoffRecord,
    status: HandoffRecord['status'],
  ) {
    if (busy || pendingId !== null) return;
    setNotice('');
    setPendingId(record.id);
    try {
      const saved = await act({
        version: 1,
        type: 'UPDATE_HANDOFF',
        profileId: record.profileId,
        id: record.id,
        status,
      });
      if (!saved)
        setNotice('The follow-up could not be updated. Please try again.');
    } catch {
      setNotice('The follow-up could not be updated. Please try again.');
    } finally {
      setPendingId(null);
    }
  }
  return (
    <section
      className="card admin-followups"
      id="follow-ups"
      aria-labelledby="follow-ups-title"
    >
      <div className="card-heading">
        <div>
          <h2 id="follow-ups-title">Admin follow-ups</h2>
          <p className="muted">
            Callback requests and questions that need a person.
          </p>
        </div>
        <span className="pill pill-green">{pendingCount} need attention</span>
      </div>
      <p className="small muted">
        Saved in this browser on this PC. Check this inbox to contact customers;
        no separate team notification or callback is sent automatically.
      </p>
      <label className="field">
        Show follow-ups
        <select
          value={filter}
          onChange={(event) => {
            const value = event.target.value;
            if (
              value === 'ALL' ||
              value === 'OPEN' ||
              value === 'IN_PROGRESS' ||
              value === 'RESOLVED'
            )
              setFilter(value);
          }}
        >
          <option value="OPEN">Open</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="RESOLVED">Resolved</option>
          <option value="ALL">All follow-ups</option>
        </select>
      </label>
      <ErrorNotice message={notice} />
      {state.handoffError && (
        <div className="error-notice" role="alert">
          {state.handoffError === 'HANDOFF_CAPACITY'
            ? 'The follow-up inbox is full. New requests could not be saved. Existing follow-ups remain available below; contact customers manually until storage space is available.'
            : 'Some follow-ups could not be loaded or saved. Refresh to check the inbox.'}
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => {
              void act({ type: 'GET_STATE', version: 1 });
            }}
          >
            Refresh follow-ups
          </button>
        </div>
      )}
      {visible.length === 0 ? (
        state.handoffError && records.length === 0 ? null : (
          <p className="handoff-empty" role="status">
            {records.length === 0
              ? 'No follow-ups yet. Callback requests and unresolved questions will appear here.'
              : 'No follow-ups match this filter.'}
          </p>
        )
      ) : (
        <ul className="handoff-list">
          {visible.map((record) => (
            <li key={record.id}>
              <article
                className="handoff-record"
                aria-labelledby={`handoff-${record.id}`}
              >
                <div className="handoff-record-heading">
                  <h3 id={`handoff-${record.id}`}>
                    {record.chatLabel || 'Customer chat'}
                  </h3>
                  <span className="pill pill-muted">
                    {statusLabel[record.status]}
                  </span>
                </div>
                <p className="handoff-reason">
                  {record.reason === 'CALLBACK'
                    ? 'Callback requested'
                    : 'Needs an answer'}
                </p>
                <p className="small muted">
                  Saved{' '}
                  <time dateTime={record.createdAt}>
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: profile.timezone,
                    }).format(new Date(record.createdAt))}
                  </time>
                </p>
                {profile.privacy.storeRawMessages && record.question ? (
                  <p className="handoff-question">{record.question}</p>
                ) : (
                  <p className="small muted">
                    Customer question not stored. Review the conversation in
                    WhatsApp.
                  </p>
                )}
                <p className="small muted">
                  Find this chat in WhatsApp by its label to message or call the
                  customer. Phone identifiers in saved labels are masked.
                </p>
                <div className="handoff-actions">
                  {record.status !== 'IN_PROGRESS' &&
                    record.status !== 'RESOLVED' && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy || pendingId !== null}
                        onClick={() => {
                          void setStatus(record, 'IN_PROGRESS');
                        }}
                      >
                        Mark in progress
                      </button>
                    )}
                  {record.status !== 'RESOLVED' ? (
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy || pendingId !== null}
                      onClick={() => {
                        void setStatus(record, 'RESOLVED');
                      }}
                    >
                      Resolve
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || pendingId !== null}
                      onClick={() => {
                        void setStatus(record, 'OPEN');
                      }}
                    >
                      Reopen
                    </button>
                  )}
                  {pendingId === record.id && (
                    <span className="small muted" role="status">
                      Saving follow-up…
                    </span>
                  )}
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
      <p className="small muted">
        Follow-ups are kept for {profile.privacy.logRetentionDays} days. Change
        question storage and retention under Privacy &amp; storage.
      </p>
    </section>
  );
}
