<script setup lang="ts">
import { ui } from '@/lib/ui'

defineOptions({ inheritAttrs: false })
defineProps<{ fullWidth?: boolean }>()
const model = defineModel<string>({ required: true })
</script>

<template>
  <!-- Native select for accessibility and mobile pickers; browser arrow replaced by a matching chevron. -->
  <div class="relative" :class="fullWidth === false ? 'inline-block' : 'block w-full'">
    <select
      v-model="model"
      v-bind="$attrs"
      :class="[ui.input, 'cursor-pointer appearance-none truncate pr-9']"
    >
      <slot />
    </select>
    <svg
      class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-500 dark:text-slate-400"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fill-rule="evenodd"
        d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
        clip-rule="evenodd"
      />
    </svg>
  </div>
</template>
