import {
  ChevronRight, FilePlus2, FileText, FileType2, History, LayoutDashboard, Lock, LogOut, Mail, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen,
  ScrollText, Search, Send, Sun, Tags, User, Users, X, ShieldCheck, Keyboard, type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Logo } from './components/Logo';
import { CommandPalette } from './components/CommandPalette';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Avatar, Dropdown, Empty, Spinner, Tooltip, cn } from './components/ui';
import { AnimatePresence, PageFade, motion } from './components/Motion';
import { useTheme } from './lib/theme';
import type { Permission } from './types';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { DashboardPage } from './pages/DashboardPage';
import { DocumentDetailPage } from './pages/DocumentDetailPage';
import { DocumentNewPage } from './pages/DocumentNewPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { GmailSettingsPage } from './pages/GmailSettingsPage';
import { LoginPage } from './pages/LoginPage';
import { SendPage } from './pages/SendPage';
import { SentDetailPage, SentListPage } from './pages/SentPages';
import { AccountSettingsPage } from './pages/AccountSettingsPage';
import { AdminAuditPage } from './pages/admin/AdminAuditPage';
import { AdminDocumentTypesPage, DocumentTypeBuilderPage } from './pages/admin/DocumentTypesPages';
import { AdminTagsPage } from './pages/admin/AdminTagsPage';
import { AdminTemplatesPage } from './pages/admin/AdminTemplatesPage';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';

function RequireAuth() {
  const { status, user } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <div className="grid min-h-screen place-items-center"><Spinner label="Signing you in…" /></div>;
  if (status === 'anon' || !user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (user.mustChangePassword && loc.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  return <Outlet />;
}

/** Hides a route the user has no permission for; the API enforces the same rule independently. */
function Guard({ perm, anyOf, children }: { perm?: Permission; anyOf?: Permission[]; children: ReactNode }) {
  const { can, canAny } = useAuth();
  const ok = perm ? can(perm) : anyOf ? canAny(...anyOf) : true;
  if (!ok) {
    return (
      <div role="alert">
        <Empty icon={Lock} title="No access" action={<Link className="btn primary" to="/">Back to the dashboard</Link>}>
          Your role does not include this area. If you think you need it, ask an administrator.
        </Empty>
      </div>
    );
  }
  return <>{children}</>;
}

const CRUMBS: Record<string, string> = {
  documents: 'Documents', new: 'Upload', send: 'Send documents', sent: 'Sent history', settings: 'Settings', gmail: 'Gmail connection', account: 'My account',
  admin: 'Administration', users: 'Users', 'document-types': 'Document types', tags: 'Tags', templates: 'Email templates', audit: 'Audit log',
};

function Breadcrumbs() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  const crumbs = [{ label: 'Home', to: '/' }];
  let acc = '';
  for (const p of parts) {
    acc += `/${p}`;
    crumbs.push({ label: CRUMBS[p] ?? (/^[0-9a-f-]{20,}$/i.test(p) ? 'Details' : p), to: acc });
  }
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 text-sm sm:flex">
      {crumbs.map((c, i) => (
        <span key={c.to} className="flex min-w-0 items-center gap-1">
          {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />}
          {i === crumbs.length - 1 ? <span className="truncate font-medium" aria-current="page">{c.label}</span> : <Link to={c.to} className="muted truncate no-underline hover:text-foreground">{c.label}</Link>}
        </span>
      ))}
    </nav>
  );
}

function ThemeMenuItems() {
  const { choice, setChoice } = useTheme();
  const opts: { id: 'light' | 'dark' | 'system'; label: string; icon: LucideIcon }[] = [
    { id: 'light', label: 'Light', icon: Sun }, { id: 'dark', label: 'Dark', icon: Moon }, { id: 'system', label: 'System', icon: Monitor },
  ];
  return (
    <>
      {opts.map((o) => (
        <Dropdown.Item key={o.id} className={cn('menu-item', choice === o.id && 'font-semibold text-primary')} onSelect={() => setChoice(o.id)}>
          <o.icon className="size-4" aria-hidden="true" />{o.label}
        </Dropdown.Item>
      ))}
    </>
  );
}

function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const initials = (user?.name ?? '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button className="user-card" aria-label="Account menu">
          <span className="rounded-full p-[2px]" style={{ background: 'linear-gradient(135deg,#ffc450,#f2703f)' }}><Avatar name={user?.name ?? initials} size={32} /></span>
          <span className={cn('min-w-0 flex-1 nav-label', collapsed && 'lg:hidden')}>
            <span className="block truncate text-sm font-semibold text-white">{user?.name}</span>
            <span className="mt-0.5 inline-flex rounded-full px-2 py-px text-[10px] font-semibold" style={{ background: 'rgb(245 165 36 / .18)', color: '#ffd28a' }}>{user?.roles.join(', ').replace(/_/g, ' ').toLowerCase()}</span>
          </span>
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu" side="top" align="start" sideOffset={8}>
          <div className="px-2.5 py-2 text-xs text-muted-foreground">{user?.email}</div>
          <Dropdown.Separator className="my-1 h-px bg-border" />
          <Dropdown.Item className="menu-item" onSelect={() => nav('/settings/account')}><User className="size-4" />My account</Dropdown.Item>
          <Dropdown.Label className="px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Theme</Dropdown.Label>
          <ThemeMenuItems />
          <Dropdown.Separator className="my-1 h-px bg-border" />
          <Dropdown.Item className="menu-item danger" onSelect={async () => { await logout(); nav('/login'); }}><LogOut className="size-4" />Sign out</Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function Layout() {
  const { can, canAny } = useAuth();
  const [open, setOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [gPending, setGPending] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('dcs-sidebar') === 'collapsed'; } catch { return false; }
  });
  const { toggle, resolved } = useTheme();
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    try { localStorage.setItem('dcs-sidebar', collapsed ? 'collapsed' : 'open'); } catch { /* ignore */ }
  }, [collapsed]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onKey = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInput =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        (activeEl as HTMLElement)?.isContentEditable;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((o) => !o);
        return;
      }

      if (isInput) return;

      if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }

      if (e.key.toLowerCase() === 't' && !e.metaKey && !e.ctrlKey && !gPending) {
        e.preventDefault();
        toggle();
        return;
      }

      if (e.key.toLowerCase() === 'g' && !e.metaKey && !e.ctrlKey) {
        setGPending(true);
        clearTimeout(timer);
        timer = setTimeout(() => setGPending(false), 1200);
        return;
      }

      if (gPending) {
        setGPending(false);
        const k = e.key.toLowerCase();
        if (k === 'h') { e.preventDefault(); nav('/'); }
        else if (k === 'd' && can('documents:read')) { e.preventDefault(); nav('/documents'); }
        else if (k === 's' && can('email:send')) { e.preventDefault(); nav('/send'); }
        else if (k === 'a' && can('audit:read')) { e.preventDefault(); nav('/admin/audit'); }
        else if (k === 'u' && can('users:read')) { e.preventDefault(); nav('/admin/users'); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, [gPending, toggle, nav, can]);

  const link = (to: string, label: string, Icon: LucideIcon, end = false) => (
    <NavLink to={to} end={end} className={({ isActive }) => cn('nav', isActive && 'active')} title={collapsed ? label : undefined}>
      <Icon className="size-[18px] shrink-0" aria-hidden="true" /><span className="nav-label">{label}</span>
    </NavLink>
  );
  const admin = canAny('users:read', 'doc_types:manage', 'templates:manage', 'audit:read', 'documents:manage');
  const appConfig = (typeof window !== 'undefined' && (window as any).__APP_CONFIG__) || {};
  const companyName = appConfig.companyName || (import.meta as any).env.VITE_COMPANY_NAME || (import.meta as any).env.APP_COMPANY_NAME || 'DeCircle Solar';

  return (
    <>
      <a href="#main" className="skip-link">Skip to content</a>
      <div className={cn('shell', collapsed && 'collapsed')}>
        {open && <div className="fixed inset-0 z-30 bg-slate-950/50 lg:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}
        <aside id="sidebar" className={cn('sidebar', open && 'open')} aria-label="Main">
          <div className="flex h-16 items-center gap-3 px-4" style={{ borderBottom: '1px solid rgb(255 255 255 / .07)' }}>
            <span className="grid size-10 place-items-center rounded-xl bg-white shadow-lg"><Logo size={28} /></span>
            <span className="brand-text leading-tight"><span className="font-display block text-[15px] font-semibold tracking-tight text-white">{companyName}</span><span className="block text-[11px]" style={{ color: '#8ea0bd' }}>Documents</span></span>
            <button className="btn ghost icon small ml-auto lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu"><X className="size-4" /></button>
          </div>
          <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Primary">
            {link('/', 'Dashboard', LayoutDashboard, true)}
            {can('documents:read') && link('/documents', 'Documents', FileText, true)}
            {can('email:send') && link('/send', 'Send documents', Send)}
            {can('email:read_own') && link('/sent', 'Sent history', History)}
            {admin && <div className="nav-group">Administration</div>}
            {can('documents:manage') && link('/documents/new', 'Upload document', FilePlus2)}
            {can('doc_types:manage') && link('/admin/document-types', 'Document types', FileType2)}
            {can('documents:manage') && link('/admin/tags', 'Tags', Tags)}
            {can('templates:manage') && link('/admin/templates', 'Email templates', Mail)}
            {can('users:read') && link('/admin/users', 'Users', Users)}
            {can('audit:read') && link('/admin/audit', 'Audit log', ScrollText)}
            <div className="nav-group">Account</div>
            {can('email:connect') && link('/settings/gmail', 'Gmail connection', Mail)}
            {link('/settings/account', 'My account', User)}
          </nav>
          <div className="sidebar-foot mx-3 mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-[11px]" style={{ background: 'rgb(16 185 129 / .10)', color: '#7be0b6', border: '1px solid rgb(16 185 129 / .2)' }}>
            <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" /><span>Confidential · encrypted · audited</span>
          </div>
          <div className="p-3 pt-0"><UserMenu collapsed={collapsed} /></div>
        </aside>

        <div className="shell-main">
          <header className="topbar">
            <button className="btn ghost icon lg:hidden" onClick={() => setOpen(true)} aria-expanded={open} aria-controls="sidebar" aria-label="Open menu"><Menu className="size-5" /></button>
            <Tooltip text={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
              <button className="btn ghost icon hidden lg:inline-flex" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
                {collapsed ? <PanelLeftOpen className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}
              </button>
            </Tooltip>
            <Breadcrumbs />
            <div className="ml-auto flex items-center gap-2">
              {can('documents:read') && (
                <button
                  type="button"
                  onClick={() => setCmdOpen(true)}
                  className="flex h-9 w-52 md:w-64 items-center justify-between rounded-lg border border-border bg-card px-3 text-xs text-muted-foreground shadow-xs transition-colors hover:border-primary/40 hover:text-foreground"
                  aria-label="Quick jump or search (Ctrl+K)"
                >
                  <span className="flex items-center gap-2">
                    <Search className="size-3.5" aria-hidden="true" />
                    <span>Search or jump to…</span>
                  </span>
                  <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold">⌘K</kbd>
                </button>
              )}
              <Tooltip text="Keyboard shortcuts (?)">
                <button className="btn ghost icon" onClick={() => setShortcutsOpen(true)} aria-label="Keyboard shortcuts (?)">
                  <Keyboard className="size-[18px]" />
                </button>
              </Tooltip>
              <Tooltip text={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
                <button className="btn ghost icon overflow-hidden" onClick={toggle} aria-label="Toggle theme">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span key={resolved} initial={{ rotate: -80, opacity: 0, scale: 0.6 }} animate={{ rotate: 0, opacity: 1, scale: 1 }} exit={{ rotate: 80, opacity: 0, scale: 0.6 }} transition={{ duration: 0.18 }} className="grid place-items-center">
                      {resolved === 'dark' ? <Sun className="size-[18px] text-sun" /> : <Moon className="size-[18px]" />}
                    </motion.span>
                  </AnimatePresence>
                </button>
              </Tooltip>
            </div>
          </header>
          <main id="main" className="main" tabIndex={-1}>
            <ErrorBoundary>
              <PageFade id={loc.pathname}>
                <Outlet />
              </PageFade>
            </ErrorBoundary>
          </main>
        </div>
      </div>
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
      <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="documents" element={<Guard perm="documents:read"><DocumentsPage /></Guard>} />
          <Route path="documents/new" element={<Guard perm="documents:manage"><DocumentNewPage /></Guard>} />
          <Route path="documents/:id" element={<Guard perm="documents:read"><DocumentDetailPage /></Guard>} />
          <Route path="send" element={<Guard perm="email:send"><SendPage /></Guard>} />
          <Route path="sent" element={<Guard perm="email:read_own"><SentListPage /></Guard>} />
          <Route path="sent/:id" element={<Guard perm="email:read_own"><SentDetailPage /></Guard>} />
          <Route path="settings/gmail" element={<Guard perm="email:connect"><GmailSettingsPage /></Guard>} />
          <Route path="settings/account" element={<AccountSettingsPage />} />
          <Route path="admin/users" element={<Guard perm="users:read"><AdminUsersPage /></Guard>} />
          <Route path="admin/document-types" element={<Guard perm="doc_types:manage"><AdminDocumentTypesPage /></Guard>} />
          <Route path="admin/document-types/:id" element={<Guard perm="doc_types:manage"><DocumentTypeBuilderPage /></Guard>} />
          <Route path="admin/tags" element={<Guard perm="documents:manage"><AdminTagsPage /></Guard>} />
          <Route path="admin/templates" element={<Guard perm="templates:manage"><AdminTemplatesPage /></Guard>} />
          <Route path="admin/audit" element={<Guard perm="audit:read"><AdminAuditPage /></Guard>} />
          <Route path="*" element={<Empty icon={FileText} title="Page not found" action={<Link className="btn primary" to="/">Back to the dashboard</Link>}>The page you are looking for does not exist.</Empty>} />
        </Route>
      </Route>
    </Routes>
  );
}
