import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { Badge, ConfirmDialog, ErrorBanner, InfoBanner, PageHeader, Spinner } from '../components/ui';
import { useLoad, useTitle } from '../hooks';
import type { GmailConnection } from '../types';

const GOOGLE_AUTH_PREFIX = 'https://accounts.google.com/';

export function GmailSettingsPage() {
  useTitle('Gmail connection');
  const [params] = useSearchParams();
  const conn = useLoad(async () => (await api.get<GmailConnection>('/email/connection')).data, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const c = conn.data;

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ url: string }>('/email/connection/start');
      // Only ever leave for Google's own consent screen.
      if (!r.data.url.startsWith(GOOGLE_AUTH_PREFIX)) throw new Error('Unexpected redirect address; connection cancelled.');
      window.location.assign(r.data.url);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Gmail connection" />
      {params.get('connected') === '1' && <InfoBanner kind="ok">Gmail connected. You can now send documents from your own address.</InfoBanner>}
      {params.get('error') && <InfoBanner kind="warn">The connection was not completed. Try again, or contact an administrator.</InfoBanner>}
      {conn.loading && !c && <Spinner />}
      {conn.error != null && <ErrorBanner error={conn.error} onRetry={conn.reload} />}
      {error && <ErrorBanner message={error} />}
      {c && (
        <div className="card stack">
          <p>
            Status:{' '}
            <Badge tone={c.status === 'ACTIVE' ? 'ok' : c.status === 'NONE' ? 'neutral' : 'bad'}>
              {c.status === 'ACTIVE' ? 'Connected' : c.status === 'NONE' ? 'Not connected' : c.status === 'REVOKED' ? 'Access revoked' : 'Error'}
            </Badge>
            {c.googleEmail && <> as <strong>{c.googleEmail}</strong></>}
          </p>
          <p className="muted">
            Connecting lets this app send email as you, from your own Gmail address. It asks Google for permission to <strong>send email only</strong>: it cannot read your mail. You can disconnect at any time, and an administrator can too.
          </p>
          {!c.available && <InfoBanner kind="warn">Gmail sending is not enabled on this system yet. Contact an administrator.</InfoBanner>}
          <div className="row">
            {c.status !== 'ACTIVE' && <button className="btn primary" onClick={connect} disabled={busy || !c.available}>{busy ? 'Opening Google…' : 'Connect Gmail'}</button>}
            {c.status === 'ACTIVE' && <button className="btn danger" onClick={() => setConfirm(true)}>Disconnect</button>}
          </div>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title="Disconnect Gmail?"
          message="You will not be able to send documents until you connect again. Access is also revoked at Google."
          confirmLabel="Disconnect"
          danger
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await api.del('/email/connection');
            conn.reload();
          }}
        />
      )}
    </>
  );
}
