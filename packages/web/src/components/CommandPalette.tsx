import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Search, Send, FilePlus2, ScrollText, Users, History, FileType2, Sun, Moon, ArrowRight } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useTheme } from '../lib/theme';
import type { DocumentListItem } from '../types';

interface ActionItem {
  id: string;
  title: string;
  category: string;
  icon: typeof FileText;
  onSelect: () => void;
  permission?: string;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const { can } = useAuth();
  const { toggle, resolved } = useTheme();

  const actions: ActionItem[] = [
    {
      id: 'upload',
      title: 'Upload new document',
      category: 'Actions',
      icon: FilePlus2,
      onSelect: () => { onClose(); nav('/documents/new'); },
      permission: 'documents:manage',
    },
    {
      id: 'send',
      title: 'Send documents via Gmail',
      category: 'Actions',
      icon: Send,
      onSelect: () => { onClose(); nav('/send'); },
      permission: 'email:send',
    },
    {
      id: 'sent-history',
      title: 'View sent history',
      category: 'Navigation',
      icon: History,
      onSelect: () => { onClose(); nav('/sent'); },
      permission: 'email:read_own',
    },
    {
      id: 'doc-types',
      title: 'Manage document types',
      category: 'Administration',
      icon: FileType2,
      onSelect: () => { onClose(); nav('/admin/document-types'); },
      permission: 'doc_types:manage',
    },
    {
      id: 'users',
      title: 'Manage users and roles',
      category: 'Administration',
      icon: Users,
      onSelect: () => { onClose(); nav('/admin/users'); },
      permission: 'users:read',
    },
    {
      id: 'audit',
      title: 'Inspect audit trail',
      category: 'Administration',
      icon: ScrollText,
      onSelect: () => { onClose(); nav('/admin/audit'); },
      permission: 'audit:read',
    },
    {
      id: 'theme',
      title: `Toggle theme (current: ${resolved})`,
      category: 'Preferences',
      icon: resolved === 'dark' ? Sun : Moon,
      onSelect: () => { toggle(); onClose(); },
    },
  ].filter((a) => !a.permission || can(a.permission as any));

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!query.trim() || !can('documents:read')) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.get<DocumentListItem[]>('/documents', { search: query.trim(), limit: 6 });
        setResults(res.data);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [query, can]);

  const filteredActions = query.trim()
    ? actions.filter((a) => a.title.toLowerCase().includes(query.toLowerCase()) || a.category.toLowerCase().includes(query.toLowerCase()))
    : actions;

  const allItems = [
    ...results.map((d) => ({
      type: 'document' as const,
      id: d.id,
      title: d.name,
      subtitle: `${d.typeName} ${d.currentVersionNumber ? `· v${d.currentVersionNumber}` : ''}`,
      active: d.isActive,
      onSelect: () => { onClose(); nav(`/documents/${d.id}`); },
    })),
    ...filteredActions.map((a) => ({
      type: 'action' as const,
      id: a.id,
      title: a.title,
      subtitle: a.category,
      icon: a.icon,
      onSelect: a.onSelect,
    })),
  ];

  const handleKeyNav = (e: React.KeyboardEvent) => {
    if (allItems.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((idx) => (idx + 1) % allItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((idx) => (idx - 1 + allItems.length) % allItems.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (allItems[selectedIndex]) {
        allItems[selectedIndex].onSelect();
      }
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 md:p-20" role="dialog" aria-modal="true">
      <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm transition-opacity" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card shadow-pop">
        <div className="flex items-center border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyNav}
            placeholder="Type a document name, tag, or action..."
            className="w-full border-0 bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          {loading && <span className="text-xs text-muted-foreground">Searching…</span>}
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">ESC</kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-2">
          {results.length > 0 && (
            <div className="mb-2 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Documents
            </div>
          )}
          {results.map((d, idx) => {
            const isSelected = selectedIndex === idx;
            return (
              <div
                key={d.id}
                onClick={() => { onClose(); nav(`/documents/${d.id}`); }}
                onMouseEnter={() => setSelectedIndex(idx)}
                className={`flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm ${
                  isSelected ? 'bg-primary-soft text-foreground' : 'text-foreground hover:bg-muted'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded bg-muted text-muted-foreground">
                    <FileText className="size-3.5" />
                  </span>
                  <div>
                    <span className="font-medium">{d.name}</span>
                    <span className="muted ml-2 text-xs">{d.typeName}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {d.isActive ? (
                    <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">Active</span>
                  ) : (
                    <span className="rounded bg-slate-500/10 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">Inactive</span>
                  )}
                  {d.currentVersionNumber && (
                    <span className="mono rounded bg-muted px-1.5 py-0.5 text-[11px]">v{d.currentVersionNumber}</span>
                  )}
                </div>
              </div>
            );
          })}

          {filteredActions.length > 0 && (
            <div className="mt-2 mb-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Quick Actions
            </div>
          )}
          {filteredActions.map((a, aIdx) => {
            const itemIdx = results.length + aIdx;
            const isSelected = selectedIndex === itemIdx;
            const Icon = a.icon;
            return (
              <div
                key={a.id}
                onClick={a.onSelect}
                onMouseEnter={() => setSelectedIndex(itemIdx)}
                className={`flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm ${
                  isSelected ? 'bg-primary-soft text-foreground' : 'text-foreground hover:bg-muted'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded bg-muted text-muted-foreground">
                    <Icon className="size-3.5" />
                  </span>
                  <span className="font-medium">{a.title}</span>
                </div>
                <span className="muted text-xs">{a.category}</span>
              </div>
            );
          })}

          {allItems.length === 0 && !loading && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No matching documents or actions.
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
          <span>Navigate with <kbd className="rounded border border-border bg-card px-1">↑</kbd> <kbd className="rounded border border-border bg-card px-1">↓</kbd></span>
          <span>Select with <kbd className="rounded border border-border bg-card px-1">↵</kbd></span>
        </div>
      </div>
    </div>
  );
}

