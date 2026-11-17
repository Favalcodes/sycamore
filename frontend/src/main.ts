import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { setUnauthorizedHandler } from './api/client'
import { useAuthStore } from './stores/auth'
import './styles.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)

// An expired or revoked token sends the user back to sign in.
setUnauthorizedHandler(() => {
  useAuthStore().logout()
  void router.push({ name: 'login', query: { next: router.currentRoute.value.fullPath, expired: '1' } })
})

app.mount('#app')
