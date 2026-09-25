import React from 'react'
import { createRoot } from 'react-dom/client'
import { Widget } from './widget/Widget'
import { useStore } from './store'
import './index.css'

useStore.getState().initBridge()

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(
  <React.StrictMode>
    <Widget />
  </React.StrictMode>
)
