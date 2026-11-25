import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App.js'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5000 } } })
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><App /></QueryClientProvider>)

