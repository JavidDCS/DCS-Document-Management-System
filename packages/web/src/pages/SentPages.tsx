import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Badge, Empty, ErrorBanner, InfoBanner, PageHeader, Pagination, Spinner } from '../components/ui';
import { useLoad, usePolling, useTitle } from '../hooks';
import { fmtDateTime, fmtSize } from '../lib/format';
import type { EmailDetail, EmailListItem, ListMeta } from '../types';
import { emailTone } from './DashboardPage';

const LIMIT = 20;

export function SentListPage() {
  useTitle('Sent history');
  const { can } = useAuth();
  const [offset, setOffset] = useState(0);
  const [all, setAll] = useState(false);
  const list = useLoad(async () => {
    const r = await api.get<EmailListItem[]>('/email/messages', { limit: LIMIT, offset, scope: all ? 'all' : undefined });
    return { rows: r.data, meta: r.meta as ListMeta };
  }, [offset, all]);

  return (
    <>
      <PageHeader title="Sent history">
        {can('email:read_all') && (
          <label className="check"><input type="checkbox" checked={all} onChange={(e) => { setAll(e.target.checked); setOffset(0); }} /><span>Show everyone’s emails</span></label>
        )}
      </PageHeader>
      {list.loading && !list.data && <Spinner />}
      {list.error != null && <ErrorBanner error={list.error} onRetry={list.reload} />}
      {list.data && list.data.rows.length === 0 && <Empty>No emails yet.</Empty>}
      {list.data && list.data.rows.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Subject</th>{all && <th>Sender</th>}<th>Recipients</th><th>Attachments</th><th>When</th><th>Status</th></tr></thead>
              <tbody>
                {list.data.rows.map((m) => (
                  <tr key={m.id}>
                    <td><Link to={`/sent/${m.id}`}>{m.subject}</Link></td>
                    {all && <td>{m.senderName}</td>}
                    <td>{m.recipientCount}</td>
                    <td>{m.attachmentCount}</td>
                    <td>{fmtDateTime(m.sentAt ?? m.createdAt)}</td>
                    <td><Badge tone={emailTone(m.status)}>{m.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12 }}><Pagination total={list.data.meta.total} limit={LIMIT} offset={offset} onChange={setOffset} /></div>
        </>
      )}
    </>
  );
}

export function SentDetailPage() {
  const { id = '' } = useParams();
  const mail = useLoad(async () => (await api.get<EmailDetail>(`/email/messages/${id}`)).data, [id]);
  const m = mail.data;
  useTitle(m?.subject ?? 'Email');
  usePolling(!!m && (m.status === 'QUEUED' || m.status === 'SENDING'), () => mail.reload(), 2000);

  if (mail.loading && !m) return <Spinner />;
  if (mail.error != null && !m) {
    return mail.error instanceof ApiError && mail.error.status === 404 ? (
      <div className="card"><h1>Email not found</h1><Link to="/sent">Back to sent history</Link></div>
    ) : <ErrorBanner error={mail.error} onRetry={mail.reload} />;
  }
  if (!m) return null;

  return (
    <>
      <PageHeader title={m.subject}><Badge tone={emailTone(m.status)}>{m.status}</Badge></PageHeader>
      {(m.status === 'QUEUED' || m.status === 'SENDING') && <InfoBanner>Sending… this page updates automatically.</InfoBanner>}
      {m.status === 'SENT' && <InfoBanner kind="ok">Sent {fmtDateTime(m.sentAt)}.</InfoBanner>}
      {m.status === 'FAILED' && <InfoBanner kind="warn">The email was not sent{m.errorCode ? ` (${m.errorCode})` : ''}. Check your Gmail connection and try again from Send documents.</InfoBanner>}
      {m.status === 'UNKNOWN' && <InfoBanner kind="warn">We could not confirm whether this email was sent. Check your Gmail “Sent” folder before sending it again, so the same documents are not sent twice.</InfoBanner>}

      <div className="card">
        <dl className="kv">
          <dt>From</dt><dd>{m.from}</dd>
          <dt>Sender</dt><dd>{m.senderName}</dd>
          <dt>Created</dt><dd>{fmtDateTime(m.createdAt)}</dd>
          <dt>Sent</dt><dd>{fmtDateTime(m.sentAt)}</dd>
          {m.providerMessageId && (<><dt>Gmail message id</dt><dd className="mono">{m.providerMessageId}</dd></>)}
        </dl>
      </div>
      <div className="card">
        <h2>Recipients</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Field</th><th>Address</th><th /></tr></thead>
          <tbody>{m.recipients.map((r) => (<tr key={`${r.kind}-${r.address}`}><td>{r.kind}</td><td>{r.address}</td><td>{r.external ? <Badge tone="warn">External</Badge> : null}</td></tr>))}</tbody>
        </table></div>
      </div>
      <div className="card">
        <h2>Attachments</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Document</th><th>Version</th><th>File</th><th>Size</th><th>SHA-256 at send</th></tr></thead>
          <tbody>{m.attachments.map((a) => (
            <tr key={a.versionId}><td><Link to={`/documents/${a.documentId}`}>{a.documentName}</Link></td><td>v{a.versionNumber}</td><td>{a.filename}</td><td>{fmtSize(a.sizeBytes)}</td><td className="mono">{a.sha256}</td></tr>
          ))}</tbody>
        </table></div>
      </div>
      <div className="card">
        <h2>Message</h2>
        <pre className="details" style={{ maxWidth: 'none' }}>{m.body}</pre>
      </div>
    </>
  );
}
