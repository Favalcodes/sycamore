<script setup lang="ts">
import { ref } from 'vue'
import { ui } from '@/lib/ui'

defineProps<{ id: string; autocomplete?: string }>()
const model = defineModel<string>({ required: true })
const visible = ref(false)
</script>

<template>
  <div class="relative flex">
    <input
      :id="id"
      v-model="model"
      :type="visible ? 'text' : 'password'"
      :autocomplete="autocomplete ?? 'current-password'"
      required
      :class="[ui.input, 'pr-11']"
    />
    <button
      type="button"
      class="absolute right-1 top-1/2 grid h-[30px] w-8 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
      :aria-label="visible ? 'Hide password' : 'Show password'"
      :aria-pressed="visible"
      :aria-controls="id"
      @click="visible = !visible"
    >
      <svg v-if="!visible" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"
        />
        <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8" />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.7 17.7 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"
        />
      </svg>
    </button>
  </div>
</template>
