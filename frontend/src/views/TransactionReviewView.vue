<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { api, ApiError } from '@/api/client'
import {
  CATEGORIES,
  CATEGORY_LABELS,
  FLAG_LABELS,
  type Category,
  type FlagDetail,
  type TransactionDetail,
} from '@/api/types'
import CategoryBadge from '@/components/CategoryBadge.vue'
import FlagChip from '@/components/FlagChip.vue'
import SelectInput from '@/components/SelectInput.vue'
import { formatDate, formatDateTime, formatMoney, formatPercent, SOURCE_LABELS } from '@/lib/format'
import { amountClass, ui } from '@/lib/ui'

const props = defineProps<{ id: string }>()
const router = useRouter()

const tx = ref<TransactionDetail | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)

const correction = reactive<{ category: Category | ''; note: string }>({ category: '', note: '' })
const saving = ref(false)
const saveError = ref<string[] | null>(null)
const saved = ref<string | null>(null)

const flagNotes = reactive<Record<string, string>>({})
const flagBusy = ref<string | null>(null)
const flagError = ref<string | null>(null)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    tx.value = await api.transaction(props.id)
    correction.category = tx.value.category ?? ''
    correction.note = ''
  } catch (e) {
    loadError.value =
      e instanceof ApiError && e.status === 404 ? 'This transaction does not exist.' : 'Could not load the transaction.'
  } finally {
    loading.value = false
  }
}
watch(() => props.id, load, { immediate: true })

const openFlags = computed(() => tx.value?.flags.filter((f) => f.status === 'OPEN') ?? [])
const closedFlags = computed(() => tx.value?.flags.filter((f) => f.status !== 'OPEN') ?? [])
const isConfirm = computed(() => tx.value && correction.category === tx.value.category)
const canSave = computed(
  () =>
    !!tx.value &&
    correction.category !== '' &&
    (correction.category !== tx.value.category || tx.value.categorySource !== 'MANUAL'),
)

async function saveCorrection() {
  if (!tx.value || !correction.category) return
  saving.value = true
  saveError.value = null
  saved.value = null
  try {
    const before = tx.value.categoryLabel
    tx.value = await api.correctCategory(tx.value.id, {
      category: correction.category,
      note: correction.note.trim() || undefined,
      expectedVersion: tx.value.version,
    })
    saved.value =
      before === tx.value.categoryLabel
        ? `Confirmed as ${tx.value.categoryLabel}.`
        : `Changed from ${before ?? 'uncategorised'} to ${tx.value.categoryLabel}. Future transactions with the same description will follow this decision.`
    correction.note = ''
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      saveError.value = [
        'Someone else changed this transaction while you were reviewing it. The latest version has been loaded.',
      ]
      await load()
    } else {
      saveError.value = e instanceof ApiError ? e.details : ['Could not save the correction']
    }
  } finally {
    saving.value = false
  }
}

async function closeFlag(flag: FlagDetail, status: 'RESOLVED' | 'DISMISSED') {
  flagBusy.value = flag.id
  flagError.value = null
  try {
    await api.resolveFlag(flag.id, { status, note: flagNotes[flag.id]?.trim() || undefined })
    await load()
  } catch (e) {
    flagError.value = e instanceof ApiError ? e.message : 'Could not update the flag'
  } finally {
    flagBusy.value = null
  }
}

function sourceDescription(source: string, provider: string): string {
  if (source === 'RULES') return `Keyword rule (${provider})`
  if (source === 'AI') return `AI model (${provider.replace(/^gemini:/, 'Gemini ')})`
  if (source === 'LEARNED') return 'Reused an earlier decision for the same description'
  if (source === 'FALLBACK') return 'Fallback after the AI failed repeatedly'
  return 'Manual correction'
}

const timelineDot: Record<string, string> = {
  MANUAL: 'bg-blue-600 dark:bg-blue-400',
  FALLBACK: 'bg-amber-500',
}
const dt = 'text-xs font-medium text-slate-500 dark:text-slate-400'
const dd = 'mt-0.5 font-medium'
</script>

<template>
  <div :class="ui.page">
    <nav class="mb-3" aria-label="Breadcrumb">
      <a href="#" :class="ui.link" @click.prevent="router.back()">← Back</a>
    </nav>

    <div v-if="loading && !tx" class="flex flex-col gap-4">
      <div :class="[ui.skeleton, 'h-20']" />
      <div :class="[ui.skeleton, 'h-60']" />
    </div>
    <div v-else-if="loadError" :class="ui.alertError" role="alert">
      {{ loadError }} <RouterLink to="/transactions" class="font-medium underline">Back to transactions</RouterLink>
    </div>

    <template v-else-if="tx">
      <header :class="[ui.card, 'mb-4 flex flex-wrap justify-between gap-6 px-5 py-5']">
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <span :class="[ui.mono, ui.muted]">{{ tx.externalReference }}</span>
          <h1 :class="[ui.h1, '[overflow-wrap:anywhere]']">{{ tx.description }}</h1>
          <div class="flex flex-wrap items-center gap-2">
            <CategoryBadge
              :category="tx.category"
              :source="tx.categorySource"
              :confidence="tx.categoryConfidence"
              :status="tx.classificationStatus"
              show-meta
            />
            <FlagChip v-for="f in openFlags" :key="f.id" :type="f.type" />
          </div>
        </div>
        <div class="flex flex-col gap-0.5 lg:items-end">
          <span :class="ui.muted">{{ tx.direction === 'CREDIT' ? 'Money in' : 'Money out' }}</span>
          <strong class="text-[26px] font-semibold tabular-nums" :class="amountClass(tx.direction)">
            {{ formatMoney(tx.amount) }}
          </strong>
          <span :class="ui.muted">{{ formatDate(tx.date) }}</span>
        </div>
      </header>

      <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
        <div class="flex flex-col gap-4">
          <section
            v-if="openFlags.length"
            :class="[ui.card, '!border-amber-300 dark:!border-amber-800']"
            aria-labelledby="flags-h"
          >
            <div :class="ui.cardHeader">
              <h2 id="flags-h" :class="ui.h2">Why this needs review</h2>
              <span :class="ui.muted">{{ openFlags.length }} open</span>
            </div>
            <div :class="[ui.cardBody, 'flex flex-col gap-4']">
              <div v-if="flagError" :class="ui.alertError" role="alert">{{ flagError }}</div>
              <article
                v-for="f in openFlags"
                :key="f.id"
                class="flex flex-col gap-2 border-b border-slate-200 pb-4 last:border-0 last:pb-0 dark:border-slate-800"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <FlagChip :type="f.type" />
                  <span :class="[ui.muted, 'text-[12.5px]']">Raised {{ formatDateTime(f.createdAt) }}</span>
                </div>
                <p class="text-[14.5px]">{{ f.reason }}</p>
                <p v-if="f.relatedTransactionId" class="text-[12.5px]">
                  <RouterLink :to="`/transactions/${f.relatedTransactionId}`" :class="ui.link">
                    Open the matching transaction →
                  </RouterLink>
                </p>
                <label :class="ui.label" :for="`note-${f.id}`">
                  Note (optional)
                  <input
                    :id="`note-${f.id}`"
                    v-model="flagNotes[f.id]"
                    type="text"
                    maxlength="1000"
                    placeholder="What did you check or decide?"
                    :class="ui.input"
                  />
                </label>
                <div class="flex flex-wrap gap-2">
                  <button
                    :class="ui.btnPrimarySm"
                    type="button"
                    :disabled="flagBusy === f.id"
                    @click="closeFlag(f, 'RESOLVED')"
                  >
                    Mark resolved
                  </button>
                  <button :class="ui.btnSm" type="button" :disabled="flagBusy === f.id" @click="closeFlag(f, 'DISMISSED')">
                    Dismiss as false alarm
                  </button>
                </div>
              </article>
            </div>
          </section>

          <section :class="ui.card" aria-labelledby="class-h">
            <div :class="ui.cardHeader">
              <h2 id="class-h" :class="ui.h2">Classification</h2>
              <span :class="[ui.muted, 'text-[12.5px]']">{{ tx.classificationStatus.toLowerCase() }}</span>
            </div>
            <div :class="[ui.cardBody, 'flex flex-col gap-4']">
              <dl class="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
                <div>
                  <dt :class="dt">Current category</dt>
                  <dd :class="dd">{{ tx.categoryLabel ?? 'Not yet categorised' }}</dd>
                </div>
                <div>
                  <dt :class="dt">Decided by</dt>
                  <dd :class="dd">{{ tx.categorySource ? SOURCE_LABELS[tx.categorySource] : '—' }}</dd>
                </div>
                <div>
                  <dt :class="dt">Confidence</dt>
                  <dd :class="dd">
                    {{ tx.categorySource === 'MANUAL' ? 'Confirmed by a person' : formatPercent(tx.categoryConfidence) }}
                  </dd>
                </div>
                <div v-if="tx.classification.original">
                  <dt :class="dt">Original automated decision</dt>
                  <dd :class="dd">
                    {{ tx.classification.original.categoryLabel }}
                    <span :class="ui.muted">({{ formatPercent(tx.classification.original.confidence) }})</span>
                  </dd>
                </div>
              </dl>
              <p v-if="tx.classification.correction" :class="ui.alertInfo">
                Corrected by <strong>{{ tx.classification.correction.by?.name ?? 'a reviewer' }}</strong>
                on {{ formatDateTime(tx.classification.correction.at) }}
                <template v-if="tx.classification.correction.from">
                  (was {{ CATEGORY_LABELS[tx.classification.correction.from] }})</template
                ><template v-if="tx.classification.correction.note">: “{{ tx.classification.correction.note }}”</template>
              </p>
              <p
                v-if="tx.classification.lastError && tx.classificationStatus !== 'CLASSIFIED'"
                :class="ui.alertError"
              >
                Last attempt failed: {{ tx.classification.lastError }}
              </p>

              <form
                class="flex flex-col gap-2.5 border-t border-slate-200 pt-3.5 dark:border-slate-800"
                @submit.prevent="saveCorrection"
              >
                <h3 class="text-sm font-semibold">Correct or confirm the category</h3>
                <div class="flex flex-wrap items-end gap-2.5">
                  <label :class="ui.label" for="category">
                    Category
                    <SelectInput id="category" v-model="correction.category" required>
                      <option value="" disabled>Choose…</option>
                      <option v-for="c in CATEGORIES" :key="c" :value="c">{{ CATEGORY_LABELS[c] }}</option>
                    </SelectInput>
                  </label>
                  <label :class="[ui.label, 'min-w-[200px] flex-1']" for="note">
                    Reason (optional)
                    <input
                      id="note"
                      v-model="correction.note"
                      type="text"
                      maxlength="1000"
                      placeholder="e.g. This is the shop rent"
                      :class="ui.input"
                    />
                  </label>
                  <button :class="ui.btnPrimary" type="submit" :disabled="!canSave || saving">
                    {{ saving ? 'Saving…' : isConfirm ? 'Confirm category' : 'Save correction' }}
                  </button>
                </div>
                <p :class="[ui.muted, 'text-[12.5px]']">
                  The original automated decision is kept in the history below; your name and the time are recorded.
                </p>
                <div v-if="saveError" :class="ui.alertError" role="alert">
                  <span v-for="m in saveError" :key="m">{{ m }}</span>
                </div>
                <div v-if="saved" :class="ui.alertSuccess" role="status">{{ saved }}</div>
              </form>
            </div>
          </section>

          <section :class="ui.card" aria-labelledby="hist-h">
            <div :class="ui.cardHeader">
              <h2 id="hist-h" :class="ui.h2">Decision history</h2>
              <span :class="[ui.muted, 'text-[12.5px]']">Oldest first · every automated and manual decision</span>
            </div>
            <div :class="ui.cardBody">
              <p v-if="!tx.classification.history.length" :class="ui.empty">
                No decisions yet — waiting for classification.
              </p>
              <ol v-else class="flex flex-col gap-4 border-l-2 border-slate-200 pl-4 dark:border-slate-700">
                <li v-for="e in tx.classification.history" :key="e.id" class="relative flex flex-col gap-0.5">
                  <span
                    class="absolute -left-[22px] top-1.5 size-2.5 rounded-full ring-2 ring-white dark:ring-slate-900"
                    :class="timelineDot[e.source] ?? 'bg-emerald-600 dark:bg-emerald-400'"
                    aria-hidden="true"
                  />
                  <div class="flex flex-wrap items-center gap-x-2">
                    <strong>{{ e.categoryLabel }}</strong>
                    <span v-if="e.previousCategory" :class="ui.muted">from {{ CATEGORY_LABELS[e.previousCategory] }}</span>
                    <span :class="ui.muted">· {{ sourceDescription(e.source, e.provider) }}</span>
                    <span v-if="e.confidence !== null && e.source !== 'MANUAL'" :class="ui.muted">
                      · {{ formatPercent(e.confidence) }}
                    </span>
                  </div>
                  <p v-if="e.rationale" class="my-0.5 text-[13px] text-slate-600 dark:text-slate-300">“{{ e.rationale }}”</p>
                  <span :class="[ui.muted, 'text-[12.5px]']">
                    {{ formatDateTime(e.createdAt) }}<template v-if="e.actor"> · {{ e.actor.name }} ({{ e.actor.email }})</template>
                  </span>
                </li>
              </ol>
            </div>
          </section>
        </div>

        <aside class="flex flex-col gap-4">
          <section :class="ui.card" aria-labelledby="details-h">
            <div :class="ui.cardHeader"><h2 id="details-h" :class="ui.h2">Details</h2></div>
            <dl :class="[ui.cardBody, 'flex flex-col gap-2.5']">
              <div>
                <dt :class="dt">Account</dt>
                <dd :class="dd">
                  {{ tx.account.name }}<br />
                  <span :class="ui.muted">{{ tx.account.bankName }} {{ tx.account.accountNumberMasked }}</span>
                </dd>
              </div>
              <div>
                <dt :class="dt">Amount</dt>
                <dd :class="[dd, 'tabular-nums']">
                  {{ formatMoney(tx.amount) }}<br />
                  <span :class="[ui.mono, ui.muted]">{{ tx.amount.minor }} kobo</span>
                </dd>
              </div>
              <div>
                <dt :class="dt">Direction</dt>
                <dd :class="dd">{{ tx.direction === 'CREDIT' ? 'Credit (money in)' : 'Debit (money out)' }}</dd>
              </div>
              <div>
                <dt :class="dt">Date</dt>
                <dd :class="dd">{{ formatDateTime(tx.date) }}</dd>
              </div>
              <div>
                <dt :class="dt">Merchant</dt>
                <dd :class="dd">{{ tx.merchant ?? '—' }}</dd>
              </div>
              <div>
                <dt :class="dt">Reference</dt>
                <dd :class="[dd, ui.mono]">{{ tx.externalReference }}</dd>
              </div>
              <div>
                <dt :class="dt">Imported</dt>
                <dd :class="dd">{{ formatDateTime(tx.createdAt) }}</dd>
              </div>
            </dl>
          </section>

          <section v-if="closedFlags.length" :class="ui.card" aria-labelledby="closed-h">
            <div :class="ui.cardHeader"><h2 id="closed-h" :class="ui.h2">Closed flags</h2></div>
            <ul :class="[ui.cardBody, 'flex flex-col gap-2.5']">
              <li v-for="f in closedFlags" :key="f.id">
                <strong>{{ FLAG_LABELS[f.type] }}</strong>
                <span :class="ui.muted"> — {{ f.status.toLowerCase() }}</span>
                <span v-if="f.resolvedBy || f.resolvedAt" :class="[ui.muted, 'text-[12.5px]']">
                  by {{ f.resolvedBy?.name ?? 'system' }}<template v-if="f.resolvedAt">, {{ formatDateTime(f.resolvedAt) }}</template>
                </span>
                <p v-if="f.resolutionNote" class="mt-0.5 text-[12.5px]">“{{ f.resolutionNote }}”</p>
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </template>
  </div>
</template>
