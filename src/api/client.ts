import type { Asset, AssetPage, AssetQuery, BulkResult } from '@/lib/types';

/**
 * Structured API Error interface.
 * Extends standard Error with HTTP status and backend details.
 */
export interface ApiError extends Error {
  readonly isApiError: true;
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  readonly requestId?: string;
}

/**
 * Factory function to create a typed ApiError.
 */
export function createApiError(
  status: number,
  code: string,
  message: string,
  retryAfter?: number,
  requestId?: string,
): ApiError {
  const err = new Error(message) as ApiError;
  Object.assign(err, {
    name: 'ApiError',
    isApiError: true,
    status,
    code,
    retryAfter,
    requestId,
  });
  return err;
}

/**
 * Type guard to check if an unknown error is an ApiError.
 */
export function isApiError(err: unknown): err is ApiError {
  return typeof err === 'object' && err !== null && (err as ApiError).isApiError === true;
}

/**
 *  Helper functions to check error types.
 */
export function isRetryableError(err: unknown): boolean {
  if (!isApiError(err)) return false;
  if (err.status === 503) return true; // upstream_unavailable
  if (err.status === 429) return true; // rate_limited
  if (err.status === 500 && err.code === 'write_failed') return true; // flaky writes
  return false;
}

export function isRateLimitedError(err: unknown): boolean {
  return isApiError(err) && err.status === 429;
}

export function isConflictError(err: unknown): boolean {
  return isApiError(err) && (err.status === 409 || err.code === 'version_conflict');
}

export function isStaleCursorError(err: unknown): boolean {
  return isApiError(err) && err.status === 400 && err.code === 'stale_cursor';
}

export function isNotFoundError(err: unknown): boolean {
  return isApiError(err) && err.status === 404;
}

export function isLegalHoldError(err: unknown): boolean {
  return isApiError(err) && err.code === 'legal_hold';
}

export interface RequestOptions extends RequestInit {
  maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 4000;

/**
 * Pause execution for ms, but immediately cancel if the AbortSignal fires.
 */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new DOMException('Request aborted', 'AbortError'));
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Request aborted', 'AbortError'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Calculates exponential backoff delay with randomized jitter
 * or honors the server's Retry-After header.
 */
function computeBackoff(attempt: number, retryAfterSec?: number): number {
  if (typeof retryAfterSec === 'number' && retryAfterSec > 0) {
    // Honor server's Retry-After in seconds + small jitter
    return retryAfterSec * 1000 + Math.floor(Math.random() * 200);
  }
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * (exponential * 0.3));
  return exponential + jitter;
}

/**
 * Determines if an HTTP status is transient and safe to retry.
 */
function isRetryableStatus(status: number, method: string, code?: string): boolean {
  // Never retry client validation errors, conflicts, or stale cursors
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return false;
  }
  // 503 (upstream unavailable) and 429 (rate limited) are always transient
  if (status === 503 || status === 429) {
    return true;
  }
  // 500: safe for GET, or for PATCH when specifically write_failed
  if (status === 500) {
    if (method === 'GET') return true;
    if (code === 'write_failed') return true;
  }
  return false;
}

// In-flight GET request coalescing / de-duplication cache
const inFlightRequests = new Map<string, Promise<unknown>>();

function toSearchParams(query: AssetQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.status?.length) params.set('status', query.status.join(','));
  if (query.kind?.length) params.set('kind', query.kind.join(','));
  if (query.tag?.length) params.set('tag', query.tag.join(','));
  if (query.collectionId) params.set('collectionId', query.collectionId);
  if (query.owner) params.set('owner', query.owner);
  if (query.sort) params.set('sort', query.sort);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  return params.toString();
}

/**
 * Execute an HTTP request with exponential backoff, jitter, Retry-After honoring,
 * structured error typing, and optional cancellation.
 */
async function requestWithRetry<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { maxRetries = DEFAULT_MAX_RETRIES, signal, headers, ...restInit } = options;
  const method = (restInit.method ?? 'GET').toUpperCase();

  let attempt = 0;

  while (true) {
    if (signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    try {
      const res = await fetch(path, {
        ...restInit,
        signal,
        headers: {
          'content-type': 'application/json',
          ...(headers ?? {}),
        },
      });

      const requestId = res.headers.get('x-request-id') ?? undefined;
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

      if (!res.ok) {
        let code = 'unknown_error';
        let message = res.statusText;

        try {
          const body = await res.json();
          if (body?.error) {
            code = body.error.code ?? code;
            message = body.error.message ?? message;
          }
        } catch {
          // Non-JSON response body
        }

        const apiError = createApiError(res.status, code, message, retryAfterSec, requestId);

        // Check if we can and should retry
        const canRetry = attempt < maxRetries && isRetryableStatus(res.status, method, code);
        if (canRetry) {
          attempt += 1;
          const delay = computeBackoff(attempt, retryAfterSec);
          await sleep(delay, signal);
          continue;
        }

        throw apiError;
      }

      // Successful 2xx response
      return (await res.json()) as T;
    } catch (err: unknown) {
      // Don't retry user aborts
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }

      // If it's already an ApiError and cannot be retried, bubble it up
      if (isApiError(err)) {
        throw err;
      }

      // Network errors (e.g. fetch failed / offline)
      if (attempt < maxRetries) {
        attempt += 1;
        const delay = computeBackoff(attempt);
        await sleep(delay, signal);
        continue;
      }

      // Exhausted retries on network error
      throw createApiError(
        0,
        'network_error',
        err instanceof Error ? err.message : 'Network connection failure',
      );
    }
  }
}

/**
 * Dispatch request, automatically de-duplicating concurrent identical GET calls.
 */
function request<T>(path: string, options?: RequestOptions): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase();

  // Only de-duplicate idempotent GET requests without a custom signal
  const canDedupe = method === 'GET' && !options?.signal;

  if (canDedupe) {
    const existing = inFlightRequests.get(path);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = requestWithRetry<T>(path, options).finally(() => {
      inFlightRequests.delete(path);
    });

    inFlightRequests.set(path, promise);
    return promise;
  }

  return requestWithRetry<T>(path, options);
}

export function listAssets(query: AssetQuery, options?: RequestOptions): Promise<AssetPage> {
  return request<AssetPage>(`/api/assets?${toSearchParams(query)}`, options);
}

export function getAsset(id: string, options?: RequestOptions): Promise<Asset> {
  return request<Asset>(`/api/assets/${id}`, options);
}

export function getAssetsByIds(
  ids: string[],
  options?: RequestOptions,
): Promise<{ items: Asset[]; missing: string[] }> {
  // Note: the endpoint rejects more than 25 ids per call.
  return request(`/api/assets/batch?ids=${ids.join(',')}`, options);
}

export function updateAsset(
  id: string,
  version: number,
  patch: Partial<Pick<Asset, 'name' | 'status' | 'tags'>>,
  options?: RequestOptions,
): Promise<Asset> {
  return request<Asset>(`/api/assets/${id}`, {
    ...options,
    method: 'PATCH',
    body: JSON.stringify({ version, patch }),
  });
}

export function bulkSetStatus(
  ids: string[],
  status: Asset['status'],
  options?: RequestOptions,
): Promise<BulkResult> {
  // Note: the endpoint rejects more than 50 ids per call.
  return request<BulkResult>('/api/assets/bulk-status', {
    ...options,
    method: 'POST',
    body: JSON.stringify({ ids, status }),
  });
}

export const thumbnailUrl = (id: string) => `/api/thumb/${id}.svg`;
