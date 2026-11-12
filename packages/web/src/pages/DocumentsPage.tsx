import { FilePlus2, FileText, LayoutGrid, List, Search, Send, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Badge, Empty, ErrorBanner, PageHeader, Pagination, SkeletonList } from '../components/ui';
import { useDebounced, useLoad, useTitle } from '../hooks';
import { fmtDateTime } from '../lib/format';
import type { DocumentListItem, DocumentTypeDto, ListMeta, TagDto } from '../types';

const LIMIT = 20;

export function DocumentsPage() {
  useTitle('Documents');
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [view, setView] = useState<'table' | 'grid'>('table');
  const debounced = useDebounced(search);
  const typeId = params.get('typeId') ?? '';
  const tagId = params.get('tagId') ?? '';
  const active = params.get('active') ?? '';
  const archive = params.get('archive') ?? '';
  const offset = Number(params.get('offset') ?? 0) || 0;

  const types = useLoad(async () => (await api.get<DocumentTypeDto[]>('/document-types')).data, []);
  const tags = useLoad(async () => (await api.get<TagDto[]>('/tags')).data, []);

  useEffect(() => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (debounced) n.set('search', debounced);
      else n.delete('search');
      if ((n.get('search') ?? '') !== (p.get('search') ?? '')) n.delete('offset');
      return n;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const list = useLoad(
    async () => {
      const r = await api.get<DocumentListItem[]>('/documents', { search: debounced, typeId, tagId, active, archive, limit: LIMIT, offset });
      return { rows: r.data, meta: r.meta as ListMeta };
    },
    [debounced, typeId, tagId, active, archive, offset]
  );

  const setParam = (k: string, v: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (v) n.set(k, v);
      else n.delete(k);
      n.delete('offset');
      return n;
    });

  const chips = [
    typeId && { k: 'typeId', label: `Type: ${types.data?.find((t) => t.id === typeId)?.name ?? '…'}` },
    tagId && { k: 'tagId', label: `Tag: ${tags.data?.find((t) => t.id === tagId)?.name ?? '…'}` },
    active && { k: 'active', label: active === 'true' ? 'Active only' : 'Inactive only' },
    archive && { k: 'archive', label: `Archive: ${archive.toLowerCase().replace('_', ' ')}` },
  ].filter(Boolean) as { k: string; label: string }[];

  return (
    <>
      <PageHeader title="Documents" description="Search, filter and open any document you have access to.">
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border bg-card p-0.5 shadow-xs">
            <button
              type="button"
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                view === 'table' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setView('table')}
              aria-label="Table view"
            >
              <List className="inline mr-1 size-3.5" />
              Table
            </button>
            <button
              type="button"
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                view === 'grid' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setView('grid')}
              aria-label="Grid view"
            >
              <LayoutGrid className="inline mr-1 size-3.5" />
              Grid
            </button>
          </div>
          {can('documents:manage') && <Link className="btn primary" to="/documents/new"><FilePlus2 className="size-4" />Upload document</Link>}
        </div>
      </PageHeader>

      <form className="card !p-4" role="search" onSubmit={(e) => e.preventDefault()}>
        <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_repeat(2,minmax(0,1fr))]">
          <label className="field"><span className="sr-only">Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input className="!pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, description, tag or field…" aria-label="Search" />
            </span>
          </label>
          <label className="field"><span className="sr-only">Type</span>
            <select value={typeId} onChange={(e) => setParam('typeId', e.target.value)} aria-label="Type">
              <option value="">All types</option>
              {types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isActive ? '' : ' (inactive)'}</option>)}
            </select>
          </label>
          <label className="field"><span className="sr-only">Tag</span>
            <select value={tagId} onChange={(e) => setParam('tagId', e.target.value)} aria-label="Tag">
              <option value="">Any tag</option>
              {tags.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          {can('documents:manage') && (
            <>
              <label className="field"><span className="sr-only">Status</span>
                <select value={active} onChange={(e) => setParam('active', e.target.value)} aria-label="Status">
                  <option value="">Active and inactive</option><option value="true">Active only</option><option value="false">Inactive only</option>
                </select>
              </label>
              <label className="field"><span className="sr-only">Archive</span>
                <select value={archive} onChange={(e) => setParam('archive', e.target.value)} aria-label="Archive">
                  <option value="">Any archive state</option><option value="LIVE">Live</option><option value="ARCHIVED">Archived</option><option value="LEGAL_HOLD">Legal hold</option>
                </select>
              </label>
            </>
          )}
        </div>
        {chips.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {chips.map((c) => (
              <span className="chip" key={c.k}>{c.label}<button type="button" aria-label={`Remove filter ${c.label}`} onClick={() => setParam(c.k, '')}><X className="size-3" /></button></span>
            ))}
            <button type="button" className="btn link text-xs" onClick={() => setParams(new URLSearchParams(search ? { search } : {}))}>Clear all</button>
          </div>
        )}
      </form>

      {list.loading && !list.data && <SkeletonList rows={6} />}
      {list.error != null && <ErrorBanner error={list.error} onRetry={list.reload} />}
      {list.data && list.data.rows.length === 0 && (
        <Empty icon={FileText} title="No documents found" action={can('documents:manage') ? <Link className="btn primary" to="/documents/new">Upload a document</Link> : undefined}>
          Nothing matches the current search and filters. Try clearing them.
        </Empty>
      )}
      {list.data && list.data.rows.length > 0 && (
        <>
          {view === 'table' ? (
            <div className="table-wrap" aria-busy={list.loading}>
              <table>
                <thead><tr><th>Name</th><th>Type</th><th>Version</th><th>Tags</th><th>Status</th><th>Updated</th></tr></thead>
                <tbody>
                  {list.data.rows.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link to={`/documents/${d.id}`} className="flex items-center gap-3 font-medium text-foreground no-underline hover:text-primary">
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"><FileText className="size-4" aria-hidden="true" /></span>
                          <span className="max-w-[320px] truncate">{d.name}</span>
                        </Link>
                      </td>
                      <td className="muted">{d.typeName}</td>
                      <td className="whitespace-nowrap">{d.currentVersionNumber ? <span className="mono !text-[12px]">v{d.currentVersionNumber}</span> : <span className="muted">—</span>}</td>
                      <td>{d.tags.length ? d.tags.map((t) => <span className="tag" key={t.id}>{t.name}</span>) : <span className="muted">—</span>}</td>
                      <td className="whitespace-nowrap">
                        <div className="flex gap-1.5">
                          <Badge tone={d.isActive ? 'ok' : 'neutral'}>{d.isActive ? 'Active' : 'Inactive'}</Badge>
                          {d.archiveStatus !== 'LIVE' && <Badge tone="warn">{d.archiveStatus === 'ARCHIVED' ? 'Archived' : 'Legal hold'}</Badge>}
                        </div>
                      </td>
                      <td className="muted whitespace-nowrap">{fmtDateTime(d.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy={list.loading}>
              {list.data.rows.map((d) => (
                <div key={d.id} className="card mb-0 flex flex-col justify-between transition-colors hover:border-primary/40">
                  <div>
                    <div className="mb-2.5 flex items-start justify-between gap-2">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
                        <FileText className="size-4" aria-hidden="true" />
                      </span>
                      <div className="flex flex-wrap justify-end gap-1">
                        <Badge tone={d.isActive ? 'ok' : 'neutral'}>{d.isActive ? 'Active' : 'Inactive'}</Badge>
                        {d.archiveStatus !== 'LIVE' && <Badge tone="warn">{d.archiveStatus === 'ARCHIVED' ? 'Archived' : 'Legal hold'}</Badge>}
                      </div>
                    </div>
                    <Link to={`/documents/${d.id}`} className="mb-1 block font-semibold text-foreground no-underline hover:text-primary">
                      {d.name}
                    </Link>
                    <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{d.typeName}</span>
                      {d.currentVersionNumber && (
                        <>
                          <span>•</span>
                          <span className="mono">v{d.currentVersionNumber}</span>
                        </>
                      )}
                    </div>
                    {d.tags.length > 0 && (
                      <div className="mb-3 flex flex-wrap gap-1">
                        {d.tags.map((t) => <span key={t.id} className="tag !text-[11px]">{t.name}</span>)}
                      </div>
                    )}
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                    <span>{fmtDateTime(d.updatedAt)}</span>
                    <div className="flex items-center gap-1.5">
                      <Link to={`/documents/${d.id}`} className="btn small">View</Link>
                      {d.isActive && can('email:send') && (
                        <Link to={`/send?documentId=${d.id}`} className="btn small primary">Send</Link>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <Pagination total={list.data.meta.total} limit={LIMIT} offset={offset} onChange={(o) => setParams((p) => { const n = new URLSearchParams(p); n.set('offset', String(o)); return n; })} />
        </>
      )}
    </>
  );
}
