import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useStore, type View } from './store'
import './index.css'

useStore.getState().initBridge()

// Dev harness: lets the main process drive the visible view for UI screenshots
// (electron . --ui-shot writes PNGs of every view).
const win = window as unknown as Record<string, unknown>
win.__setView = (v: string) => useStore.getState().setView(v as View)

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
