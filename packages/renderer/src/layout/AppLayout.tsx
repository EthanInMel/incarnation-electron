import { PropsWithChildren } from 'react'
import { Outlet, Link } from '@tanstack/react-router'
import { Box, Flex, Heading, Separator } from '@radix-ui/themes'

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="px-3 py-2 rounded text-sm hover:bg-gray-700/40 data-[status=active]:bg-gray-700/60"
      activeProps={{
        'data-status': 'active',
      }}
    >
      {label}
    </Link>
  )
}

export default function AppLayout(_props: PropsWithChildren) {
  return (
    <Flex className="h-full min-h-screen">
      <Box className="w-56 bg-gray-800/40 border-r border-gray-700/40 p-3">
        <Heading size="4" mb="3">Incarnation</Heading>
        <nav className="flex flex-col gap-1">
          <NavItem to="/" label="Dashboard" />
          <NavItem to="/agent" label="Agent" />
          <NavItem to="/logs" label="Logs" />
          <NavItem to="/presets" label="Presets" />
          <NavItem to="/llm" label="LLM History" />
          <NavItem to="/sessions" label="Sessions" />
          <NavItem to="/card-hints" label="Card Hints" />
          <Separator my="2" size="4" />
          <NavItem to="/settings" label="Settings" />
        </nav>
      </Box>
      <Box asChild className="flex-1 overflow-auto">
        <main>
          <Outlet />
        </main>
      </Box>
    </Flex>
  )
}

