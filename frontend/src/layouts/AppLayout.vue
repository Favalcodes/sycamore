<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { api } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { ui } from '@/lib/ui'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const openFlags = ref<number | null>(null)
const menuOpen = ref(false)

async function refreshCount() {
  try {
    openFlags.value = (await api.reviewSummary()).open
  } catch {
    openFlags.value = null
  }
}

onMounted(refreshCount)
// Keep the badge honest after reviewers act on flags.
watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false
    void refreshCount()
  },
)

function logout() {
  auth.logout()
  void router.push({ name: 'login' })
}

const navLink =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white'
const navActive = '!bg-emerald-50 !text-emerald-800 dark:!bg-emerald-950/60 dark:!text-emerald-300'
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header
      class="sticky top-0 z-10 flex h-[60px] items-center gap-3 border-b border-slate-200 bg-white px-4 md:gap-6 md:px-7 dark:border-slate-800 dark:bg-slate-900"
    >
      <button
        :class="[ui.btnGhostSm, 'md:hidden']"
        type="button"
        :aria-expanded="menuOpen"
        aria-controls="primary-nav"
        @click="menuOpen = !menuOpen"
      >
        <span class="sr-only">Menu</span>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <RouterLink to="/dashboard" class="flex items-center gap-2.5 whitespace-nowrap font-semibold">
        <span class="grid size-7 place-items-center rounded-lg bg-emerald-700 font-bold text-white" aria-hidden="true">₦</span>
        <span class="hidden md:inline">Transaction Intelligence</span>
      </RouterLink>
      <nav
        id="primary-nav"
        aria-label="Primary"
        class="absolute inset-x-0 top-[60px] flex-col gap-1 border-b border-slate-200 bg-white px-4 pb-3 pt-2 md:static md:flex md:flex-1 md:flex-row md:border-0 md:bg-transparent md:p-0 dark:border-slate-800 dark:bg-slate-900 md:dark:bg-transparent"
        :class="menuOpen ? 'flex' : 'hidden'"
      >
        <RouterLink to="/dashboard" :class="navLink" :active-class="navActive">Dashboard</RouterLink>
        <RouterLink to="/transactions" :class="navLink" :active-class="navActive">Transactions</RouterLink>
        <RouterLink to="/review" :class="navLink" :active-class="navActive">
          Review
          <span
            v-if="openFlags"
            class="min-w-5 rounded-full bg-red-600 px-1.5 text-center text-[11.5px] font-bold leading-5 text-white"
            :aria-label="`${openFlags} open flags`"
          >
            {{ openFlags >= 100 ? '99+' : openFlags }}
          </span>
        </RouterLink>
      </nav>
      <div class="ml-auto flex items-center gap-3.5 md:ml-0">
        <div class="hidden flex-col items-end text-[13px] leading-tight md:flex">
          <strong>{{ auth.organisation?.name }}</strong>
          <span :class="ui.muted">{{ auth.user?.name }}</span>
        </div>
        <button :class="ui.btnSm" type="button" @click="logout">Sign out</button>
      </div>
    </header>
    <main class="flex-1">
      <RouterView />
    </main>
  </div>
</template>
