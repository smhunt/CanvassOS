// Thin fetch wrapper for the same-origin /api. Errors become ApiError { status, code, message }.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isApiError(err: unknown, status?: number): err is ApiError {
  return err instanceof ApiError && (status === undefined || err.status === status);
}

/** Human-readable message for any thrown value (network failures included). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) return 'Network error — check your connection and try again.';
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

type Query = Record<string, string | number | boolean | string[] | undefined | null>;

export function buildQuery(params: Query | undefined): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length) sp.set(k, v.join(','));
    } else {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Listeners notified when any call comes back 401 (the auth guard clears the session). */
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

async function request<T>(method: string, path: string, body?: unknown, opts?: { silent401?: boolean }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
    const err = new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? (res.statusText || 'Request failed'));
    if (res.status === 401 && !opts?.silent401) for (const fn of unauthorizedListeners) fn();
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, params?: Query, opts?: { silent401?: boolean }) =>
    request<T>('GET', `${path}${buildQuery(params)}`, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: { silent401?: boolean }) => request<T>('POST', path, body ?? {}, opts),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  // Unassigning a turf and deleting a sign both return 204; request() already maps that to undefined.
  del: <T>(path: string) => request<T>('DELETE', path),
};
