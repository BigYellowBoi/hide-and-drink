import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/space-grotesk/latin-600.css'
import '@fontsource/space-grotesk/latin-700.css'
import './index.css'
import App from './App.tsx'

// Home-screen app detection. The display-mode query needs a manifest; navigator.standalone is iOS's own flag.
const standalone =
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
document.documentElement.classList.toggle('standalone', standalone)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
