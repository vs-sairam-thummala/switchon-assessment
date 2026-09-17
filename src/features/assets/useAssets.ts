import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { listAssets } from '@/api/client';
import type { Asset, AssetQuery } from '@/lib/types';

export interface UseAssetsState {
  items: Asset[];
  total: number;
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  refetch: () => void;
}

/**
 * Production-ready hook for loading, searching, and filtering assets.
 *
 * Core Resilience Features:
 * 1. Request Cancellation: Cancels in-flight network requests via AbortController
 *    as soon as query parameters change.
 * 2. Monotonic Sequencing (reqSeqRef): Guards against out-of-order responses
 *    (e.g., short prefix latency spikes) so stale responses never overwrite fresh ones.
 * 3. Cursor Invalidation: Resets the pagination cursor whenever filters change
 *    to prevent the server's 400 stale_cursor error.
 * 4. Structured UI States: Clean separation of loading, empty, error, and data states.
 */
export function useAssets(query: AssetQuery): UseAssetsState {
  const [items, setItems] = useState<Asset[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchIndex, setFetchIndex] = useState(0);

  // Monotonic request counter to prevent race conditions from out-of-order arrivals
  const reqSeqRef = useRef<number>(0);

  // Stabilize query key so object recreation on render doesn't trigger spurious fetches
  const statusKey = query.status?.slice().sort().join(',') ?? '';
  const kindKey = query.kind?.slice().sort().join(',') ?? '';
  const tagKey = query.tag?.slice().sort().join(',') ?? '';
  const filterKey = useMemo(
    () =>
      [
        query.q ?? '',
        statusKey,
        kindKey,
        tagKey,
        query.collectionId ?? '',
        query.owner ?? '',
        query.sort ?? 'updatedAt:desc',
        query.limit ?? 24,
      ].join('::'),
    [query.q, statusKey, kindKey, tagKey, query.collectionId, query.owner, query.sort, query.limit],
  );

  const refetch = useCallback(() => {
    setFetchIndex((prev) => prev + 1);
  }, []);

  useEffect(() => {
    // 1. Increment sequence counter for this new query
    const currentSeq = ++reqSeqRef.current;

    // 2. Create AbortController to cancel previous in-flight requests
    const controller = new AbortController();

    setLoading(true);
    setError(null);

    // Ensure cursor is omitted when filters change to avoid 400 stale_cursor
    const cleanQuery: AssetQuery = {
      ...query,
      cursor: undefined,
    };

    listAssets(cleanQuery, { signal: controller.signal })
      .then((page) => {
        // Drop response if a newer query has been initiated
        if (currentSeq !== reqSeqRef.current) {
          return;
        }

        setItems(page.items);
        setTotal(page.total);
        setNextCursor(page.nextCursor);
        setLoading(false);
        setError(null);
      })
      .catch((err: unknown) => {
        // Ignore aborted requests or responses superseded by a newer query
        if (currentSeq !== reqSeqRef.current) {
          return;
        }
        if ((err as Error)?.name === 'AbortError') {
          return;
        }

        setLoading(false);
        setError(err instanceof Error ? err.message : 'Failed to load assets');
      });

    // Cleanup: cancel this request when query changes or component unmounts
    return () => {
      controller.abort();
    };
  }, [filterKey, fetchIndex]);

  const isEmpty = !loading && items.length === 0 && !error;

  return {
    items,
    total,
    nextCursor,
    loading,
    error,
    isEmpty,
    refetch,
  };
}
