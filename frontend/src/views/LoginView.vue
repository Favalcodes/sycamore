<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError } from '@/api/client'
import PasswordInput from '@/components/PasswordInput.vue'
import { useAuthStore } from '@/stores/auth'
import { ui } from '@/lib/ui'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const email = ref('')
const password = ref('')
const error = ref<string | null>(route.query.expired ? 'Your session expired. Please sign in again.' : null)
const submitting = ref(false)

async function submit() {
  error.value = null
  submitting.value = true
  try {
    await auth.login(email.value, password.value)
    const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : '/dashboard'
    await router.replace(next)
  } catch (e) {
    error.value =
      e instanceof ApiError && e.status === 429
        ? 'Too many attempts. Wait a minute and try again.'
        : e instanceof ApiError
          ? e.message
          : 'Sign-in failed'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="grid min-h-screen place-items-center px-4 py-6">
    <form :class="[ui.card, 'flex w-full max-w-[400px] flex-col gap-4 p-7']" novalidate @submit.prevent="submit">
      <div class="mb-1 flex flex-col items-center gap-1.5 text-center">
        <span class="mb-1 grid size-10 place-items-center rounded-[10px] bg-emerald-700 text-xl font-bold text-white" aria-hidden="true">₦</span>
        <h1 :class="ui.h1">Transaction Intelligence</h1>
        <p :class="ui.muted">Sign in to review your organisation's transactions.</p>
      </div>

      <div v-if="error" :class="ui.alertError" role="alert">{{ error }}</div>

      <label :class="ui.label" for="email">
        Email
        <input id="email" v-model="email" type="email" autocomplete="username" required autofocus :class="ui.input" />
      </label>
      <label :class="ui.label" for="password">
        Password
        <PasswordInput id="password" v-model="password" />
      </label>

      <button :class="ui.btnPrimary" type="submit" :disabled="submitting || !email || !password">
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </button>

      <details class="text-[13px] text-slate-500 dark:text-slate-400">
        <summary class="cursor-pointer">Demo accounts</summary>
        <p class="mt-2 leading-7">
          Password for all: <code :class="ui.mono">Password123!</code><br />
          <code :class="ui.mono">amaka@ofada.test</code> — Ofada Kitchen Supplies<br />
          <code :class="ui.mono">hauwa@kanem.test</code> — Kanem Logistics
        </p>
      </details>
    </form>
  </div>
</template>
