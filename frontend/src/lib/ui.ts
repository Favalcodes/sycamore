/**
 * Shared Tailwind class strings, so the same element looks the same on every
 * page. Plain utility classes only — no custom CSS.
 */
export const ui = {
  page: 'mx-auto w-full max-w-7xl px-4 pb-12 pt-6 sm:px-7',
  pageHeader: 'mb-5 flex flex-wrap items-end justify-between gap-4',
  h1: 'text-[22px] font-semibold leading-tight',
  h2: 'text-[15px] font-semibold',
  subtitle: 'mt-1 text-slate-500 dark:text-slate-400',
  muted: 'text-slate-500 dark:text-slate-400',
  card: 'rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900',
  cardHeader:
    'flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3.5 dark:border-slate-800',
  cardBody: 'px-4 py-4',
  label: 'flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-400',
  input:
    'min-h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
  btn: 'inline-flex min-h-9 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800',
  btnPrimary:
    'inline-flex min-h-9 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-emerald-700 bg-emerald-700 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-500',
  btnSm:
    'inline-flex min-h-8 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[13px] font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800',
  btnPrimarySm:
    'inline-flex min-h-8 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-emerald-700 bg-emerald-700 px-2.5 py-1 text-[13px] font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-500',
  btnGhostSm:
    'inline-flex min-h-8 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800',
  alertError: 'rounded-md bg-red-50 px-3.5 py-2.5 text-[13.5px] text-red-700 dark:bg-red-950/60 dark:text-red-300',
  alertInfo: 'rounded-md bg-blue-50 px-3.5 py-2.5 text-[13.5px] text-blue-800 dark:bg-blue-950/60 dark:text-blue-300',
  alertSuccess:
    'rounded-md bg-emerald-50 px-3.5 py-2.5 text-[13.5px] text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
  empty: 'px-4 py-8 text-center text-slate-500 dark:text-slate-400',
  skeleton: 'animate-pulse rounded-md bg-slate-200 dark:bg-slate-800',
  link: 'text-emerald-700 hover:underline dark:text-emerald-400',
  credit: 'text-emerald-700 dark:text-emerald-400',
  debit: 'text-red-700 dark:text-red-400',
  mono: 'font-mono text-[12.5px]',
} as const

export const amountClass = (direction: 'CREDIT' | 'DEBIT') => (direction === 'CREDIT' ? ui.credit : ui.debit)
