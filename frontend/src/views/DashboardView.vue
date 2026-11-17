<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api, ApiError } from '@/api/client'
import type { Account, Dashboard, FlagType } from '@/api/types'
import FlagChip from '@/components/FlagChip.vue'
import SelectInput from '@/components/SelectInput.vue'
import { daysAgo, formatDate, formatMoney, isNegative } from '@/lib/format'
import { amountClass, ui } from '@/lib/ui'

const PERIODS = [
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
  { id: '180', label: '6 months' },
  { id: 'all', label: 'All time' },
] as const

const period = ref<(typeof PERIODS)[number]['id']>('90')
const accountId = ref('')
const accounts = ref<Account[]>([])
const data = ref<Dashboard | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await api.dashboard({
      from: period.value === 'all' ? undefined : daysAgo(Number(period.value)),
      accountId: accountId.value || undefined,
    })
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Could not load the dashboard'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  void load()
  try {
    accounts.value = await api.accounts()
  } catch {
    /* filter just stays empty */
  }
})
watch([period, accountId], load)

const pending = computed(() => (data.value?.classification.PENDING ?? 0) + (data.value?.classification.PROCESSING ?? 0))
const failed = computed(() => data.value?.classification.FAILED ?? 0)
const flagTypes = computed(() =>
  data.value
    ? (Object.entries(data.value.flags.byType) as Array<[FlagType, number]>).filter(([, n]) => n > 0)
    : [],
)
const maxShare = computed(() => Math.max(1, ...(data.value?.spendingByCategory.map((s) => s.shareBp) ?? [1])))
const periodLabel = computed(() => PERIODS.find((p) => p.id === period.value)?.label.toLowerCase())
</script>

<template>
  <div :class="ui.page">
    <div :class="ui.pageHeader">
      <div>
        <h1 :class="ui.h1">Dashboard</h1>
        <p :class="ui.subtitle">
          Cash flow and spending in NGN, {{ period === 'all' ? 'all time' : `last ${periodLabel}` }}.
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div
          class="inline-flex divide-x divide-slate-200 overflow-hidden rounded-md border border-slate-300 bg-white dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-900"
          role="group"
          aria-label="Period"
        >
          <button
            v-for="p in PERIODS"
            :key="p.id"
            type="button"
            class="cursor-pointer px-3 py-1.5 text-[13px]"
            :class="
              period === p.id
                ? 'bg-emerald-50 font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'
            "
            :aria-pressed="period === p.id"
            @click="period = p.id"
          >
            {{ p.label }}
          </button>
        </div>
        <SelectInput v-model="accountId" aria-label="Account" :full-width="false">
          <option value="">All accounts</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }} · {{ a.bankName }}</option>
        </SelectInput>
      </div>
    </div>

    <div v-if="error" :class="[ui.alertError, 'mb-4']" role="alert">{{ error }}</div>

    <div v-if="pending || failed" :class="[ui.alertInfo, 'mb-4']" role="status">
      <template v-if="pending">
        {{ pending }} transaction{{ pending === 1 ? ' is' : 's are' }} still being categorised; spending totals for those
        appear under “Awaiting classification” until they are.
      </template>
      <template v-if="failed">
        {{ failed }} could not be categorised automatically and need a person to confirm them —
        <RouterLink to="/transactions?classificationStatus=FAILED" class="font-medium underline">review them</RouterLink>.
      </template>
    </div>

    <section class="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Totals">
      <template v-if="data && !loading">
        <div :class="[ui.card, 'flex flex-col gap-1.5 px-4 py-4']">
          <span class="text-[12.5px] font-medium text-slate-500 dark:text-slate-400">Total inflow</span>
          <strong class="text-[22px] font-semibold tabular-nums" :class="ui.credit">{{ formatMoney(data.totals.inflow) }}</strong>
        </div>
        <div :class="[ui.card, 'flex flex-col gap-1.5 px-4 py-4']">
          <span class="text-[12.5px] font-medium text-slate-500 dark:text-slate-400">Total outflow</span>
          <strong class="text-[22px] font-semibold tabular-nums" :class="ui.debit">{{ formatMoney(data.totals.outflow) }}</strong>
        </div>
        <div :class="[ui.card, 'flex flex-col gap-1.5 px-4 py-4']">
          <span class="text-[12.5px] font-medium text-slate-500 dark:text-slate-400">Net cash flow</span>
          <strong
            class="text-[22px] font-semibold tabular-nums"
            :class="isNegative(data.totals.net) ? ui.debit : ui.credit"
          >
            {{ formatMoney(data.totals.net) }}
          </strong>
        </div>
        <div :class="[ui.card, 'flex flex-col gap-1.5 px-4 py-4']">
          <span class="text-[12.5px] font-medium text-slate-500 dark:text-slate-400">Transactions</span>
          <strong class="text-[22px] font-semibold tabular-nums">{{ data.totals.transactionCount.toLocaleString('en-NG') }}</strong>
          <span v-if="data.internalTransfers.transactionCount" class="text-xs text-slate-500 dark:text-slate-400">
            + {{ data.internalTransfers.transactionCount }} transfers between own accounts
            ({{ formatMoney(data.internalTransfers.out, { compact: true }) }}), excluded from totals
          </span>
        </div>
      </template>
      <template v-else>
        <div v-for="i in 4" :key="i" :class="[ui.card, 'px-4 py-4']"><div :class="[ui.skeleton, 'h-11']" /></div>
      </template>
    </section>

    <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
      <section :class="[ui.card, 'lg:col-span-3']" aria-labelledby="spending-h">
        <div :class="ui.cardHeader">
          <h2 id="spending-h" :class="ui.h2">Spending by category</h2>
          <span :class="[ui.muted, 'text-[13px]']">Debits, excluding own-account transfers</span>
        </div>
        <div :class="ui.cardBody">
          <div v-if="loading" class="flex flex-col gap-3">
            <div v-for="i in 6" :key="i" :class="[ui.skeleton, 'h-7']" />
          </div>
          <p v-else-if="!data?.spendingByCategory.length" :class="ui.empty">No spending in this period.</p>
          <ul v-else class="flex flex-col gap-1">
            <li v-for="s in data!.spendingByCategory" :key="s.category">
              <RouterLink
                class="grid grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-1.5 hover:bg-slate-50 sm:grid-cols-[130px_minmax(0,1fr)_auto_52px] dark:hover:bg-slate-800"
                :to="{
                  path: '/transactions',
                  query: {
                    category: s.category,
                    direction: 'DEBIT',
                    ...(period !== 'all' ? { from: daysAgo(Number(period)) } : {}),
                  },
                }"
              >
                <span class="font-medium">{{ s.label }}</span>
                <span class="h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" aria-hidden="true">
                  <span
                    class="block h-full min-w-0.5 rounded-full"
                    :class="s.category === 'UNCATEGORISED' ? 'bg-slate-400' : 'bg-emerald-600 dark:bg-emerald-500'"
                    :style="{ width: `${(s.shareBp / maxShare) * 100}%` }"
                  />
                </span>
                <span class="font-medium tabular-nums">{{ formatMoney(s.amount) }}</span>
                <span class="hidden text-right text-[12.5px] tabular-nums text-slate-500 sm:block dark:text-slate-400">
                  {{ (s.shareBp / 100).toFixed(1) }}%
                </span>
              </RouterLink>
            </li>
          </ul>
        </div>
      </section>

      <section :class="[ui.card, 'lg:col-span-2']" aria-labelledby="flags-h">
        <div :class="ui.cardHeader">
          <h2 id="flags-h" :class="ui.h2">Flagged for review</h2>
          <RouterLink to="/review" :class="ui.link">Open queue →</RouterLink>
        </div>
        <div :class="[ui.cardBody, 'flex flex-col gap-4']">
          <div v-if="loading" class="flex flex-col gap-3">
            <div v-for="i in 4" :key="i" :class="[ui.skeleton, 'h-13']" />
          </div>
          <template v-else-if="data">
            <div class="flex items-baseline gap-2">
              <strong class="text-[28px] font-semibold tabular-nums">{{ data.flags.open }}</strong>
              <span :class="ui.muted">open flag{{ data.flags.open === 1 ? '' : 's' }}</span>
            </div>
            <div v-if="flagTypes.length" class="flex flex-wrap gap-2">
              <RouterLink v-for="[type, n] in flagTypes" :key="type" :to="{ path: '/review', query: { type } }">
                <FlagChip :type="type" :count="n" />
              </RouterLink>
            </div>
            <p v-if="!data.flags.recent.length" :class="ui.empty">Nothing needs attention.</p>
            <ul v-else class="flex flex-col gap-2">
              <li v-for="f in data.flags.recent" :key="f.id">
                <RouterLink
                  :to="`/transactions/${f.transaction.id}`"
                  class="flex flex-col gap-1 rounded-md border border-slate-200 px-3 py-2.5 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:hover:border-slate-700 dark:hover:bg-slate-800/60"
                >
                  <div class="flex items-center justify-between gap-2">
                    <FlagChip :type="f.type" />
                    <span class="tabular-nums" :class="amountClass(f.transaction.direction)">
                      {{ formatMoney(f.transaction.amount) }}
                    </span>
                  </div>
                  <span class="font-medium [overflow-wrap:anywhere]">{{ f.transaction.description }}</span>
                  <span class="text-[13px] text-slate-600 dark:text-slate-300">{{ f.reason }}</span>
                  <span class="text-xs text-slate-500 dark:text-slate-400">
                    {{ formatDate(f.transaction.date) }} · {{ f.transaction.accountName }}
                  </span>
                </RouterLink>
              </li>
            </ul>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>
