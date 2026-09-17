import { useState, useEffect, useMemo } from 'react';
import { bulkSetStatus } from '@/api/client';
import { AssetDetail } from '@/features/assets/AssetDetail';
import { AssetGrid } from '@/features/assets/AssetGrid';
import { useAssets } from '@/features/assets/useAssets';
import { statusLabel } from '@/lib/format';
import { useDebounce } from '@/lib/useDebounce';
import type { Asset, AssetStatus, AssetQuery } from '@/lib/types';

const STATUSES: AssetStatus[] = ['draft', 'in_review', 'approved', 'archived'];
const SORTS: Array<{ value: NonNullable<AssetQuery['sort']>; label: string }> = [
  { value: 'updatedAt:desc', label: 'Recently updated' },
  { value: 'name:asc', label: 'Name A–Z' },
  { value: 'sizeBytes:desc', label: 'Largest first' },
  { value: 'createdAt:desc', label: 'Newest' },
];

/**
 * Parses query parameters from window.location.search into typed state.
 */
function getInitialParams(): {
  q: string;
  status: AssetStatus[];
  sort: NonNullable<AssetQuery['sort']>;
} {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('q') ?? '';

  const rawStatus = params.get('status');
  const status = rawStatus
    ? (rawStatus.split(',').filter((s): s is AssetStatus => STATUSES.includes(s as AssetStatus)))
    : [];

  const rawSort = params.get('sort');
  const sort = SORTS.some((s) => s.value === rawSort)
    ? (rawSort as NonNullable<AssetQuery['sort']>)
    : 'updatedAt:desc';

  return { q, status, sort };
}

export function App() {
  const initialParams = useMemo(() => getInitialParams(), []);

  // UI search term updates synchronously with every keystroke
  const [q, setQ] = useState(initialParams.q);
  const [status, setStatus] = useState<AssetStatus[]>(initialParams.status);
  const [sort, setSort] = useState<NonNullable<AssetQuery['sort']>>(initialParams.sort);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Debounce search query to eliminate keystroke storms and 429 rate limits
  const debouncedQ = useDebounce(q, 300);

  // Data fetching hook with cancellation, race-condition guard, and cursor invalidation
  const { items, total, loading, error, refetch } = useAssets({
    q: debouncedQ,
    status,
    sort,
    limit: 24,
  });

  // Synchronize state with URL parameters (URLSearchParams)
  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQ.trim()) params.set('q', debouncedQ.trim());
    if (status.length > 0) params.set('status', status.join(','));
    if (sort !== 'updatedAt:desc') params.set('sort', sort);

    const queryString = params.toString();
    const newRelativePathQuery = queryString
      ? `${window.location.pathname}?${queryString}`
      : window.location.pathname;

    const currentSearch = window.location.search.replace(/^\?/, '');
    if (currentSearch !== queryString) {
      window.history.replaceState(null, '', newRelativePathQuery);
    }
  }, [debouncedQ, status, sort]);

  // Support browser Back/Forward navigation by listening to popstate
  useEffect(() => {
    function handlePopState() {
      const current = getInitialParams();
      setQ(current.q);
      setStatus(current.status);
      setSort(current.sort);
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function applyBulkStatus(next: AssetStatus) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setNotice(null);
    try {
      const result = await bulkSetStatus(ids, next);
      setNotice(`${result.applied} updated, ${result.failed} failed.`);
      setSelectedIds(new Set());
      refetch();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Bulk update failed');
    }
  }

  function handleSaved(_asset: Asset) {
    refetch();
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>MediaVault</h1>
        <input
          className="search"
          type="search"
          placeholder="Search assets"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </header>

      <div className="filters">
        {STATUSES.map((s) => (
          <label key={s}>
            <input
              type="checkbox"
              checked={status.includes(s)}
              onChange={(e) =>
                setStatus((prev) =>
                  e.target.checked ? [...prev, s] : prev.filter((x) => x !== s),
                )
              }
            />
            {statusLabel(s)}
          </label>
        ))}
        <span className="muted">
          {loading ? 'Searching…' : `${items.length} of ${total.toLocaleString()} shown`}
        </span>
      </div>

      {selectedIds.size > 0 && (
        <div className="bulkbar">
          <span>{selectedIds.size} selected</span>
          {STATUSES.map((s) => (
            <button key={s} onClick={() => applyBulkStatus(s)}>
              Set {statusLabel(s).toLowerCase()}
            </button>
          ))}
          <button onClick={() => setSelectedIds(new Set())}>Clear selection</button>
        </div>
      )}

      {notice && <p className="notice">{notice}</p>}
      {error && (
        <div
          className="error"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span>{error}</span>
          <button type="button" onClick={refetch} style={{ fontSize: 12, padding: '2px 8px' }}>
            Retry
          </button>
        </div>
      )}

      <main className="content">
        {loading && items.length === 0 ? (
          <div className="empty">
            <p>Loading assets…</p>
            <p className="muted">Connecting to media vault</p>
          </div>
        ) : (
          <AssetGrid
            assets={items}
            selectedIds={selectedIds}
            activeId={activeId}
            onToggleSelect={toggleSelect}
            onOpen={setActiveId}
          />
        )}
        {activeId && (
          <AssetDetail id={activeId} onClose={() => setActiveId(null)} onSaved={handleSaved} />
        )}
      </main>
    </div>
  );
}
