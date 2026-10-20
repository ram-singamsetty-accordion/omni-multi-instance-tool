import { useEffect, useLayoutEffect, useRef } from 'react';
import { Route, Routes, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './lib/api';
import { clearDashboardCaches } from './lib/dashboardCache';
import Unlock from './pages/Unlock';
import Dashboard from './pages/Dashboard';
import Instances from './pages/Instances';
import Migrate from './pages/Migrate';
import Documents from './pages/Documents';
import JobDetail from './pages/JobDetail';
import History from './pages/History';
import Settings from './pages/Settings';

export default function App() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // <main> is the scroll container (the window never scrolls), so reset it on navigation.
  useLayoutEffect(() => { mainRef.current?.scrollTo(0, 0); }, [pathname]);
  // Retries ride out the dev-server startup race.
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['unlock-status'],
    queryFn: api.unlockStatus,
    retry: 8,
    retryDelay: 500,
  });

  // Covers the Lock button, a server restart and a lock from another tab: the localStorage dashboard snapshot holds
  // every embed user's email, so drop it and every cached query. Not qc.clear(): Unlock invalidates 'unlock-status'.
  const unlocked = data?.unlocked;
  useEffect(() => {
    if (unlocked === false) {
      clearDashboardCaches();
      qc.removeQueries({ predicate: q => q.queryKey[0] !== 'unlock-status' });
    }
  }, [unlocked, qc]);

  if (isLoading) return <div className="p-8 text-zinc-400">loading…</div>;

  // A failed background refetch keeps `data`; only fall back to the error screen when there is nothing to show.
  if (isError && !data) {
    return (
      <div className="p-8 space-y-3">
        <div className="text-sm text-red-400">Cannot reach the server. {(error as Error).message}</div>
        <button
          className="text-sm underline text-zinc-300 disabled:opacity-40"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data?.unlocked) return <Unlock vaultExists={data?.vaultExists ?? false} />;

  return (
    <div className="h-screen flex overflow-hidden">
      <aside className="w-48 shrink-0 border-r border-zinc-800 flex flex-col h-full">
        <div className="px-4 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-blue-500 shrink-0" />
            <span className="text-sm font-semibold text-zinc-100 leading-tight">Omni Multi-Instance</span>
          </div>
        </div>
        <nav className="flex-1 py-3 flex flex-col gap-0.5 px-2">
          <SideNavLink to="/dashboard">Dashboard</SideNavLink>
          <SideNavLink to="/migrate">Migrate</SideNavLink>
          <SideNavLink to="/documents">Documents</SideNavLink>
          <SideNavLink to="/instances">Instances</SideNavLink>
          <SideNavLink to="/history">Migration History</SideNavLink>
        </nav>
        <div className="py-3 flex flex-col gap-0.5 px-2 border-t border-zinc-800">
          <SideNavLink to="/settings">Settings</SideNavLink>
          <button
            className="w-full text-left px-3 py-1.5 rounded text-sm text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50 transition-colors"
            onClick={async () => {
              await api.lock();
              await qc.invalidateQueries({ queryKey: ['unlock-status'] });
              nav('/');
            }}
          >
            Lock vault
          </button>
        </div>
      </aside>
      <main ref={mainRef} className="flex-1 overflow-auto p-6">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/migrate" element={<Migrate />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/instances" element={<Instances />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/jobs" element={<Navigate to="/history" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function SideNavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `py-1.5 rounded text-sm transition-colors ${
          isActive
            ? 'pl-[10px] pr-3 bg-zinc-800/70 text-white border-l-2 border-blue-400'
            : 'px-3 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
        }`
      }
    >
      {children}
    </NavLink>
  );
}
