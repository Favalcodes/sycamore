<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { api, ApiError } from '@/api/client'
import { FLAG_LABELS, type FlagStatus, type FlagType, type ReviewFlag } from '@/api/types'
import CategoryBadge from '@/components/CategoryBadge.vue'
import FlagChip from '@/components/FlagChip.vue'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { amountClass, ui } from '@/lib/ui'

const route = useRoute()
const router = useRouter()

const STATUSES: Array<{ id: FlagStatus; label: string }> = [
  { id: 'OPEN', label: 'Open' },
  { id: 'RESOLVED', label: 'Resolved' },
  { id: 'DISMISSED', label: 'Dismissed' },
]
const TYPES = Object.keys(FLAG_LABELS) as FlagType[]

const status = computed<FlagStatus>(() => (route.query.status as FlagStatus) || 'OPEN')
const type = computed<FlagType | undefined>(() => (route.query.type as FlagType) || undefined)

const flags = ref<ReviewFlag[]>([])
const counts = ref<Record<FlagType, number> | null>(null)
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref<string | null>(null)
const busy = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const [page, summary] = await Promise.all([
      api.flags({ status: status.value, type: type.value, limit: 25 }),
      api.reviewSummary(),
    ])
    flags.value = page.data
    nextCursor.value = page.pageInfo.nextCursor
    counts.value = summary.byType
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Could not load the review queue'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (!nextCursor.value) return
  loadingMore.value = true
  try {
    const page = await api.flags({ status: status.value, type: type.value, limit: 25, cursor: nextCursor.value })
    flags.value.push(...page.data)
    nextCursor.value = page.pageInfo.nextCursor
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Could not load more'
  } finally {
    loadingMore.value = false
  }
}

async function quickClose(flag: ReviewFlag, next: 'RESOLVED' | 'DISMISSED') {
  busy.value = flag.id
  try {
    await api.resolveFlag(flag.id, { status: next })
    flags.value = flags.value.filter((f) => f.id !== flag.id)
    if (counts.value) counts.value[flag.type] = Math.max(0, counts.value[flag.type] - 1)
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Could not update the flag'
  } finally {
    busy.value = null
  }
}

function setQuery(patch: Record<string, string | undefined>) {
  const query = { ...route.query, ...patch }
  for (const key of Object.keys(query)) if (!query[key]) delete query[key]
  void router.replace({ query })
}

onMounted(load)
watch(() => route.query, load)

const pill = (active: boolean) =>
  [
    'inline-flex cursor-pointer gap-1.5 rounded-full border px-3 py-1 text-[13px]',
    active
      ? 'border-emerald-600 bg-emerald-50 font-semibold text-emerald-800 dark:border-emerald-500 dark:bg-emerald-950/60 dark:text-emerald-300'
      : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800',
  ].join(' ')
</script>

<template>
  <div :class="ui.page">
    <div :class="ui.pageHeader">
      <div>
        <h1 :class="ui.h1">Review queue</h1>
        <p :class="ui.subtitle">Transactions the system wants a person to look at, with the reason for each.</p>
      </div>
      <div
        class="inline-flex gap-1 rounded-md border border-slate-200 bg-slate-100 p-[3px] dark:border-slate-800 dark:bg-slate-800/60"
        role="tablist"
        aria-label="Flag status"
      >
        <button
          v-for="s in STATUSES"
          :key="s.id"
          role="tab"
          type="button"
          class="cursor-pointer rounded px-3.5 py-1.5 font-medium"
          :class="
            status === s.id
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
          "
          :aria-selected="status === s.id"
          @click="setQuery({ status: s.id === 'OPEN' ? undefined : s.id })"
        >
          {{ s.label }}
        </button>
      </div>
    </div>

    <div class="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by type">
      <button type="button" :class="pill(!type)" :aria-pressed="!type" @click="setQuery({ type: undefined })">
        All types
      </button>
      <button
        v-for="t in TYPES"
        :key="t"
        type="button"
        :class="pill(type === t)"
        :aria-pressed="type === t"
        @click="setQuery({ type: t })"
      >
        {{ FLAG_LABELS[t] }}
        <span v-if="counts && status === 'OPEN'" :class="ui.muted">{{ counts[t] }}</span>
      </button>
    </div>

    <div v-if="error" :class="[ui.alertError, 'mb-4']" role="alert">{{ error }}</div>

    <div v-if="loading" class="flex flex-col gap-3">
      <div v-for="i in 4" :key="i" :class="[ui.skeleton, 'h-28']" />
    </div>
    <p v-else-if="!flags.length" :class="[ui.card, ui.empty]">
      {{ status === 'OPEN' ? 'Nothing waiting for review.' : 'No flags here yet.' }}
    </p>
    <ul v-else class="flex flex-col gap-3">
      <li
        v-for="f in flags"
        :key="f.id"
        :class="[ui.card, 'flex flex-col justify-between gap-5 px-4 py-4 md:flex-row']"
      >
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <div class="flex flex-wrap items-center gap-2">
            <FlagChip :type="f.type" />
            <span :class="[ui.muted, 'text-[12.5px]']">{{ formatDate(f.transaction.date) }} · {{ f.transaction.accountName }}</span>
          </div>
          <RouterLink :to="`/transactions/${f.transaction.id}`" class="font-semibold hover:underline [overflow-wrap:anywhere]">
            {{ f.transaction.description }}
          </RouterLink>
          <p class="text-slate-600 dark:text-slate-300">{{ f.reason }}</p>
          <div class="flex flex-wrap items-center gap-2">
            <CategoryBadge :category="f.transaction.category" :confidence="f.transaction.categoryConfidence" />
            <span :class="[ui.mono, ui.muted]">{{ f.transaction.externalReference }}</span>
          </div>
          <p v-if="f.status !== 'OPEN'" :class="[ui.muted, 'text-[12.5px]']">
            {{ f.status === 'RESOLVED' ? 'Resolved' : 'Dismissed' }} by {{ f.resolvedBy?.name ?? 'system' }}
            <template v-if="f.resolvedAt"> on {{ formatDateTime(f.resolvedAt) }}</template>
            <template v-if="f.resolutionNote"> — “{{ f.resolutionNote }}”</template>
          </p>
        </div>
        <div class="flex flex-col justify-between gap-3 md:items-end">
          <strong class="text-[17px] tabular-nums" :class="amountClass(f.transaction.direction)">
            {{ formatMoney(f.transaction.amount) }}
          </strong>
          <div class="flex flex-wrap gap-2 md:justify-end">
            <RouterLink :to="`/transactions/${f.transaction.id}`" :class="ui.btnPrimarySm">Review</RouterLink>
            <template v-if="f.status === 'OPEN'">
              <button :class="ui.btnSm" type="button" :disabled="busy === f.id" @click="quickClose(f, 'RESOLVED')">
                Resolve
              </button>
              <button :class="ui.btnGhostSm" type="button" :disabled="busy === f.id" @click="quickClose(f, 'DISMISSED')">
                Dismiss
              </button>
            </template>
          </div>
        </div>
      </li>
    </ul>

    <div v-if="nextCursor && !loading" class="mt-4 flex justify-center">
      <button :class="ui.btn" type="button" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? 'Loading…' : 'Load more' }}
      </button>
    </div>
  </div>
</template>
