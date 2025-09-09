import { useState } from 'react'
import { Button } from '@radix-ui/themes'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-3xl font-bold">Vite + React + TanStack Router + Radix + Tailwind</h1>
      <div className="card">
        <Button onClick={() => setCount((c) => c + 1)}>count is {count}</Button>
        <p className="mt-2 text-sm text-gray-400">
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
    </div>
  )
}

export default App
