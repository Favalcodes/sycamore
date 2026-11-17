# Frontend — Transaction Intelligence

Vue 3 · TypeScript · Vite · Tailwind CSS 4 · Vue Router · Pinia. Styling is Tailwind utility classes only (shared class strings in `src/lib/ui.ts`); there is no custom CSS. Three working views: Dashboard, Transactions, Transaction Review (plus a review queue).

```bash
npm install
npm run dev          # http://localhost:5173, proxies /api to http://localhost:3100
npm run test:unit
npm run type-check
npm run build
```

Set `API_PROXY_TARGET` in `.env` if the API runs elsewhere. See the [root README](../README.md).
