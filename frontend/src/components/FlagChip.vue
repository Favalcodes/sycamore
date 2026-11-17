<script setup lang="ts">
import type { FlagType } from '@/api/types'
import { FLAG_LABELS } from '@/api/types'

defineProps<{ type: FlagType; count?: number }>()

const danger = 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300'
const warn = 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
const tone: Record<FlagType, string> = {
  POSSIBLE_DUPLICATE: danger,
  LARGE_AMOUNT: danger,
  LOW_CONFIDENCE: warn,
  UNEXPECTED_CATEGORY: warn,
  CLASSIFICATION_FAILED: warn,
}
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold"
    :class="tone[type]"
  >
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 1.5a.75.75 0 0 1 .75.75v.5h8.13a.6.6 0 0 1 .5.93L11 6l1.38 2.32a.6.6 0 0 1-.5.93H3.75v4.5a.75.75 0 0 1-1.5 0V2.25A.75.75 0 0 1 3 1.5Z"
      />
    </svg>
    {{ FLAG_LABELS[type] }}<template v-if="count !== undefined"> · {{ count }}</template>
  </span>
</template>
