import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Badge, ConfirmDialog, Empty, ErrorBanner, PageHeader, Spinner } from '../components/ui';
import { useLoad, useTitle } from '../hooks';
import { fmtDateTime } from '../lib/format';
import type { SessionInfo } from '../types';
import { PasswordForm } from './ChangePasswordPage';

export function AccountSettingsPage() {
  useTitle('My account');
  const { user } = useAuth();
  const sessions = useLoad(async () => (await api.get<SessionInfo[]>('/auth/sessions')).data, []);
  const [revoking, setRevoking] = useState<SessionInfo | null>(null);

  return (
    <>
      <PageHeader title="My account" />
      <div className="card">
        <h2>Profile</h2>
        <dl className="kv">
          <dt>Name</dt><dd>{user?.name}</dd>
          <dt>Email</dt><dd>{user?.email}</dd>
          <dt>Roles</dt><dd>{user?.roles.map((r) => <Badge key={r} tone="info">{r}</Badge>)}</dd>
          <dt>Last sign-in</dt><dd>{fmtDateTime(user?.lastLoginAt)}</dd>
        </dl>
      </div>
      <div className="card">
        <h2>Change password</h2>
        <div style={{ maxWidth: 420 }}><PasswordForm onDone={() => sessions.reload()} /></div>
      </div>
      <div className="card">
        <h2>Active sessions</h2>
        {sessions.loading && <Spinner />}
        {sessions.error != null && <ErrorBanner error={sessions.error} onRetry={sessions.reload} />}
        {sessions.data && sessions.data.length === 0 && <Empty>No active sessions.</Empty>}
        {sessions.data && sessions.data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Device</th><th>IP</th><th>Signed in</th><th>Last used</th><th /></tr></thead>
              <tbody>
                {sessions.data.map((s) => (
                  <tr key={s.id}>
                    <td>{s.userAgent ?? 'Unknown'} {s.current && <Badge tone="ok">This device</Badge>}</td>
                    <td>{s.ip ?? '—'}</td>
                    <td>{fmtDateTime(s.createdAt)}</td>
                    <td>{fmtDateTime(s.lastUsedAt)}</td>
                    <td className="actions">{!s.current && <button className="btn small" onClick={() => setRevoking(s)}>Sign out</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {revoking && (
        <ConfirmDialog
          title="Sign out this session?"
          message="The device will be signed out immediately."
          confirmLabel="Sign out"
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await api.del(`/auth/sessions/${revoking.id}`);
            sessions.reload();
          }}
        />
      )}
    </>
  );
}
