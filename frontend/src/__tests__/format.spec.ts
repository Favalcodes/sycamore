import { describe, expect, it } from 'vitest'
import { formatMoney, formatSigned, isNegative } from '@/lib/format'

const ngn = (value: string) => ({ minor: '', value, currency: 'NGN' })

describe('money formatting', () => {
  it('formats the API decimal string exactly', () => {
    expect(formatMoney(ngn('12999.75'))).toBe('₦12,999.75')
  })

  it('does not lose precision beyond float range', () => {
    // 90,071,992,547,409.93 cannot be represented exactly as a double.
    expect(formatMoney(ngn('90071992547409.93'))).toBe('₦90,071,992,547,409.93')
  })

  it('signs amounts by direction', () => {
    expect(formatSigned(ngn('50.00'), 'CREDIT')).toBe('+₦50.00')
    expect(formatSigned(ngn('50.00'), 'DEBIT')).toBe('−₦50.00')
  })

  it('detects negative net values from the string', () => {
    expect(isNegative(ngn('-1.00'))).toBe(true)
    expect(isNegative(ngn('0.00'))).toBe(false)
  })
})
