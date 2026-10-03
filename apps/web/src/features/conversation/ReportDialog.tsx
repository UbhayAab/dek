// Report a message to the organization's admins (DEK13). Success shows only
// after the server stored the report.
import { useId, useState } from 'react';
import { api } from '../../api/rpc';
import type { Report } from '../../api/types';
import { humanError } from '../../api/errors';
import { Banner, Button, Modal, TextArea, toast } from '../../ui/kit';

const REASONS: { value: Report['reason']; label: string; hint: string }[] = [
  { value: 'spam', label: 'Spam', hint: 'Unwanted promotion or repeated messages' },
  { value: 'harassment', label: 'Harassment', hint: 'Bullying, threats or targeting someone' },
  { value: 'inappropriate', label: 'Inappropriate content', hint: 'Offensive, explicit or unsafe material' },
  { value: 'other', label: 'Something else', hint: 'Tell the admins what is wrong' },
];

interface Props {
  open: boolean;
  orgId: string;
  messageId: string;
  authorName: string;
  onClose: () => void;
}

export function ReportDialog({ open, orgId, messageId, authorName, onClose }: Props) {
  const [reason, setReason] = useState<Report['reason'] | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();

  const submit = async () => {
    if (!reason) {
      setError('Choose a reason so the admins know what to look at.');
      return;
    }
    if (reason === 'other' && !details.trim()) {
      setError('Add a few words about what is wrong.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.report({ kind: 'message', org: orgId, message: messageId, reason, details: details.trim() || null });
      toast({ kind: 'success', title: 'Report sent', body: 'The organization admins will review it. They are not told who reported.' });
      onClose();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title="Report message" size="sm"
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={() => void submit()} loading={busy}>Send report</Button>
      </>}>
      <div className="dk-report">
        <p className="dk-report__lead">{`Report this message from ${authorName} to the admins of this organization.`}</p>
        <fieldset className="dk-report__reasons">
          <legend className="dk-report__legend">Reason</legend>
          {REASONS.map((r) => (
            <label key={r.value} className={`dk-radio${reason === r.value ? ' is-on' : ''}`}>
              <input type="radio" name={name} value={r.value} checked={reason === r.value} onChange={() => { setReason(r.value); setError(null); }} />
              <span className="dk-radio__text">
                <span className="dk-radio__label">{r.label}</span>
                <span className="dk-radio__hint">{r.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <TextArea label="Details" hint="Optional unless you chose Something else. At most 1000 characters." maxLength={1000}
          value={details} onChange={(e) => setDetails(e.target.value)} rows={3} />
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </div>
    </Modal>
  );
}
