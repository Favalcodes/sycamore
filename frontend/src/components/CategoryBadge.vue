<script setup lang="ts">
import { computed } from 'vue'
import type { Category, CategorySource, ClassificationStatus } from '@/api/types'
import { CATEGORY_LABELS } from '@/api/types'
import { formatPercent, SOURCE_LABELS } from '@/lib/format'

const props = defineProps<{
  category: Category | null
  source?: CategorySource | null
  confidence?: number | null
  status?: ClassificationStatus
  showMeta?: boolean
}>()

const label = computed(() => {
  if (props.category) return CATEGORY_LABELS[props.category]
  if (props.status === 'PENDING' || props.status === 'PROCESSING') return 'Classifying…'
  return 'Uncategorised'
})

const meta = computed(() => {
  if (!props.showMeta || !props.source) return null
  const source = SOURCE_LABELS[props.source] ?? props.source
  return props.confidence !== null && props.confidence !== undefined && props.source !== 'MANUAL'
    ? `${source} · ${formatPercent(props.confidence)}`
    : source
})

const tone = computed(() => {
  if (!props.category)
    return {
      badge: 'border-slate-200 bg-slate-100 italic text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400',
      dot: 'bg-slate-400',
    }
  if (props.source === 'MANUAL')
    return {
      badge: 'border-transparent bg-blue-50 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300',
      dot: 'bg-blue-600 dark:bg-blue-400',
    }
  if (props.status === 'FAILED')
    return {
      badge: 'border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800',
      dot: 'bg-amber-500',
    }
  return {
    badge: 'border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800',
    dot: 'bg-emerald-600 dark:bg-emerald-400',
  }
})
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[12.5px] font-medium"
    :class="tone.badge"
    :title="meta ?? undefined"
  >
    <span class="size-[7px] rounded-full" :class="tone.dot" aria-hidden="true" />
    {{ label }}
    <span v-if="meta" class="font-normal text-slate-500 dark:text-slate-400">{{ meta }}</span>
  </span>
</template>
