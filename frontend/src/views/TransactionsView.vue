<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, ApiError, type TransactionFilters } from '@/api/client'
import { CATEGORIES, CATEGORY_LABELS, type Account, type TransactionSummary } from '@/api/types'
import CategoryBadge from '@/components/CategoryBadge.vue'
import FlagChip from '@/components/FlagChip.vue'
import SelectInput from '@/components/SelectInput.vue'
import { formatDate, formatSigned } from '@/lib/format'
import { amountClass, ui } from '@/lib/ui'

const route = useRoute()
const router = useRouter()

const FILTER_KEYS = [
  'q',
  'accountId',
  'direction',
  'category',
  'classificationStatus',
  'flagged',
  'from',
  'to',
  'minAmount',
  'maxAmount',
] as const
type FilterKey = (typeof FILTER_KEYS)[number]

/** Form state mirrors the URL so a filtered view can be bookmarked or shared. */
const form = reactive<Record<FilterKey, string>>(
  Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])) as Record<FilterKey, string>,
)
function syncFormFromRoute() {
  for (const key of FILTER_KEYS) {
    const v = route.query[key]
    form[key] = typeof v === 'string' ? v : ''
  }
}
syncFormFromRoute()

const accounts = ref<Account[]>([])
const rows = ref<TransactionSummary[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const showMore = ref(Boolean(form.from || form.to || form.minAmount || form.maxAmount || form.classificationStatus))

// Keyset pagination: keep the cursors we came through so "Previous" works.
const cursorStack = ref<string[]>([])
const currentCursor = ref<string | undefined>(undefined)
const nextCursor = ref<string | null>(null)
const pageSize = 25

const activeFilters = computed(
  () =>
    Object.fromEntries(
      FILTER_KEYS.filter((k) => typeof route.query[k] === 'string' && route.query[k] !== '').map((k) => [
        k,
        route.query[k] as string,
      ]),
    ) as TransactionFilters,
)
const hasFilters = computed(() => Object.keys(activeFilters.value).length > 0)

async function load() {
  loading.value = true
  error.value = null
  try {
    const page = await api.transactions({ ...activeFilters.value, limit: pageSize, cursor: currentCursor.value })
    rows.value = page.data
    nextCursor.value = page.pageInfo.nextCursor
  } catch (e) {
    error.value = e instanceof ApiError ? e.details.join(' · ') : 'Could not load transactions'
    rows.value = []
    nextCursor.value = null
  } finally {
    loading.value = false
  }
}

function applyFilters() {
  const query = Object.fromEntries(FILTER_KEYS.filter((k) => form[k].trim() !== '').map((k) => [k, form[k].trim()]))
  void router.replace({ query })
}
function clearFilters() {
  void router.replace({ query: {} })
}

// Debounced search-as-you-type; other controls apply immediately.
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => form.q,
  (value, old) => {
    if (value === (route.query.q ?? '') || value === old) return
    clearTimeout(searchTimer)
    searchTimer = setTimeout(applyFilters, 350)
  },
)

watch(
  () => route.query,
  () => {
    syncFormFromRoute()
    cursorStack.value = []
    currentCursor.value = undefined
    void load()
  },
)

function nextPage() {
  if (!nextCursor.value) return
  cursorStack.value.push(currentCursor.value ?? '')
  currentCursor.value = nextCursor.value
  void load()
  window.scrollTo({ top: 0 })
}
function previousPage() {
  const prev = cursorStack.value.pop()
  currentCursor.value = prev || undefined
  void load()
  window.scrollTo({ top: 0 })
}

function open(id: string) {
  void router.push(`/transactions/${id}`)
}

onMounted(async () => {
  void load()
  try {
    accounts.value = await api.accounts()
  } catch {
    /* filter stays empty */
  }
})

const th =
  'whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3.5 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-400'
const td = 'border-b border-slate-200 px-3.5 py-3 align-top dark:border-slate-800'
</script>

<template>
  <div :class="ui.page">
    <div :class="ui.pageHeader">
      <div>
        <h1 :class="ui.h1">Transactions</h1>
        <p :class="ui.subtitle">Search, filter and open any transaction to review its classification.</p>
      </div>
    </div>

    <form :class="[ui.card, 'mb-4 flex flex-col gap-3 px-4 py-3.5']" role="search" @submit.prevent="applyFilters">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-[minmax(220px,2fr)_repeat(4,minmax(130px,1fr))]">
        <label :class="[ui.label, 'col-span-2 lg:col-span-1']" for="q">
          Search
          <input id="q" v-model="form.q" type="search" placeholder="Description, merchant or reference" :class="ui.input" />
        </label>
        <label :class="ui.label" for="accountId">
          Account
          <SelectInput id="accountId" v-model="form.accountId" @change="applyFilters">
            <option value="">All</option>
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
          </SelectInput>
        </label>
        <label :class="ui.label" for="direction">
          Direction
          <SelectInput id="direction" v-model="form.direction" @change="applyFilters">
            <option value="">All</option>
            <option value="CREDIT">Money in</option>
            <option value="DEBIT">Money out</option>
          </SelectInput>
        </label>
        <label :class="ui.label" for="category">
          Category
          <SelectInput id="category" v-model="form.category" @change="applyFilters">
            <option value="">All</option>
            <option v-for="c in CATEGORIES" :key="c" :value="c">{{ CATEGORY_LABELS[c] }}</option>
            <option value="UNCATEGORISED">Awaiting classification</option>
          </SelectInput>
        </label>
        <label :class="ui.label" for="flagged">
          Review
          <SelectInput id="flagged" v-model="form.flagged" @change="applyFilters">
            <option value="">All</option>
            <option value="true">Flagged</option>
            <option value="false">Not flagged</option>
          </SelectInput>
        </label>
      </div>

      <div v-if="showMore" class="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <label :class="ui.label" for="from">
          From
          <input id="from" v-model="form.from" type="date" :class="ui.input" @change="applyFilters" />
        </label>
        <label :class="ui.label" for="to">
          To
          <input id="to" v-model="form.to" type="date" :class="ui.input" @change="applyFilters" />
        </label>
        <label :class="ui.label" for="minAmount">
          Min amount (₦)
          <input
            id="minAmount"
            v-model="form.minAmount"
            inputmode="decimal"
            placeholder="0.00"
            pattern="\d+(\.\d{1,2})?"
            :class="ui.input"
          />
        </label>
        <label :class="ui.label" for="maxAmount">
          Max amount (₦)
          <input
            id="maxAmount"
            v-model="form.maxAmount"
            inputmode="decimal"
            placeholder="0.00"
            pattern="\d+(\.\d{1,2})?"
            :class="ui.input"
          />
        </label>
        <label :class="ui.label" for="classificationStatus">
          Classification
          <SelectInput id="classificationStatus" v-model="form.classificationStatus" @change="applyFilters">
            <option value="">All</option>
            <option value="CLASSIFIED">Classified</option>
            <option value="PENDING">Pending</option>
            <option value="FAILED">Failed</option>
          </SelectInput>
        </label>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button type="button" :class="ui.btnGhostSm" :aria-expanded="showMore" @click="showMore = !showMore">
          {{ showMore ? 'Fewer filters' : 'More filters' }}
        </button>
        <span class="flex-1" />
        <button v-if="hasFilters" type="button" :class="ui.btnSm" @click="clearFilters">Clear</button>
        <button type="submit" :class="ui.btnPrimarySm">Apply</button>
      </div>
    </form>

    <div v-if="error" :class="[ui.alertError, 'mb-4']" role="alert">{{ error }}</div>

    <section :class="ui.card" aria-live="polite" :aria-busy="loading">
      <div class="overflow-x-auto">
        <table class="w-full border-collapse">
          <thead>
            <tr>
              <th scope="col" :class="th">Date</th>
              <th scope="col" :class="th">Description</th>
              <th scope="col" :class="th">Account</th>
              <th scope="col" :class="th">Category</th>
              <th scope="col" :class="[th, 'text-right']">Amount</th>
            </tr>
          </thead>
          <tbody v-if="loading">
            <tr v-for="i in 8" :key="i">
              <td v-for="j in 5" :key="j" :class="td"><div :class="[ui.skeleton, 'h-3.5']" /></td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr
              v-for="t in rows"
              :key="t.id"
              tabindex="0"
              class="cursor-pointer hover:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500 dark:hover:bg-slate-800/60"
              @click="open(t.id)"
              @keydown.enter="open(t.id)"
            >
              <td :class="[td, 'whitespace-nowrap tabular-nums']">{{ formatDate(t.date) }}</td>
              <td :class="td">
                <div class="flex min-w-[260px] flex-col gap-0.5">
                  <span class="font-medium">{{ t.description }}</span>
                  <span :class="[ui.mono, ui.muted, 'text-xs']">
                    {{ t.externalReference }}<template v-if="t.merchant"> · {{ t.merchant }}</template>
                  </span>
                  <span v-if="t.openFlags.length" class="mt-1 flex flex-wrap gap-1">
                    <FlagChip v-for="f in t.openFlags" :key="f.id" :type="f.type" />
                  </span>
                </div>
              </td>
              <td :class="[td, ui.muted]">{{ t.account.name }}</td>
              <td :class="td">
                <CategoryBadge
                  :category="t.category"
                  :source="t.categorySource"
                  :confidence="t.categoryConfidence"
                  :status="t.classificationStatus"
                  show-meta
                />
              </td>
              <td :class="[td, 'whitespace-nowrap text-right font-semibold tabular-nums', amountClass(t.direction)]">
                {{ formatSigned(t.amount, t.direction) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!loading && !rows.length" :class="ui.empty">
        {{ hasFilters ? 'No transactions match these filters.' : 'No transactions yet.' }}
      </p>
      <nav class="flex items-center justify-between px-4 py-3" aria-label="Pagination">
        <span :class="ui.muted">Page {{ cursorStack.length + 1 }}</span>
        <div class="flex gap-2">
          <button :class="ui.btnSm" type="button" :disabled="!cursorStack.length || loading" @click="previousPage">
            ← Previous
          </button>
          <button :class="ui.btnSm" type="button" :disabled="!nextCursor || loading" @click="nextPage">Next →</button>
        </div>
      </nav>
    </section>
  </div>
</template>
