import { createRoot } from 'react-dom/client'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('#root が存在しません')

// 意図的に <StrictMode> で包んでいない。effect が二重に走ると wasm エンジンの起動が
// 2 回になり、数百メガバイトと数十秒を無駄に消費するため。
createRoot(container).render(<App />)
