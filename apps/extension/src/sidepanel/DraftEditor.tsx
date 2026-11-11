import { useState } from 'react';
import { Card } from '../ui/shared.js';

export function DraftEditor({ reply }: { reply: string }) {
  const [draft, setDraft] = useState(reply);
  return (
    <Card title="Suggested reply" className="draft-card">
      <div className="confidence">
        <span className="confidence-dot" />
        Sample confidence · 100%
      </div>
      <label className="sr-only" htmlFor="reply">
        Suggested reply
      </label>
      <textarea
        id="reply"
        rows={7}
        maxLength={16000}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p className="small muted">
        Edit freely. This sample draft is kept only while this page is open.
      </p>
      <div className="button-pair">
        <button
          className="button secondary"
          disabled
          title="Fictional sample drafts stay in the preview"
        >
          Insert draft
        </button>
        <button
          className="button primary"
          disabled
          title="Sample replies are never sent"
        >
          Send reply
        </button>
      </div>
      <p className="small muted">
        Use the live workspace for WhatsApp suggestions. This sample stays in
        the preview.
      </p>
    </Card>
  );
}
