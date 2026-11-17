import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, setToken } from '@/api/client'
import type { Session } from '@/api/types'

const STORAGE_KEY = 'tip.session'

function readStored(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

function writeStored(session: Session | null) {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage unavailable (private mode): the session lasts for this tab only.
  }
}

export const useAuthStore = defineStore('auth', () => {
  const session = ref<Session | null>(readStored())
  setToken(session.value?.accessToken ?? null)

  const isAuthenticated = computed(() => session.value !== null)
  const user = computed(() => session.value?.user ?? null)
  const organisation = computed(() => session.value?.organisation ?? null)

  async function login(email: string, password: string) {
    const result = await api.login(email, password)
    session.value = result
    setToken(result.accessToken)
    writeStored(result)
  }

  function logout() {
    session.value = null
    setToken(null)
    writeStored(null)
  }

  return { session, isAuthenticated, user, organisation, login, logout }
})
