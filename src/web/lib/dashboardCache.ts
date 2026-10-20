import type { QueryClient } from '@tanstack/react-query';

export const DASHBOARD_LS = {
  connections: 'dashboard:cache:connections',
  users: 'dashboard:cache:users',
  excluded: (id: string) => `dashboard:excluded:${id}`,
};

export function clearDashboardCaches(): void {
  try {
    localStorage.removeItem(DASHBOARD_LS.connections);
    localStorage.removeItem(DASHBOARD_LS.users);
  } catch {
    /* storage unavailable */
  }
}

// Drop both layers: the localStorage seed and the in-memory queries, so the next Dashboard mount fetches.
export function resetDashboardCache(qc: QueryClient): void {
  clearDashboardCaches();
  qc.removeQueries({ queryKey: ['dashboard-stats'] });
  qc.removeQueries({ queryKey: ['dashboard-embed-users'] });
}
