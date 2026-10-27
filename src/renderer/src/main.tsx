import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import 'pretendard/dist/web/variable/pretendardvariable.css'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('root element not found')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
