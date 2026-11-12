import { useState, type FormEvent } from 'react';
import { api, errorMessage, fieldErrors } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { KeyRound, LogOut, Plus, Search, ShieldCheck, UserCheck, UserX, Users } from 'lucide-react';
import { toast } from 'sonner';
import { ActionMenu, Badge, ConfirmDialog, CopyButton, Empty, ErrorBanner, Field, InfoBanner, Modal, PageHeader, Pagination, SkeletonList } from '../../components/ui';
import { useDebounced, useLoad, useTitle } from '../../hooks';
import { fmtDateTime } from '../../lib/format';
import { ROLES, type ListMeta, type PublicUser, type Role } from '../../types';

const LIMIT = 25;
type Dialog =
  | { kind: 'create' }
  | { kind: 'roles'; user: PublicUser }
  | { kind: 'status'; user: PublicUser; to: 'ACTIVE' | 'DEACTIVATED' }
  | { kind: 'reset'; user: PublicUser }
  | { kind: 'revoke'; user: PublicUser }
  | { kind: 'password'; email: string; password: string; title: string };

export function AdminUsersPage() {
  useTitle('Users');
  const { can, user: me } = useAuth();
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [offset, setOffset] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const list = useLoad(async () => {
    const r = await api.get<PublicUser[]>('/users', { search: q, status, role, limit: LIMIT, offset });
    return { rows: r.data, meta: r.meta as ListMeta };
  }, [q, status, role, offset]);

  return (
    <>
      <PageHeader title="Users" description="Invite colleagues and manage their roles and access.">{can('users:manage') && <button className="btn primary" onClick={() => setDialog({ kind: 'create' })}><Plus className="size-4" />Add user</button>}</PageHeader>
      <div className="card !p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_repeat(2,minmax(0,1fr))]">
          <label className="field"><span className="sr-only">Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input className="!pl-9" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} placeholder="Search by name or email…" aria-label="Search" />
            </span>
          </label>
          <label className="field"><span className="sr-only">Status</span><select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}><option value="">Any status</option><option value="INVITED">Invited</option><option value="ACTIVE">Active</option><option value="DEACTIVATED">Deactivated</option></select></label>
          <label className="field"><span className="sr-only">Role</span><select aria-label="Role" value={role} onChange={(e) => { setRole(e.target.value); setOffset(0); }}><option value="">Any role</option>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></label>
        </div>
      </div>

      {list.loading && !list.data && <SkeletonList rows={6} />}
      {list.error != null && <ErrorBanner error={list.error} onRetry={list.reload} />}
      {list.data && list.data.rows.length === 0 && <Empty icon={Users} title="No users found">No users match the current filters.</Empty>}
      {list.data && list.data.rows.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
              <tbody>
                {list.data.rows.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary">{u.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}</span>
                        <span className="font-medium">{u.name}</span>{u.id === me?.id && <Badge>you</Badge>}
                      </div>
                    </td>
                    <td className="muted">{u.email}</td>
                    <td><div className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r} tone="info">{r.replace('_', ' ')}</Badge>)}</div></td>
                    <td><Badge tone={u.status === 'ACTIVE' ? 'ok' : u.status === 'INVITED' ? 'info' : 'bad'}>{u.status}</Badge></td>
                    <td className="muted whitespace-nowrap">{fmtDateTime(u.lastLoginAt)}</td>
                    <td className="actions">
                      <ActionMenu
                        label={`Actions for ${u.name}`}
                        actions={[
                          { label: 'Change roles', icon: ShieldCheck, hidden: !can('users:roles'), onSelect: () => setDialog({ kind: 'roles', user: u }) },
                          { label: 'Reset password', icon: KeyRound, hidden: !(can('users:manage') && u.id !== me?.id && u.status !== 'DEACTIVATED'), onSelect: () => setDialog({ kind: 'reset', user: u }) },
                          { label: 'Sign out everywhere', icon: LogOut, hidden: !(can('users:manage') && u.id !== me?.id && u.status !== 'DEACTIVATED'), onSelect: () => setDialog({ kind: 'revoke', user: u }) },
                          { label: 'Reactivate', icon: UserCheck, hidden: !(can('users:manage') && u.id !== me?.id && u.status === 'DEACTIVATED'), onSelect: () => setDialog({ kind: 'status', user: u, to: 'ACTIVE' }) },
                          { label: 'Deactivate', icon: UserX, danger: true, hidden: !(can('users:manage') && u.id !== me?.id && u.status !== 'DEACTIVATED'), onSelect: () => setDialog({ kind: 'status', user: u, to: 'DEACTIVATED' }) },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div><Pagination total={list.data.meta.total} limit={LIMIT} offset={offset} onChange={setOffset} /></div>
        </>
      )}

      {dialog?.kind === 'create' && (
        <CreateUser onClose={() => setDialog(null)} onCreated={(email, password) => { list.reload(); setDialog({ kind: 'password', email, password, title: 'User created' }); }} />
      )}
      {dialog?.kind === 'roles' && <RolesDialog user={dialog.user} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); toast.success('Roles updated'); list.reload(); }} />}
      {dialog?.kind === 'status' && (
        <ConfirmDialog
          title={dialog.to === 'DEACTIVATED' ? `Deactivate ${dialog.user.name}?` : `Reactivate ${dialog.user.name}?`}
          message={dialog.to === 'DEACTIVATED' ? 'They are signed out everywhere immediately and cannot sign in again until reactivated.' : 'They can sign in again with their current password.'}
          confirmLabel={dialog.to === 'DEACTIVATED' ? 'Deactivate' : 'Reactivate'}
          danger={dialog.to === 'DEACTIVATED'}
          onClose={() => setDialog(null)}
          onConfirm={async () => { await api.patch(`/users/${dialog.user.id}/status`, { status: dialog.to }); toast.success('User updated'); list.reload(); }}
        />
      )}
      {dialog?.kind === 'reset' && (
        <ConfirmDialog
          title={`Reset password for ${dialog.user.name}?`}
          message="A new one-time password is created and shown to you once. All of their sessions end now."
          confirmLabel="Reset password"
          closeOnSuccess={false}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const r = await api.post<{ temporaryPassword: string }>(`/users/${dialog.user.id}/reset-password`);
            list.reload();
            setDialog({ kind: 'password', email: dialog.user.email, password: r.data.temporaryPassword, title: 'Password reset' });
          }}
        />
      )}
      {dialog?.kind === 'revoke' && (
        <ConfirmDialog title={`Sign ${dialog.user.name} out everywhere?`} message="All of their sessions end immediately." confirmLabel="Sign out" onClose={() => setDialog(null)} onConfirm={async () => { await api.post(`/users/${dialog.user.id}/revoke-sessions`); toast.success('Sessions ended'); }} />
      )}
      {dialog?.kind === 'password' && <TempPassword email={dialog.email} password={dialog.password} title={dialog.title} onClose={() => setDialog(null)} />}
    </>
  );
}

function CreateUser({ onClose, onCreated }: { onClose: () => void; onCreated: (email: string, password: string) => void }) {
  const { user: me } = useAuth();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('SENDER');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allowed = ROLES.filter((r) => me?.roles.includes('SUPER_ADMIN') || r !== 'SUPER_ADMIN');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const r = await api.post<{ user: PublicUser; temporaryPassword: string }>('/users', { email: email.trim(), name: name.trim(), role });
      onCreated(r.data.user.email, r.data.temporaryPassword);
    } catch (ex) {
      setErrors(fieldErrors(ex));
      setError(errorMessage(ex));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add user" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <ErrorBanner message={error} />}
        <Field label="Full name" required error={errors.name}><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus /></Field>
        <Field label="Company email" required error={errors.email}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Role" required error={errors.role}><select value={role} onChange={(e) => setRole(e.target.value as Role)}>{allowed.map((r) => <option key={r}>{r}</option>)}</select></Field>
        <p className="muted">A one-time password is generated and shown once. The person must change it at first sign-in.</p>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !email || !name}>{busy ? 'Creating…' : 'Create user'}</button></div>
      </form>
    </Modal>
  );
}

function RolesDialog({ user, onClose, onSaved }: { user: PublicUser; onClose: () => void; onSaved: () => void }) {
  const [roles, setRoles] = useState<Role[]>(user.roles);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Roles for ${user.name}`} onClose={onClose}>
      <div className="stack">
        {error && <ErrorBanner message={error} />}
        <fieldset>
          <legend>Roles</legend>
          {ROLES.map((r) => (
            <label className="check" key={r}>
              <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />
              <span>{r}</span>
            </label>
          ))}
        </fieldset>
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={busy || roles.length === 0}
            onClick={async () => {
              setBusy(true);
              try {
                await api.put(`/users/${user.id}/roles`, { roles });
                onSaved();
              } catch (e) {
                setError(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            Save roles
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TempPassword({ email, password, title, onClose }: { email: string; password: string; title: string; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack gap-4">
        <InfoBanner kind="warn">
          This temporary password is displayed only once and cannot be retrieved later. Send it to the user over a secure channel. They will be required to change it on their first sign-in.
        </InfoBanner>
        <div>
          <p className="text-xs text-muted-foreground mb-1.5">One-time temporary credential for <strong>{email}</strong>:</p>
          <div className="flex items-center justify-between gap-3 rounded-xl border-2 border-primary/30 bg-primary-soft/30 p-3.5 font-mono text-base font-semibold tracking-wider text-foreground select-all">
            <span className="tabular-nums break-all">{password}</span>
            <CopyButton text={password} label="Copy password" />
          </div>
        </div>
        <div className="row end pt-2">
          <button className="btn primary" onClick={onClose}>I have saved this password</button>
        </div>
      </div>
    </Modal>
  );
}
