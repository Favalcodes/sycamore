/** Shapes returned by the backend API. Money is always strings — never JS numbers. */

export interface Money {
  /** Integer minor units (kobo) as a string. */
  minor: string
  /** Decimal string in major units, e.g. "12999.75". */
  value: string
  currency: string
}

export type Direction = 'CREDIT' | 'DEBIT'

export const CATEGORIES = [
  'REVENUE',
  'PAYROLL',
  'SOFTWARE',
  'MARKETING',
  'TRAVEL',
  'UTILITIES',
  'RENT',
  'TAX',
  'TRANSFERS',
  'BANK_FEES',
  'OTHER',
] as const
export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  REVENUE: 'Revenue',
  PAYROLL: 'Payroll',
  SOFTWARE: 'Software',
  MARKETING: 'Marketing',
  TRAVEL: 'Travel',
  UTILITIES: 'Utilities',
  RENT: 'Rent',
  TAX: 'Tax',
  TRANSFERS: 'Transfers',
  BANK_FEES: 'Banking Fees',
  OTHER: 'Other',
}

export type CategorySource = 'RULES' | 'AI' | 'LEARNED' | 'FALLBACK' | 'MANUAL'
export type ClassificationStatus = 'PENDING' | 'PROCESSING' | 'CLASSIFIED' | 'FAILED'

export type FlagType =
  | 'POSSIBLE_DUPLICATE'
  | 'LARGE_AMOUNT'
  | 'LOW_CONFIDENCE'
  | 'UNEXPECTED_CATEGORY'
  | 'CLASSIFICATION_FAILED'
export type FlagStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED'

export const FLAG_LABELS: Record<FlagType, string> = {
  POSSIBLE_DUPLICATE: 'Possible duplicate',
  LARGE_AMOUNT: 'Unusually large',
  LOW_CONFIDENCE: 'Low confidence',
  UNEXPECTED_CATEGORY: 'Unexpected category',
  CLASSIFICATION_FAILED: 'Classification failed',
}

export interface Session {
  accessToken: string
  user: { id: string; email: string; name: string }
  organisation: { id: string; name: string; slug: string }
}

export interface Account {
  id: string
  name: string
  bankName: string
  accountNumberMasked: string
  currency: string
  transactionCount: number
  inflow: Money
  outflow: Money
}

export interface TransactionSummary {
  id: string
  externalReference: string
  account: { id: string; name: string; bankName: string }
  amount: Money
  direction: Direction
  description: string
  merchant: string | null
  date: string
  category: Category | null
  categoryLabel: string | null
  categorySource: CategorySource | null
  categoryConfidence: number | null
  classificationStatus: ClassificationStatus
  openFlags: Array<{ id: string; type: FlagType }>
  version: number
  createdAt: string
}

export interface PageInfo {
  limit: number
  hasMore: boolean
  nextCursor: string | null
}

export interface Page<T> {
  data: T[]
  pageInfo: PageInfo
}

export interface ClassificationEvent {
  id: string
  category: Category
  categoryLabel: string
  previousCategory: Category | null
  source: CategorySource
  provider: string
  confidence: number | null
  rationale: string | null
  actor: { id: string; name: string; email: string } | null
  createdAt: string
}

export interface FlagDetail {
  id: string
  type: FlagType
  status: FlagStatus
  reason: string
  details: Record<string, unknown> | null
  relatedTransactionId: string | null
  createdAt: string
  resolvedAt: string | null
  resolutionNote: string | null
  resolvedBy: { id: string; name: string } | null
}

export interface TransactionDetail extends Omit<TransactionSummary, 'account'> {
  account: { id: string; name: string; bankName: string; accountNumberMasked: string }
  classification: {
    attempts: number
    lastError: string | null
    original: ClassificationEvent | null
    correction: {
      by: { id: string; name: string; email: string } | null
      at: string
      from: Category | null
      note: string | null
    } | null
    history: ClassificationEvent[]
  }
  flags: FlagDetail[]
  importBatchId: string | null
}

export interface ReviewFlag {
  id: string
  type: FlagType
  status: FlagStatus
  reason: string
  createdAt: string
  resolvedAt: string | null
  resolutionNote: string | null
  resolvedBy: { id: string; name: string } | null
  transaction: {
    id: string
    externalReference: string
    description: string
    amount: Money
    direction: Direction
    date: string
    category: Category | null
    categoryLabel: string | null
    categoryConfidence: number | null
    accountName: string
  }
}

export interface Dashboard {
  currency: string
  period: { from: string | null; to: string | null }
  totals: { inflow: Money; outflow: Money; net: Money; transactionCount: number }
  internalTransfers: { in: Money; out: Money; transactionCount: number }
  spendingByCategory: Array<{
    category: Category | 'UNCATEGORISED'
    label: string
    amount: Money
    count: number
    shareBp: number
  }>
  classification: Partial<Record<ClassificationStatus, number>>
  flags: { open: number; byType: Record<FlagType, number>; recent: ReviewFlag[] }
}

export interface ApiErrorBody {
  statusCode: number
  error: string
  message: string | string[]
  requestId?: string
  code?: string
}
