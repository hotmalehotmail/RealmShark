import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ConfigWindow from './ConfigWindow'
import { installConsoleCapture } from './consoleLog'

installConsoleCapture()

const isConfigWindow = window.location.hash === '#config'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isConfigWindow ? <ConfigWindow /> : <App />}</StrictMode>
)
