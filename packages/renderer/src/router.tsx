import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { createHashHistory } from '@tanstack/history'
import { lazy, Suspense } from 'react'
import AppLayout from './layout/AppLayout'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Agent = lazy(() => import('./pages/Agent'))
const Logs = lazy(() => import('./pages/Logs'))
const Presets = lazy(() => import('./pages/Presets'))
const Settings = lazy(() => import('./settings/Settings'))

const rootRoute = createRootRoute({
  component: () => (
    <Suspense fallback={<div className="p-4">Loading...</div>}>
      <AppLayout />
    </Suspense>
  ),
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => (
    <Suspense fallback={<div className="p-4">Loading...</div>}>
      <Dashboard />
    </Suspense>
  ),
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: () => (
    <Suspense fallback={<div className="p-4">Loading...</div>}>
      <Settings />
    </Suspense>
  ),
})

const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agent',
  component: () => (
    <Suspense fallback={<div className="p-4">Loading...</div>}>
      <Agent />
    </Suspense>
  ),
})

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logs',
  component: () => (
    <Suspense fallback={<div className="p-4">Loading...</div>}>
      <Logs />
    </Suspense>
  ),
})

const presetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/presets',
  component: () => (
    <Suspense fallback={<div className="p-4">Loading...</div>}>
      <Presets />
    </Suspense>
  ),
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  agentRoute,
  logsRoute,
  presetsRoute,
  settingsRoute,
])

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
})

export function AppRouter() {
  return <RouterProvider router={router} />
}

