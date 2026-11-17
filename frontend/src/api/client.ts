import type {
  Account,
  ApiErrorBody,
  Category,
  Dashboard,
  FlagStatus,
  FlagType,
  Page,
  ReviewFlag,
  Session,
  TransactionDetail,
  TransactionSummary,
} from './types'

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    const message = body?.message
    super(Array.isArray(message) ? message.join('; ') : (message ?? `Request failed (${status})`))
  }

  /** Lines suitable for showing under a form. */
  get details(): string[] {
    const message = this.body?.message
    return Array.isArray(message) ? message : [this.message]
  }
}

let token: string | null = null
let onUnauthorized: (() => void) | null = null

export function setToken(value: string | null) {
  token = value
}
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler
}

/** A readable error when the response is not from our API (proxy failure, wrong server). */
function describeFailure(status: number): ApiErrorBody {
  const unreachable = status === 502 || status === 503 || status === 504
  return {
    statusCode: status,
    error: 'Request failed',
    message: unreachable
      ? 'Cannot reach the API server. Check that the backend is running and that the frontend points at its port (API_PROXY_TARGET in frontend/.env).'
      : `Unexpected response from the server (${status}).`,
  }
}

type Query = Record<string, string | number | boolean | null | undefined>

function withQuery(path: string, query?: Query): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

async function request<T>(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await fetch(`${BASE_URL}${withQuery(path, options.query)}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch {
    throw new ApiError(0, {
      statusCode: 0,
      error: 'Network error',
      message: 'Could not reach the server. Check that the API is running.',
    })
  }

  const text = await response.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null // e.g. an HTML error page from a proxy
  }
  if (!response.ok) {
    if (response.status === 401 && token) onUnauthorized?.()
    const body = data as ApiErrorBody | null
    if (!body?.message) throw new ApiError(response.status, describeFailure(response.status))
    throw new ApiError(response.status, body)
  }
  return data as T
}

export interface TransactionFilters {
  q?: string
  accountId?: string
  direction?: string
  category?: string
  classificationStatus?: string
  flagged?: string
  from?: string
  to?: string
  minAmount?: string
  maxAmount?: string
  limit?: number
  cursor?: string
}

export const api = {
  login: (email: string, password: string) =>
    request<Session>('POST', '/auth/login', { body: { email, password } }),
  me: () => request<Pick<Session, 'user' | 'organisation'>>('GET', '/auth/me'),

  accounts: () => request<Account[]>('GET', '/accounts'),

  dashboard: (query: { from?: string; to?: string; accountId?: string }) =>
    request<Dashboard>('GET', '/dashboard', { query }),

  transactions: (filters: TransactionFilters) =>
    request<Page<TransactionSummary>>('GET', '/transactions', { query: { ...filters } }),
  transaction: (id: string) => request<TransactionDetail>('GET', `/transactions/${id}`),
  correctCategory: (id: string, body: { category: Category; note?: string; expectedVersion?: number }) =>
    request<TransactionDetail>('PATCH', `/transactions/${id}/category`, { body }),

  flags: (query: { status?: FlagStatus; type?: FlagType; limit?: number; cursor?: string }) =>
    request<Page<ReviewFlag>>('GET', '/review/flags', { query }),
  reviewSummary: () => request<{ open: number; byType: Record<FlagType, number> }>('GET', '/review/summary'),
  resolveFlag: (id: string, body: { status: 'RESOLVED' | 'DISMISSED'; note?: string }) =>
    request<unknown>('PATCH', `/review/flags/${id}`, { body }),
}
