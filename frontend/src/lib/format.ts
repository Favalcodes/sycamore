import type { Money } from '@/api/types'

/**
 * Formats a money value from its decimal *string*. Intl.NumberFormat accepts
 * strings and formats them exactly, so amounts never pass through a float.
 */
const formatters = new Map<string, Intl.NumberFormat>()
function currencyFormatter(currency: string, compact: boolean): Intl.NumberFormat {
  const key = `${currency}:${compact}`
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      ...(compact ? { notation: 'compact', maximumFractionDigits: 1 } : { minimumFractionDigits: 2 }),
    })
    formatters.set(key, f)
  }
  return f
}

export function formatMoney(money: Money, options: { compact?: boolean } = {}): string {
  // `format` takes a string decimal at runtime (Intl.NumberFormat v3); the
  // lib typings still say number, hence the cast.
  return currencyFormatter(money.currency, options.compact ?? false).format(
    money.value as unknown as number,
  )
}

/** Signed amount for tables: credits positive, debits negative. */
export function formatSigned(money: Money, direction: 'CREDIT' | 'DEBIT'): string {
  return `${direction === 'CREDIT' ? '+' : '−'}${formatMoney(money)}`
}

export function isNegative(money: Money): boolean {
  return money.value.startsWith('-')
}

const dateFmt = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
})
const dateTimeFmt = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Africa/Lagos',
})

export const formatDate = (iso: string) => dateFmt.format(new Date(iso))
export const formatDateTime = (iso: string) => dateTimeFmt.format(new Date(iso))

export function formatPercent(fraction: number | null): string {
  return fraction === null ? '—' : `${Math.round(fraction * 100)}%`
}

/** YYYY-MM-DD for `n` days ago, in Lagos time. */
export function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(d)
}

export const SOURCE_LABELS: Record<string, string> = {
  RULES: 'Rule',
  AI: 'AI',
  LEARNED: 'Learned',
  FALLBACK: 'Fallback',
  MANUAL: 'Manual',
}
