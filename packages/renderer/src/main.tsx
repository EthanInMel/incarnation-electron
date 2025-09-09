import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AppRouter } from './router'
import { Theme, ThemePanel } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme appearance="dark" radius="large">
      <AppRouter />
      {import.meta.env.DEV ? <ThemePanel defaultOpen /> : null}
    </Theme>
  </StrictMode>,
)
