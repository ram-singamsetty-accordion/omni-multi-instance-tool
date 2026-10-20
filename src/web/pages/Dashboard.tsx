import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  BarChart as ReBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  LabelList,
  ResponsiveContainer,
} from 'recharts';
import { api } from '../lib/api';
import { DASHBOARD_LS } from '../lib/dashboardCache';
import type { InstancePublic } from '../../shared/types';
import type { ConnectionStat, EmbedUserStat, InstanceDashboardStats, InstanceEmbedUserStats } from '../lib/api';

// --- localStorage helpers ---

const lsKey = {
  excluded: DASHBOARD_LS.excluded,
  connectionsCache: DASHBOARD_LS.connections,
  usersCache: DASHBOARD_LS.users,
};

// An empty snapshot, or one holding only per-instance error rows (Omni was unreachable), is never seeded:
// with staleTime Infinity it would stand in for a fetch forever.
const hasUsableRow = (data: unknown): boolean =>
  Array.isArray(data) && data.some(r => !(r as { error?: unknown }).error);

function lsGetCache<T>(key: string): { data: T; fetchedAt: number } | null {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as { data: T; fetchedAt: number }) : null;
    return parsed && hasUsableRow(parsed.data) ? parsed : null;
  } catch {
    return null;
  }
}

function lsSetCache<T>(key: string, data: T, fetchedAt: number): void {
  try {
    if (Array.isArray(data) && !hasUsableRow(data)) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ data, fetchedAt }));
  } catch {
    /* quota or storage blocked: skip caching */
  }
}

function formatAgo(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000)); // a future timestamp (clock moved back) reads as 0s
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatElapsed(timestampMs: number): string {
  if (!timestampMs) return 'never fetched';
  return formatAgo(Date.now() - timestampMs);
}

function ElapsedLabel({ timestampMs }: { timestampMs: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="text-xs text-zinc-600">{formatElapsed(timestampMs)}</span>;
}

function lsGetExcluded(instanceId: string): Set<string> {
  try {
    const raw = localStorage.getItem(lsKey.excluded(instanceId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function lsSetExcluded(instanceId: string, excluded: Set<string>): void {
  try {
    localStorage.setItem(lsKey.excluded(instanceId), JSON.stringify([...excluded]));
  } catch {
    /* quota or storage blocked: the exclusion lasts for this session only */
  }
}

// An instance seeded outside the API can hold an unparseable base URL; a throw here would blank the whole app.
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url || '(no url)';
  }
}

// --- Date range helpers ---

// <input type="date"> yields 'YYYY-MM-DD'; new Date(that) is UTC midnight, so build local-time bounds instead.
function startOfDay(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 0, 0, 0, 0);
}

function endOfDay(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 23, 59, 59, 999);
}

function DateRangePicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-zinc-500 shrink-0">Date range:</span>
      <input
        type="date"
        value={from}
        onChange={e => onChange(e.target.value, to)}
        className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-zinc-200 focus:outline-none focus:border-blue-500/60 [color-scheme:dark]"
      />
      <span className="text-zinc-600">–</span>
      <input
        type="date"
        value={to}
        onChange={e => onChange(from, e.target.value)}
        className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-zinc-200 focus:outline-none focus:border-blue-500/60 [color-scheme:dark]"
      />
      {(from || to) && (
        <button onClick={() => onChange('', '')} className="text-zinc-600 hover:text-zinc-400 ml-1">
          clear
        </button>
      )}
      {from && to && from > to && <span className="text-amber-500/70">start is after end</span>}
    </div>
  );
}

// --- Query helpers ---

// Both routes answer 200 with a per-instance `error` row when one instance fails. Keep that instance's last good
// row (flagged with refreshError) so a transient failure does not wipe it from memory and from the localStorage cache.
function withLastGood<T extends { instanceId: string; error?: string; refreshError?: string }>(fresh: T[], prev: T[] | undefined): T[] {
  return fresh.map(f => {
    if (!f.error) return f;
    const old = prev?.find(p => p.instanceId === f.instanceId && !p.error);
    return old ? { ...old, refreshError: f.error } : f;
  });
}

// Shared by the Connections tab and the Users tab (same ['dashboard-stats'] key).
const fetchStats = (qc: QueryClient) => async () =>
  withLastGood(await api.getDashboardStats(), qc.getQueryData<InstanceDashboardStats[]>(['dashboard-stats']));

const fetchEmbedUsers = (qc: QueryClient) => async () =>
  withLastGood(await api.getEmbedUserStats(), qc.getQueryData<InstanceEmbedUserStats[]>(['dashboard-embed-users']));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

// A failed refetch keeps `data`, so show the failure above the stale data instead of replacing the tab.
function RefreshErrorBanner({ error, updatedAt }: { error: unknown; updatedAt: number }) {
  return (
    <div className="text-red-400 text-xs">
      Refresh failed: {errorMessage(error)}
      {updatedAt > 0 && ` (showing data from ${formatElapsed(updatedAt)})`}
    </div>
  );
}

function LoadErrorWithRetry({ what, error, onRetry, retrying }: { what: string; error: unknown; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="flex items-center gap-3 text-sm text-red-400">
      <span>Failed to load {what}: {errorMessage(error)}</span>
      <button
        className="text-xs text-zinc-300 hover:text-zinc-100 underline disabled:opacity-40"
        onClick={onRetry}
        disabled={retrying}
      >
        {retrying ? 'retrying…' : 'Retry'}
      </button>
    </div>
  );
}

// --- Dashboard ---

type DashTab = 'connections' | 'users';

export default function Dashboard() {
  const nav = useNavigate();
  const [activeTab, setActiveTab] = useState<DashTab>('connections');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 border-b border-zinc-800">
        <TabButton label="Connections" active={activeTab === 'connections'} onClick={() => setActiveTab('connections')} />
        <TabButton label="Users" active={activeTab === 'users'} onClick={() => setActiveTab('users')} />
      </div>
      {activeTab === 'connections' ? <ConnectionsTab nav={nav} /> : <UsersTab nav={nav} />}
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-blue-400 text-blue-300'
          : 'border-transparent text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {label}
    </button>
  );
}

// --- Connections Tab ---

function ConnectionsTab({ nav }: { nav: ReturnType<typeof useNavigate> }) {
  const qc = useQueryClient();
  const [cached] = useState(() => lsGetCache<InstanceDashboardStats[]>(lsKey.connectionsCache));
  const { data: instances } = useQuery<InstancePublic[]>({ queryKey: ['instances'], queryFn: api.listInstances, staleTime: Infinity });
  const { data: allData, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: fetchStats(qc),
    staleTime: Infinity,
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.fetchedAt,
  });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [globalSearch, setGlobalSearch] = useState('');
  const [search, setSearch] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<Record<string, Set<string>>>({});

  useEffect(() => {
    if (!allData) return;
    lsSetCache(lsKey.connectionsCache, allData, dataUpdatedAt);
    setExcluded(prev => {
      const next: Record<string, Set<string>> = { ...prev };
      for (const inst of allData) {
        if (!next[inst.instanceId]) {
          next[inst.instanceId] = lsGetExcluded(inst.instanceId);
        }
      }
      return next;
    });
  }, [allData, dataUpdatedAt]);

  const data = allData;

  const toggleExpand = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleExclude = (instanceId: string, connectionId: string) => {
    setExcluded(prev => {
      const set = new Set(prev[instanceId] ?? []);
      set.has(connectionId) ? set.delete(connectionId) : set.add(connectionId);
      lsSetExcluded(instanceId, set);
      return { ...prev, [instanceId]: set };
    });
  };

  if (isLoading) return <div className="text-zinc-400 text-sm">Loading…</div>;

  if (error && (!data || data.length === 0)) {
    return <LoadErrorWithRetry what="stats" error={error} onRetry={() => void refetch()} retrying={isFetching} />;
  }

  if (!data || data.length === 0) {
    const hasInstances = instances && instances.length > 0;
    const allDisabled = hasInstances && instances.every(i => i.dashboardTabs && !i.dashboardTabs.includes('connections'));
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <p className="text-zinc-400 text-sm">
          {allDisabled
            ? 'No instances are enabled for the Connections tab. Configure them from the Instances tab.'
            : 'No instances configured.'}
        </p>
        <button
          className="px-4 py-2 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded disabled:opacity-40"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          className="px-4 py-2 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded"
          onClick={() => nav('/instances')}
        >
          Go to Instances →
        </button>
      </div>
    );
  }

  const totalConnections = data.reduce((sum, i) => {
    const ex = excluded[i.instanceId] ?? new Set();
    return sum + i.connections.filter(c => !ex.has(c.id) && !c.filtered).length;
  }, 0);
  const totalFilteredConnections = data.reduce((sum, i) => sum + (i.filteredCount ?? 0), 0);
  const totalMissing = data.reduce((sum, i) => {
    const ex = excluded[i.instanceId] ?? new Set();
    return sum + i.connections.filter(c => !c.hasSchemaModel && !ex.has(c.id) && !c.filtered).length;
  }, 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-zinc-200 font-semibold text-lg">Connections</h2>
        <div className="flex items-center gap-2">
          <button
            className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? 'refreshing…' : 'refresh'}
          </button>
          <ElapsedLabel timestampMs={dataUpdatedAt} />
        </div>
      </div>

      {error && <RefreshErrorBanner error={error} updatedAt={dataUpdatedAt} />}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="Instances" value={data.length} />
        <StatCard label="Total Connections" value={totalConnections} filtered={totalFilteredConnections || undefined} />
        <StatCard label="Missing Schema Model" value={totalMissing} highlight={totalMissing > 0} />
      </div>

      <input
        type="search"
        value={globalSearch}
        onChange={e => setGlobalSearch(e.target.value)}
        placeholder="Search all connections across instances…"
        className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/20"
      />

      {globalSearch.trim() ? (
        <GlobalConnectionResults
          data={data}
          excluded={excluded}
          query={globalSearch.trim()}
          onToggleExclude={toggleExclude}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {data.map(inst => (
            <InstanceCard
              key={inst.instanceId}
              inst={inst}
              isExpanded={expanded.has(inst.instanceId)}
              onToggleExpand={() => toggleExpand(inst.instanceId)}
              search={search[inst.instanceId] ?? ''}
              onSearchChange={v => setSearch(prev => ({ ...prev, [inst.instanceId]: v }))}
              excludedIds={excluded[inst.instanceId] ?? new Set()}
              onToggleExclude={connId => toggleExclude(inst.instanceId, connId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Users Tab ---

const ALL_EMBED_USERS_GROUP = 'All Embed Users';
const NO_GROUP = '(No Group)';

// Real entities only: the synthetic NO_GROUP bucket is not an entity.
const entityKeysOf = (users: EmbedUserStat[], sep?: string) =>
  Object.keys(groupUsersByGroup(users, sep)).filter(k => k !== NO_GROUP);

function UsersTab({ nav }: { nav: ReturnType<typeof useNavigate> }) {
  const qc = useQueryClient();
  const [cached] = useState(() => lsGetCache<InstanceEmbedUserStats[]>(lsKey.usersCache));
  const { data: instances } = useQuery<InstancePublic[]>({ queryKey: ['instances'], queryFn: api.listInstances, staleTime: Infinity });
  const {
    data: connectionsData,
    refetch: refetchConnections,
    isFetching: connFetching,
    dataUpdatedAt: connUpdatedAt,
  } = useQuery({ queryKey: ['dashboard-stats'], queryFn: fetchStats(qc), staleTime: Infinity });
  const { data: allData, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['dashboard-embed-users'],
    queryFn: fetchEmbedUsers(qc),
    staleTime: Infinity,
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.fetchedAt,
  });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [globalSearch, setGlobalSearch] = useState('');
  const [search, setSearch] = useState<Record<string, string>>({});
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [drawer, setDrawer] = useState<DrawerData | null>(null);
  const [appDisabled, setAppDisabled] = useState<Set<string>>(new Set());
  const [appDisabledError, setAppDisabledError] = useState<string | null>(null);
  // Saves are chained so POSTs reach the server in click order (each one carries the whole list).
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  // Bumped on every toggle so a slower GET (initial load or post-failure resync) never overwrites a newer local change.
  const appDisabledEdits = useRef(0);

  const resyncAppDisabled = () => {
    const seen = appDisabledEdits.current;
    return api.getAppDisabled()
      .then(r => { if (appDisabledEdits.current === seen) setAppDisabled(new Set(r.keys)); })
      .catch(() => {});
  };

  useEffect(() => {
    void resyncAppDisabled();
  }, []);

  const toggleAppDisabled = (key: string) => {
    const next = new Set(appDisabled);
    next.has(key) ? next.delete(key) : next.add(key);
    appDisabledEdits.current++;
    setAppDisabled(next);
    setAppDisabledError(null);
    const keys = [...next];
    saveChain.current = saveChain.current
      .then(() => api.setAppDisabled(keys))
      .then(() => {}, (err: unknown) => {
        setAppDisabledError(`Could not save 'App off' change: ${err instanceof Error ? err.message : String(err)}`);
        void resyncAppDisabled(); // show what the server actually has, not an unsaved snapshot
      });
  };

  useEffect(() => {
    if (allData) lsSetCache(lsKey.usersCache, allData, dataUpdatedAt);
  }, [allData, dataUpdatedAt]);

  // The connections tab is unmounted here, so persist a refreshed snapshot for its next localStorage seed.
  useEffect(() => {
    if (connectionsData) lsSetCache(lsKey.connectionsCache, connectionsData, connUpdatedAt);
  }, [connectionsData, connUpdatedAt]);

  const data = useMemo(() => {
    const from = dateFrom ? startOfDay(dateFrom).getTime() : null;
    const to = dateTo ? endOfDay(dateTo).getTime() : null;
    if (!allData || (from === null && to === null)) return allData;
    return allData.map(inst => {
      const users = inst.users.filter(u => {
        if (!u.createdAt) return true;
        const t = new Date(u.createdAt).getTime();
        return (from === null || t >= from) && (to === null || t <= to);
      });
      return { ...inst, users, filteredCount: users.filter(u => u.filtered).length };
    });
  }, [allData, dateFrom, dateTo]);

  const toggleExpand = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  if (isLoading) return <div className="text-zinc-400 text-sm">Loading…</div>;

  if (error && (!data || data.length === 0)) {
    return <LoadErrorWithRetry what="users" error={error} onRetry={() => void refetch()} retrying={isFetching} />;
  }

  if (!data || data.length === 0) {
    const hasInstances = instances && instances.length > 0;
    const allDisabled = hasInstances && instances.every(i => i.dashboardTabs && !i.dashboardTabs.includes('users'));
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <p className="text-zinc-400 text-sm">
          {allDisabled
            ? 'No instances are enabled for the Users tab. Configure them from the Instances tab.'
            : 'No instances configured.'}
        </p>
        <button
          className="px-4 py-2 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded disabled:opacity-40"
          onClick={() => { void refetch(); void refetchConnections(); }}
          disabled={isFetching || connFetching}
        >
          {isFetching || connFetching ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          className="px-4 py-2 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded"
          onClick={() => nav('/instances')}
        >
          Go to Instances →
        </button>
      </div>
    );
  }

  const totalUsers = data.reduce((sum, i) => sum + i.users.filter(u => !u.filtered).length, 0);
  const totalFilteredUsers = data.reduce((sum, i) => sum + (i.filteredCount ?? 0), 0);

  const separatorMap = new Map(instances?.map(i => [i.id, i.entityGroupSeparator]) ?? []);
  // Dead entities need both lists, so only instances whose users and connections both loaded get an entry here.
  const connectionStats = new Map(connectionsData?.map(c => [c.instanceId, c]) ?? []);
  const connectionsMap = new Map<string, ConnectionStat[]>();
  for (const inst of data) {
    const stat = connectionStats.get(inst.instanceId);
    if (!inst.error && stat && !stat.error) connectionsMap.set(inst.instanceId, stat.connections);
  }
  // An instance with its Connections tab turned off is not an unknown: it was never asked for connections.
  const connectionsOff = (instanceId: string) => instances?.find(i => i.id === instanceId)?.dashboardTabs?.includes('connections') === false;
  const unknownInstances = data.filter(i => !connectionsMap.has(i.instanceId) && !connectionsOff(i.instanceId)).length;
  const { totalEntities, totalFilteredEntities, totalEntitiesNoUsers, totalFilteredEntitiesNoUsers } = data.reduce(
    (acc, inst) => {
      const sep = separatorMap.get(inst.instanceId);
      const activeKeys = new Set(entityKeysOf(inst.users.filter(u => !u.filtered), sep));
      const filteredKeys = new Set(entityKeysOf(inst.users.filter(u => u.filtered), sep));
      const filteredOnly = [...filteredKeys].filter(k => !activeKeys.has(k)).length;
      const connections = connectionsMap.get(inst.instanceId) ?? [];
      const allEntityKeys = new Set(Object.keys(groupUsersByGroup(inst.users, sep)).map(k => k.toLowerCase()));
      const dead = connections.filter(c => !c.filtered && !allEntityKeys.has(c.name.toLowerCase())).length;
      const deadFiltered = connections.filter(c => c.filtered && !allEntityKeys.has(c.name.toLowerCase())).length;
      return {
        totalEntities: acc.totalEntities + activeKeys.size,
        totalFilteredEntities: acc.totalFilteredEntities + filteredOnly,
        totalEntitiesNoUsers: acc.totalEntitiesNoUsers + dead,
        totalFilteredEntitiesNoUsers: acc.totalFilteredEntitiesNoUsers + deadFiltered,
      };
    },
    { totalEntities: 0, totalFilteredEntities: 0, totalEntitiesNoUsers: 0, totalFilteredEntitiesNoUsers: 0 }
  );
  const noUsersValue = unknownInstances === 0 ? totalEntitiesNoUsers : connectionsMap.size === 0 ? '—' : `${totalEntitiesNoUsers}+`;
  const noUsersTitle = unknownInstances > 0 ? `Connection or user stats unavailable for ${unknownInstances} instance(s)` : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-zinc-200 font-semibold text-lg">Embed Users</h2>
        <div className="flex items-center gap-2">
          <button
            className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
            onClick={() => { void refetch(); void refetchConnections(); }}
            disabled={isFetching || connFetching}
          >
            {isFetching || connFetching ? 'refreshing…' : 'refresh'}
          </button>
          <span className="text-xs text-zinc-600">users</span>
          <ElapsedLabel timestampMs={dataUpdatedAt} />
          <span className="text-xs text-zinc-600">connections</span>
          <ElapsedLabel timestampMs={connUpdatedAt} />
        </div>
      </div>

      {error && <RefreshErrorBanner error={error} updatedAt={dataUpdatedAt} />}

      <DateRangePicker
        from={dateFrom}
        to={dateTo}
        onChange={(f, t) => { setDateFrom(f); setDateTo(t); }}
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Instances" value={data.length} onClick={() => setDrawer({
          title: 'Instances',
          rows: data.map(i => ({ primary: instances?.find(x => x.id === i.instanceId)?.label ?? i.instanceId })),
        })} />
        <StatCard label="Total Embed Users" value={totalUsers} filtered={totalFilteredUsers || undefined} onClick={() => setDrawer({
          title: 'Embed Users',
          rows: data.flatMap(inst => inst.users.filter(u => !u.filtered).map(u => ({
            primary: u.displayName || u.embedExternalId,
            secondary: instances?.find(x => x.id === inst.instanceId)?.label,
          }))),
          filteredRows: data.flatMap(inst => inst.users.filter(u => u.filtered).map(u => ({
            primary: u.displayName || u.embedExternalId,
            secondary: instances?.find(x => x.id === inst.instanceId)?.label,
          }))),
        })} />
        <StatCard label="Total Entities" value={totalEntities} filtered={totalFilteredEntities || undefined} onClick={() => setDrawer({
          title: 'Entities',
          rows: data.flatMap(inst => {
            const sep = separatorMap.get(inst.instanceId);
            const instName = instances?.find(x => x.id === inst.instanceId)?.label;
            const activeKeys = new Set(entityKeysOf(inst.users.filter(u => !u.filtered), sep));
            return [...activeKeys].sort().map(e => ({ primary: e, secondary: instName }));
          }),
          filteredRows: data.flatMap(inst => {
            const sep = separatorMap.get(inst.instanceId);
            const instName = instances?.find(x => x.id === inst.instanceId)?.label;
            const activeKeys = new Set(entityKeysOf(inst.users.filter(u => !u.filtered), sep));
            const filteredKeys = entityKeysOf(inst.users.filter(u => u.filtered), sep);
            return filteredKeys.filter(k => !activeKeys.has(k)).sort().map(e => ({ primary: e, secondary: instName }));
          }),
        })} />
        <StatCard label="Entities with No Users" value={noUsersValue} title={noUsersTitle} highlight={totalEntitiesNoUsers > 0} filtered={totalFilteredEntitiesNoUsers || undefined} onClick={() => setDrawer({
          title: 'Entities with No Users',
          showAppDisabledCheckbox: true,
          rows: data.flatMap(inst => {
            const sep = separatorMap.get(inst.instanceId);
            const instName = instances?.find(x => x.id === inst.instanceId)?.label;
            const allEntityKeys = new Set(Object.keys(groupUsersByGroup(inst.users, sep)).map(k => k.toLowerCase()));
            const connections = connectionsMap.get(inst.instanceId) ?? [];
            return connections.filter(c => !c.filtered && !allEntityKeys.has(c.name.toLowerCase())).map(c => ({ primary: c.name, secondary: instName, instanceId: inst.instanceId }));
          }),
          filteredRows: data.flatMap(inst => {
            const sep = separatorMap.get(inst.instanceId);
            const instName = instances?.find(x => x.id === inst.instanceId)?.label;
            const allEntityKeys = new Set(Object.keys(groupUsersByGroup(inst.users, sep)).map(k => k.toLowerCase()));
            const connections = connectionsMap.get(inst.instanceId) ?? [];
            return connections.filter(c => c.filtered && !allEntityKeys.has(c.name.toLowerCase())).map(c => ({ primary: c.name, secondary: instName, instanceId: inst.instanceId }));
          }),
        })} />
      </div>

      {drawer && <KpiDrawer drawer={drawer} onClose={() => setDrawer(null)} appDisabled={appDisabled} onToggleAppDisabled={toggleAppDisabled} error={appDisabledError} />}
      {!drawer && appDisabledError && <div className="text-xs text-red-400">{appDisabledError}</div>}

      <UserUsageChart data={data} />

      <input
        type="search"
        value={globalSearch}
        onChange={e => setGlobalSearch(e.target.value)}
        placeholder="Search all users across instances…"
        className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/20"
      />

      {globalSearch.trim() ? (
        <GlobalUserResults data={data} query={globalSearch.trim()} />
      ) : (
        <div className="flex flex-col gap-3">
          {data.map(inst => (
            <UserInstanceCard
              key={inst.instanceId}
              inst={inst}
              entityGroupSeparator={separatorMap.get(inst.instanceId)}
              connections={connectionsMap.get(inst.instanceId)}
              connectionsOff={connectionsOff(inst.instanceId)}
              isExpanded={expanded.has(inst.instanceId)}
              onToggleExpand={() => toggleExpand(inst.instanceId)}
              search={search[inst.instanceId] ?? ''}
              onSearchChange={v => setSearch(prev => ({ ...prev, [inst.instanceId]: v }))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type UserSortField = 'name' | 'lastLogin';
type UserSortDir = 'asc' | 'desc';

function SortHeader({
  label,
  field,
  sortField,
  sortDir,
  onSort,
  className,
}: {
  label: string;
  field: UserSortField;
  sortField: UserSortField | null;
  sortDir: UserSortDir;
  onSort: (f: UserSortField) => void;
  className?: string;
}) {
  const active = sortField === field;
  return (
    <th
      className={`pb-1 pr-4 font-normal cursor-pointer select-none hover:text-zinc-300 ${active ? 'text-zinc-300' : 'text-zinc-500'} ${className ?? ''}`}
      onClick={() => onSort(field)}
    >
      {label}
      <span className="ml-1 text-zinc-600">{active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
    </th>
  );
}

type ViewMode = 'users' | 'entities';

function UserInstanceCard({
  inst,
  entityGroupSeparator,
  connections,
  connectionsOff,
  isExpanded,
  onToggleExpand,
  search,
  onSearchChange,
}: {
  inst: InstanceEmbedUserStats;
  entityGroupSeparator?: string;
  connections?: ConnectionStat[];
  connectionsOff?: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  search: string;
  onSearchChange: (v: string) => void;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>('users');
  const [sortField, setSortField] = useState<UserSortField | null>(null);
  const [sortDir, setSortDir] = useState<UserSortDir>('asc');

  const handleSort = (field: UserSortField) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const groups = groupUsersByGroup(inst.users, entityGroupSeparator);
  const groupNames = Object.keys(groups).sort();
  const activeEntityCount = entityKeysOf(inst.users.filter(u => !u.filtered), entityGroupSeparator).length;
  const filteredEntityKeys = new Set(entityKeysOf(inst.users.filter(u => u.filtered), entityGroupSeparator));
  const filteredOnlyEntityCount = [...filteredEntityKeys].filter(k => !groups[k] || groups[k]!.every(u => u.filtered)).length;
  const q = search.trim().toLowerCase();

  const matchesSearch = (u: EmbedUserStat) =>
    !q ||
    u.displayName.toLowerCase().includes(q) ||
    u.embedExternalId.toLowerCase().includes(q) ||
    u.userName.toLowerCase().includes(q);

  // Flatten into (user, entity) rows
  const flatRows: Array<{ user: EmbedUserStat; entity: string }> = [];
  for (const g of groupNames) {
    for (const u of groups[g]!) {
      flatRows.push({ user: u, entity: g });
    }
  }

  if (sortField) {
    flatRows.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'name') {
        cmp = a.user.displayName.localeCompare(b.user.displayName);
      } else {
        const ta = a.user.lastLogin ? new Date(a.user.lastLogin).getTime() : 0;
        const tb = b.user.lastLogin ? new Date(b.user.lastLogin).getTime() : 0;
        cmp = ta - tb;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  // Entity rows: all users counted, filtered ones tracked for dimming
  const entityKeySet = new Set(groupNames.map(n => n.toLowerCase()));
  const deadConnections = (connections ?? []).filter(
    c => !c.filtered && !entityKeySet.has(c.name.toLowerCase())
  );
  const entityRows = [
    ...groupNames.map(name => {
      const all = groups[name]!;
      const allFiltered = all.every(u => u.filtered);
      const loggedIn = all.filter(u => u.lastLogin !== null).length;
      const neverLogged = all.filter(u => u.lastLogin === null).length;
      return { key: `g:${name}`, name, total: all.length, loggedIn, neverLogged, allFiltered, dead: false };
    }),
    ...deadConnections.map(c => ({ key: `dead:${c.id}`, name: c.name, total: 0, loggedIn: 0, neverLogged: 0, allFiltered: false, dead: true })),
  ]
    .filter(e => q ? e.name.toLowerCase().includes(q) : true)
    .sort((a, b) => b.total - a.total);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900">
      <button
        className="w-full flex items-center justify-between gap-2 p-4 text-left hover:bg-zinc-800/40 transition-colors rounded-t-lg"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-zinc-400 text-xs w-3">{isExpanded ? '▾' : '▸'}</span>
          <span className="text-zinc-100 font-medium truncate">{inst.instanceLabel}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 capitalize shrink-0">
            {inst.instanceRole}
          </span>
        </div>
        <div className="flex items-center gap-4 shrink-0 text-xs leading-none">
          {inst.error ? (
            <span className="text-red-400">error</span>
          ) : (
            <>
              {inst.refreshError && (
                <span className="text-amber-400 whitespace-nowrap" title={inst.refreshError}>stale - refresh failed</span>
              )}
              <span className="text-zinc-400 whitespace-nowrap">
                <span className="text-zinc-200 font-medium">{inst.users.length - (inst.filteredCount ?? 0)}</span>
                {(inst.filteredCount ?? 0) > 0 && (
                  <span className="text-zinc-600"> ({inst.filteredCount} filtered)</span>
                )}
                {' '}user{(inst.users.length - (inst.filteredCount ?? 0)) !== 1 ? 's' : ''}
              </span>
              <span className="text-zinc-600 whitespace-nowrap">
                {activeEntityCount} {activeEntityCount !== 1 ? 'entities' : 'entity'}
                {filteredOnlyEntityCount > 0 && <span className="text-zinc-700"> ({filteredOnlyEntityCount} filtered)</span>}
              </span>
              {connections === undefined ? (
                !connectionsOff && <span className="text-zinc-600 whitespace-nowrap">connections unavailable</span>
              ) : deadConnections.length > 0 && (
                <span className="text-amber-500/70 whitespace-nowrap">{deadConnections.length} with no users</span>
              )}
            </>
          )}
          <span className="text-zinc-600">{hostOf(inst.baseUrl)}</span>
        </div>
      </button>

      {isExpanded && (
        <div className="border-t border-zinc-800 px-4 pb-4 pt-3 flex flex-col gap-3">
          {inst.error ? (
            <p className="text-xs text-red-400">Error: {inst.error}</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <input
                  type="search"
                  value={search}
                  onChange={e => onSearchChange(e.target.value)}
                  placeholder={viewMode === 'users' ? 'Search users…' : 'Search entities…'}
                  className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/20"
                />
                <div className="flex shrink-0 rounded border border-zinc-700 overflow-hidden text-xs">
                  <button
                    onClick={() => setViewMode('users')}
                    className={`px-2.5 py-1.5 transition-colors ${viewMode === 'users' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
                  >
                    users
                  </button>
                  <button
                    onClick={() => setViewMode('entities')}
                    className={`px-2.5 py-1.5 border-l border-zinc-700 transition-colors ${viewMode === 'entities' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
                  >
                    entities
                  </button>
                </div>
              </div>

              {viewMode === 'entities' ? (
                <table key="entities" className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500 text-left">
                      <th className="pb-1 pr-4 font-normal">Entity</th>
                      <th className="pb-1 pr-4 font-normal text-right">Users</th>
                      <th className="pb-1 pr-4 font-normal text-right">Logged in</th>
                      <th className="pb-1 font-normal text-right">Never logged in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entityRows.map(e => {
                      const dim = e.dead ? 'opacity-35' : e.allFiltered ? 'opacity-40 italic' : '';
                      return (
                        <tr key={e.key} className={`border-b border-zinc-800/50 last:border-0 ${dim}`}>
                          <td className="py-1.5 pr-4 text-zinc-300">{e.name}</td>
                          <td className="py-1.5 pr-4 text-right">
                            {e.dead
                              ? <span className="text-zinc-600">0</span>
                              : <span className="text-zinc-200 font-medium">{e.total}</span>}
                          </td>
                          <td className="py-1.5 pr-4 text-right">
                            <span className={e.loggedIn > 0 ? 'text-emerald-400' : 'text-zinc-600'}>{e.loggedIn}</span>
                          </td>
                          <td className="py-1.5 text-right">
                            <span className={!e.dead && e.neverLogged > 0 ? 'text-amber-400' : 'text-zinc-600'}>{e.neverLogged}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
              <table key="users" className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500 text-left">
                    <SortHeader label="Display Name" field="name" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                    <th className="pb-1 pr-4 font-normal text-zinc-500">Entity</th>
                    <th className="pb-1 pr-4 font-normal text-zinc-500">External ID</th>
                    <th className="pb-1 pr-4 font-normal text-zinc-500">Status</th>
                    <SortHeader label="Last Login" field="lastLogin" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="pr-0" />
                  </tr>
                </thead>
                <tbody>
                  {(q ? flatRows.filter(({ user: u }) => matchesSearch(u)) : flatRows).map(({ user: u, entity }) => {
                    const dim = u.filtered ? 'opacity-50 italic' : '';
                    return (
                      <tr
                        key={`${u.id}:${entity}`}
                        className={`border-b border-zinc-800/50 last:border-0 transition-opacity ${dim}`}
                      >
                        <td className="py-1.5 pr-4 text-zinc-300">{u.displayName}</td>
                        <td className="py-1.5 pr-4 text-zinc-500">{entity}</td>
                        <td className="py-1.5 pr-4 text-zinc-400 font-mono">{u.embedExternalId || '—'}</td>
                        <td className="py-1.5 pr-4">
                          {u.active
                            ? <span className="text-emerald-400">active</span>
                            : <span className="text-zinc-600">inactive</span>}
                        </td>
                        <td className="py-1.5 text-zinc-500">{timeAgoSimple(u.lastLogin)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function groupUsersByGroup(users: EmbedUserStat[], separator?: string): Record<string, EmbedUserStat[]> {
  // Keys are untrusted Omni group names ('constructor', '__proto__', ...), so no inherited properties.
  const out: Record<string, EmbedUserStat[]> = Object.create(null);
  const seen: Record<string, Set<string>> = Object.create(null);
  const toKey = (display: string) =>
    separator ? display.split(separator)[0]!.trim() : display;
  for (const u of users) {
    const relevantGroups = u.groups.filter(g => g.display !== ALL_EMBED_USERS_GROUP);
    if (relevantGroups.length === 0) {
      const key = NO_GROUP;
      (out[key] ??= []).push(u);
    } else {
      for (const g of relevantGroups) {
        const key = toKey(g.display);
        (seen[key] ??= new Set());
        if (!seen[key]!.has(u.id)) {
          seen[key]!.add(u.id);
          (out[key] ??= []).push(u);
        }
      }
    }
  }
  return out;
}


// --- Global search results ---

function GlobalConnectionResults({
  data,
  excluded,
  query,
  onToggleExclude,
}: {
  data: InstanceDashboardStats[];
  excluded: Record<string, Set<string>>;
  query: string;
  onToggleExclude: (instanceId: string, connectionId: string) => void;
}) {
  const q = query.toLowerCase();
  const rows = data.flatMap(inst =>
    inst.connections
      .filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.database.toLowerCase().includes(q) ||
        c.dialect.toLowerCase().includes(q)
      )
      .map(c => ({ ...c, instanceId: inst.instanceId, instanceLabel: inst.instanceLabel }))
  );

  if (rows.length === 0) return <p className="text-xs text-zinc-500">No connections match.</p>;

  return (
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr className="border-b border-zinc-800 text-zinc-500 text-left">
          <th className="pb-1 pr-4 font-normal">Instance</th>
          <th className="pb-1 pr-4 font-normal">Name</th>
          <th className="pb-1 pr-4 font-normal">Database</th>
          <th className="pb-1 pr-4 font-normal">Dialect</th>
          <th className="pb-1 pr-4 font-normal">Schema Model</th>
          <th className="pb-1 font-normal text-right">Exclude</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(c => {
          const isExcluded = (excluded[c.instanceId] ?? new Set()).has(c.id);
          const dimClass = isExcluded ? 'opacity-30' : c.filtered ? 'opacity-50 italic' : '';
          return (
            <tr key={`${c.instanceId}:${c.id}`} className={`border-b border-zinc-800/50 last:border-0 transition-opacity ${dimClass}`}>
              <td className="py-1.5 pr-4 text-zinc-500">{c.instanceLabel}</td>
              <td className="py-1.5 pr-4 text-zinc-300">{c.name}</td>
              <td className="py-1.5 pr-4 text-zinc-400">{c.database}</td>
              <td className="py-1.5 pr-4 text-zinc-400">{c.dialect}</td>
              <td className="py-1.5 pr-4">
                {c.hasSchemaModel
                  ? <span className="text-emerald-400">✓</span>
                  : <span className="text-amber-400">missing</span>}
              </td>
              <td className="py-1.5 text-right">
                <button
                  onClick={() => onToggleExclude(c.instanceId, c.id)}
                  className="text-zinc-600 hover:text-zinc-300 transition-colors px-1"
                >
                  {isExcluded ? 'include' : 'exclude'}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function GlobalUserResults({
  data,
  query,
}: {
  data: InstanceEmbedUserStats[];
  query: string;
}) {
  const q = query.toLowerCase();
  const rows = data.flatMap(inst =>
    inst.users
      .filter(u =>
        u.displayName.toLowerCase().includes(q) ||
        u.embedExternalId.toLowerCase().includes(q) ||
        u.userName.toLowerCase().includes(q)
      )
      .map(u => ({ ...u, instanceId: inst.instanceId, instanceLabel: inst.instanceLabel }))
  );

  if (rows.length === 0) return <p className="text-xs text-zinc-500">No users match.</p>;

  return (
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr className="border-b border-zinc-800 text-zinc-500 text-left">
          <th className="pb-1 pr-4 font-normal">Instance</th>
          <th className="pb-1 pr-4 font-normal">Display Name</th>
          <th className="pb-1 pr-4 font-normal">External ID</th>
          <th className="pb-1 pr-4 font-normal">Status</th>
          <th className="pb-1 font-normal">Last Login</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(u => (
          <tr
            key={`${u.instanceId}:${u.id}`}
            className={`border-b border-zinc-800/50 last:border-0 transition-opacity ${u.filtered ? 'opacity-50 italic' : ''}`}
            title={u.filtered ? "Filtered out by this instance's dashboard filter" : undefined}
          >
            <td className="py-1.5 pr-4 text-zinc-500">{u.instanceLabel}</td>
            <td className="py-1.5 pr-4 text-zinc-300">{u.displayName}</td>
            <td className="py-1.5 pr-4 text-zinc-400 font-mono">{u.embedExternalId || '—'}</td>
            <td className="py-1.5 pr-4">
              {u.active
                ? <span className="text-emerald-400">active</span>
                : <span className="text-zinc-600">inactive</span>}
            </td>
            <td className="py-1.5 text-zinc-500">{timeAgoSimple(u.lastLogin)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- Usage chart ---

function computeWeeklyLogins(users: EmbedUserStat[]): { label: string; count: number }[] {
  const now = new Date();
  const dayOfWeek = (now.getDay() + 6) % 7; // Mon=0 ... Sun=6
  // Local-midnight Monday `weeksAgo` weeks back; calendar days, not milliseconds, so DST can't shift the boundary.
  const mondayWeeksAgo = (weeksAgo: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek - 7 * weeksAgo);
  return Array.from({ length: 12 }, (_, i) => {
    const start = mondayWeeksAgo(11 - i);
    const end = mondayWeeksAgo(10 - i); // i = 11 -> next Monday
    return {
      label: `${start.getMonth() + 1}/${start.getDate()}`,
      count: users.filter(u => {
        if (!u.lastLogin) return false;
        const t = new Date(u.lastLogin).getTime();
        return t >= start.getTime() && t < end.getTime();
      }).length,
    };
  });
}

function trimLeadingZeros(data: { label: string; count: number }[]): { label: string; count: number }[] {
  const firstNonZero = data.findIndex(d => d.count > 0);
  if (firstNonZero <= 0) return data;
  return data.slice(Math.max(0, firstNonZero - 1));
}

function computeMonthlySignups(users: EmbedUserStat[]): { label: string; count: number }[] {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
    return {
      label: d.toLocaleString('default', { month: 'short' }),
      count: users.filter(u => {
        if (!u.createdAt) return false;
        const cd = new Date(u.createdAt);
        return cd.getFullYear() === d.getFullYear() && cd.getMonth() === d.getMonth();
      }).length,
    };
  });
}

function UsageBarChart({ data, color, labelPrefix }: { data: { label: string; count: number }[]; color: string; labelPrefix?: string }) {
  return (
    <ResponsiveContainer width="100%" height={140}>
      <ReBarChart data={data} margin={{ top: 20, right: 4, bottom: 0, left: 4 }} barCategoryGap="30%">
        <CartesianGrid vertical={false} stroke="#27272a" />
        <XAxis
          dataKey="label"
          tick={{ fill: '#71717a', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          interval={0}
        />
        <YAxis hide />
        <Tooltip
          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
          contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, fontSize: 12, color: '#e4e4e7' }}
          itemStyle={{ color: '#e4e4e7' }}
          labelStyle={{ color: '#a1a1aa', marginBottom: 2 }}
          labelFormatter={labelPrefix ? (l: React.ReactNode) => `${labelPrefix} ${l}` : undefined}
        />
        <Bar dataKey="count" fill={color} radius={[3, 3, 0, 0]} name="Users">
          <LabelList dataKey="count" position="top" style={{ fill: '#a1a1aa', fontSize: 11 }} formatter={(v: unknown) => (v as number) === 0 ? '' : (v as number)} />
        </Bar>
      </ReBarChart>
    </ResponsiveContainer>
  );
}

function MiniStat({ label, value, total, warn }: { label: string; value: number; total: number; warn?: boolean }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className={`bg-zinc-950/60 rounded p-3 ${warn ? 'border-l-2 border-amber-500/50' : ''}`}>
      <div className={`text-xl font-bold ${warn ? 'text-amber-400' : 'text-zinc-100'}`}>{value}</div>
      <div className="text-xs text-zinc-500 mt-0.5">{label}</div>
      {total > 0 && <div className="text-xs text-zinc-700">{pct}%</div>}
    </div>
  );
}

const UserUsageChart = memo(function UserUsageChart({ data }: { data: InstanceEmbedUserStats[] }) {
  const allUsers = data.flatMap(d => d.users.filter(u => !u.filtered));
  const now = Date.now();
  const msDay = 86_400_000;
  const active7 = allUsers.filter(u => u.lastLogin && now - new Date(u.lastLogin).getTime() < 7 * msDay).length;
  const active30 = allUsers.filter(u => u.lastLogin && now - new Date(u.lastLogin).getTime() < 30 * msDay).length;
  const active90 = allUsers.filter(u => u.lastLogin && now - new Date(u.lastLogin).getTime() < 90 * msDay).length;
  const neverLogged = allUsers.filter(u => !u.lastLogin).length;
  const weeklyLogins = trimLeadingZeros(computeWeeklyLogins(allUsers));
  const monthlySignups = trimLeadingZeros(computeMonthlySignups(allUsers));

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 flex flex-col gap-4">
      <h3 className="text-sm font-medium text-zinc-300">Usage Analytics</h3>
      <div className="grid grid-cols-4 gap-2">
        <MiniStat label="Active 7d" value={active7} total={allUsers.length} />
        <MiniStat label="Active 30d" value={active30} total={allUsers.length} />
        <MiniStat label="Active 90d" value={active90} total={allUsers.length} />
        <MiniStat label="Never logged in" value={neverLogged} total={allUsers.length} warn={neverLogged > 0} />
      </div>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <p className="text-xs text-zinc-600 mb-1">Users by last-login week — last {weeklyLogins.length} weeks</p>
          <UsageBarChart data={weeklyLogins} color="#3b82f6" labelPrefix="Week of" />
        </div>
        <div>
          <p className="text-xs text-zinc-600 mb-1">New users per month — last {monthlySignups.length} months</p>
          <UsageBarChart data={monthlySignups} color="#10b981" />
        </div>
      </div>
    </div>
  );
});

// --- KPI Drawer ---

type DrawerRow = { primary: string; secondary?: string; instanceId?: string };
type DrawerData = { title: string; rows: DrawerRow[]; filteredRows?: DrawerRow[]; showAppDisabledCheckbox?: boolean };

function DrawerSection({ label, rows, dimmed, appDisabled, onToggleAppDisabled }: {
  label: string;
  rows: DrawerRow[];
  dimmed?: boolean;
  appDisabled?: Set<string>;
  onToggleAppDisabled?: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = rows.map(r => r.secondary ? `${r.primary}\t${r.secondary}` : r.primary).join('\n');
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  const appOffCount = appDisabled
    ? rows.filter(r => r.instanceId && appDisabled.has(`${r.instanceId}::${r.primary}`)).length
    : 0;
  return (
    <div className="border-b border-zinc-800">
      <button
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800/50 transition-colors text-left"
        onClick={() => setOpen(v => !v)}
      >
        <span className={`text-xs font-medium uppercase tracking-wider ${dimmed ? 'text-zinc-500' : 'text-zinc-300'}`}>
          {label}{appOffCount > 0 && <span className="ml-2 normal-case text-amber-500/70">{appOffCount} app off</span>}
        </span>
        <div className="flex items-center gap-2">
          <span
            className="text-zinc-500 hover:text-zinc-300 text-xs px-1.5 py-0.5 rounded hover:bg-zinc-700 transition-colors"
            onClick={copy}
          >{copied ? 'copied!' : 'copy'}</span>
          <span className="text-zinc-500 text-xs">{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {open && (
        <div className={`divide-y divide-zinc-800/60 ${dimmed ? 'opacity-50' : ''}`}>
          {rows.map((row, i) => {
            const key = row.instanceId ? `${row.instanceId}::${row.primary}` : null;
            const isDisabled = key && appDisabled?.has(key);
            return (
              <div key={i} className="px-4 py-2.5 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className={`text-sm ${dimmed ? 'text-zinc-400 italic' : 'text-zinc-200'}`}>{row.primary}</div>
                  {row.secondary && <div className="text-xs text-zinc-500 mt-0.5">{row.secondary}</div>}
                </div>
                {onToggleAppDisabled && key && (
                  <label
                    className="flex items-center gap-1.5 shrink-0 cursor-pointer mt-0.5"
                    title={isDisabled ? 'App disabled (click to unmark)' : 'Mark app as disabled'}
                    onClick={e => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={!!isDisabled}
                      onChange={() => onToggleAppDisabled(key)}
                      className="w-3 h-3 accent-amber-500"
                    />
                    <span className="text-xs text-zinc-600">App off</span>
                  </label>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function KpiDrawer({ drawer, onClose, appDisabled, onToggleAppDisabled, error }: {
  drawer: DrawerData;
  onClose: () => void;
  appDisabled?: Set<string>;
  onToggleAppDisabled?: (key: string) => void;
  error?: string | null;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative w-full max-w-md bg-zinc-900 border-l border-zinc-800 flex flex-col h-full shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <span className="text-sm font-medium text-zinc-200">{drawer.title}</span>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">✕</button>
        </div>
        {error && <div className="px-4 py-2 text-xs text-red-400 border-b border-zinc-800">{error}</div>}
        <div className="overflow-y-auto flex-1">
          <DrawerSection label={`Active (${drawer.rows.length})`} rows={drawer.rows} />
          {!!drawer.filteredRows?.length && (
            <DrawerSection
              label={`Filtered out (${drawer.filteredRows.length})`}
              rows={drawer.filteredRows}
              dimmed
              appDisabled={drawer.showAppDisabledCheckbox ? appDisabled : undefined}
              onToggleAppDisabled={drawer.showAppDisabledCheckbox ? onToggleAppDisabled : undefined}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// --- Sub-components ---

function StatCard({ label, value, title, highlight, filtered, onClick }: { label: string; value: number | string; title?: string; highlight?: boolean; filtered?: number; onClick?: () => void }) {
  return (
    <div
      title={title}
      className={`rounded-lg border border-zinc-800 bg-zinc-900 p-4 border-t-2 ${highlight ? 'border-t-amber-500/70' : 'border-t-blue-500/30'} ${onClick ? 'cursor-pointer hover:bg-zinc-800/60 transition-colors' : ''}`}
      onClick={onClick}
    >
      <div className={`text-2xl font-bold ${highlight ? 'text-amber-400' : 'text-zinc-100'}`}>
        {value}
      </div>
      <div className="text-xs text-zinc-400 mt-1">{label}</div>
      {!!filtered && <div className="text-xs text-zinc-600 mt-0.5">{filtered} filtered out</div>}
    </div>
  );
}

// Schema refresh state lives outside InstanceCard so it survives the card unmounting (global search, tab switch).
// Keyed by `${instanceId}:${connectionId}`: a bare connection id is not guaranteed unique across instances.
// 'queued' waits for a Refresh All worker, 'pending' is in flight, 'ok' means Omni accepted the job (it runs async).
type RefreshStatus = 'idle' | 'queued' | 'pending' | 'ok' | 'error';
type RefreshState = { status: RefreshStatus; error?: string };

const refreshStates = new Map<string, RefreshState>();
const refreshListeners = new Set<() => void>();
let refreshSnapshot: ReadonlyMap<string, RefreshState> = new Map();

function setRefreshState(key: string, st: RefreshState | null): void {
  if (st) refreshStates.set(key, st);
  else refreshStates.delete(key);
  refreshSnapshot = new Map(refreshStates);
  refreshListeners.forEach(l => l());
}

function subscribeRefreshStates(cb: () => void): () => void {
  refreshListeners.add(cb);
  return () => {
    refreshListeners.delete(cb);
  };
}

function useRefreshStates(): ReadonlyMap<string, RefreshState> {
  return useSyncExternalStore(subscribeRefreshStates, () => refreshSnapshot);
}

// The stats are never refetched on their own (staleTime Infinity), so re-sync after a queued refresh: once while Omni is
// likely done, once later, then drop the 'ok' marks so rows that did not flip to "has schema" can be retried.
// One debounced set of timers, not one per success. Not cleared on unmount: qc is global and a late invalidate is harmless.
let resyncTimers: ReturnType<typeof setTimeout>[] = [];
function scheduleResync(qc: QueryClient): void {
  resyncTimers.forEach(t => clearTimeout(t));
  resyncTimers = [20_000, 90_000].map((ms, i, all) => setTimeout(async () => {
    // Snapshot before the (slow) refetch: a refresh queued while it runs belongs to the next resync, not this one.
    const stale = i === all.length - 1 ? [...refreshStates].filter(([, v]) => v.status === 'ok').map(([k]) => k) : [];
    await qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
    for (const k of stale) if (refreshStates.get(k)?.status === 'ok') setRefreshState(k, null);
  }, ms));
}

function InstanceCard({
  inst,
  isExpanded,
  onToggleExpand,
  search,
  onSearchChange,
  excludedIds,
  onToggleExclude,
}: {
  inst: InstanceDashboardStats;
  isExpanded: boolean;
  onToggleExpand: () => void;
  search: string;
  onSearchChange: (v: string) => void;
  excludedIds: Set<string>;
  onToggleExclude: (id: string) => void;
}) {
  const states = useRefreshStates();
  const qc = useQueryClient();
  const keyOf = (c: ConnectionStat) => `${inst.instanceId}:${c.id}`;
  const refreshStatus: Record<string, RefreshStatus> = {};
  const refreshError: Record<string, string> = {};
  for (const c of inst.connections) {
    const st = states.get(keyOf(c));
    if (!st) continue;
    refreshStatus[c.id] = st.status;
    if (st.error) refreshError[c.id] = st.error;
  }

  const activeConnections = inst.connections.filter(c => !excludedIds.has(c.id) && !c.filtered);
  const missing = activeConnections.filter(c => !c.hasSchemaModel);
  const excludedCount = inst.connections.filter(c => !c.filtered).length - activeConnections.length;

  const filtered = inst.connections.slice().sort((a, b) => (a.hasSchemaModel ? 1 : 0) - (b.hasSchemaModel ? 1 : 0));

  const refreshOne = async (c: ConnectionStat) => {
    if (!c.schemaModelId) return;
    const key = keyOf(c);
    if (refreshStates.get(key)?.status === 'pending') return;
    setRefreshState(key, { status: 'pending' });
    try {
      const r = await api.refreshSchema(inst.instanceId, c.schemaModelId);
      if (r.status?.toLowerCase() === 'failed') throw new Error(`Omni reported the schema refresh as failed (job ${r.jobId})`);
      setRefreshState(key, { status: 'ok' });
      scheduleResync(qc);
    } catch (err) {
      setRefreshState(key, { status: 'error', error: err instanceof Error ? err.message : 'failed' });
    }
  };

  // Queued, in flight and already-queued rows are not refreshable again, so a second click cannot double-queue them.
  const isRefreshable = (c: ConnectionStat) => {
    const s = refreshStatus[c.id];
    return !!c.schemaModelId && !c.hasSchemaModel && s !== 'queued' && s !== 'pending' && s !== 'ok';
  };

  const refreshAll = () => {
    const queue = activeConnections.filter(isRefreshable);
    if (queue.length === 0) return;
    for (const c of queue) setRefreshState(keyOf(c), { status: 'queued' });
    // Two workers hide latency against the server's per-key request gap and stay well under the browser's
    // per-host connection limit. They only use module state, so they keep going if this card unmounts.
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        if (refreshStates.get(keyOf(c))?.status === 'queued') await refreshOne(c);
      }
    };
    void Promise.all([worker(), worker()]);
  };

  const bulkBusy = activeConnections.some(c => refreshStatus[c.id] === 'pending' || refreshStatus[c.id] === 'queued');
  const refreshableCount = activeConnections.filter(isRefreshable).length;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900">
      <button
        className="w-full flex items-center justify-between gap-2 p-4 text-left hover:bg-zinc-800/40 transition-colors rounded-t-lg"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-zinc-400 text-xs w-3">{isExpanded ? '▾' : '▸'}</span>
          <span className="text-zinc-100 font-medium truncate">{inst.instanceLabel}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 capitalize shrink-0">
            {inst.instanceRole}
          </span>
          {!inst.error && missing.length > 0 && (
            <span className="text-xs text-amber-400 shrink-0">{missing.length} missing schema</span>
          )}
          {inst.refreshError && (
            <span className="text-xs text-amber-400 shrink-0" title={inst.refreshError}>stale - refresh failed</span>
          )}
        </div>

        <div className="flex items-center shrink-0 text-xs">
          {inst.error ? (
            <span className="text-red-400 w-56 text-right">error</span>
          ) : (
            <span className="text-zinc-400 w-56 text-right whitespace-nowrap">
              <span className="text-zinc-200 font-medium">{activeConnections.length}</span>
              {excludedCount > 0 && (
                <span className="text-zinc-600"> ({excludedCount} excl.)</span>
              )}
              {(inst.filteredCount ?? 0) > 0 && (
                <span className="text-zinc-600"> ({inst.filteredCount} filtered)</span>
              )}
              {' '}connection{activeConnections.length !== 1 ? 's' : ''}
            </span>
          )}
          <span className="text-zinc-600 w-44 text-right truncate">{hostOf(inst.baseUrl)}</span>
        </div>
      </button>

      {isExpanded && (
        <div className="border-t border-zinc-800 px-4 pb-4 pt-3 flex flex-col gap-3">
          {inst.error ? (
            <p className="text-xs text-red-400">Error: {inst.error}</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <input
                  type="search"
                  value={search}
                  onChange={e => onSearchChange(e.target.value)}
                  placeholder="Search connections…"
                  className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/20"
                />
                {(refreshableCount > 0 || bulkBusy) && (
                  <button
                    onClick={refreshAll}
                    disabled={bulkBusy}
                    title={`Refresh schema for all ${refreshableCount} non-excluded connection${refreshableCount !== 1 ? 's' : ''}`}
                    className="shrink-0 px-2.5 py-1.5 text-xs rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {bulkBusy ? 'refreshing…' : `Refresh All (${refreshableCount})`}
                  </button>
                )}
              </div>
              <ConnectionTable
                connections={filtered}
                excludedIds={excludedIds}
                onToggleExclude={onToggleExclude}
                refreshStatus={refreshStatus}
                refreshError={refreshError}
                onRefresh={refreshOne}
                searchQuery={search}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function timeAgoSimple(isoOrNull: string | null | undefined): string {
  if (!isoOrNull) return 'never';
  const diffMs = Date.now() - new Date(isoOrNull).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function timeAgo(iso: string): { label: string; overdue: boolean } {
  const rawMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(rawMs)) return { label: 'unknown', overdue: false };
  const diffMs = Math.max(0, rawMs);
  const mins = Math.floor(diffMs / 60_000);
  return { label: mins < 1 ? 'just now' : formatAgo(diffMs), overdue: mins > 30 };
}

function SchemaAge({ updatedAt }: { updatedAt: string }) {
  const { label, overdue } = timeAgo(updatedAt);
  return (
    <span className={`ml-1.5 ${overdue ? 'text-red-400' : 'text-amber-500/70'}`} title={`Last updated: ${new Date(updatedAt).toLocaleString()}`}>
      ({label}{overdue ? ' — overdue' : ''})
    </span>
  );
}

function ConnectionTable({
  connections,
  excludedIds,
  onToggleExclude,
  refreshStatus,
  refreshError,
  onRefresh,
  searchQuery,
}: {
  connections: ConnectionStat[];
  excludedIds: Set<string>;
  onToggleExclude: (id: string) => void;
  refreshStatus: Record<string, RefreshStatus>;
  refreshError: Record<string, string>;
  onRefresh: (c: ConnectionStat) => void;
  searchQuery?: string;
}) {
  const q = searchQuery?.trim().toLowerCase() ?? '';
  const visible = connections.filter(c => !q ||
    c.name.toLowerCase().includes(q) ||
    c.database.toLowerCase().includes(q) ||
    c.dialect.toLowerCase().includes(q)
  );

  return (
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr className="border-b border-zinc-800 text-zinc-500 text-left">
          <th className="pb-1 pr-4 font-normal">Name</th>
          <th className="pb-1 pr-4 font-normal">Database</th>
          <th className="pb-1 pr-4 font-normal">Dialect</th>
          <th className="pb-1 pr-4 font-normal">Schema Model</th>
          <th className="pb-1 pr-2 font-normal text-center">Refresh Schema</th>
          <th className="pb-1 font-normal text-right">Count</th>
        </tr>
      </thead>
      <tbody>
        {visible.length === 0 && (
          <tr><td colSpan={6} className="py-3 text-zinc-500">{q ? 'No connections match.' : 'No connections.'}</td></tr>
        )}
        {visible.map(c => {
          const isExcluded = excludedIds.has(c.id);
          const status = refreshStatus[c.id] ?? 'idle';
          const errMsg = refreshError[c.id];
          const dimClass = isExcluded ? 'opacity-30' : c.filtered ? 'opacity-50 italic' : '';
          return (
            <tr
              key={c.id}
              className={`border-b border-zinc-800/50 last:border-0 transition-opacity ${dimClass}`}
            >
              <td className="py-1.5 pr-4 text-zinc-300">{c.name}</td>
              <td className="py-1.5 pr-4 text-zinc-400">{c.database}</td>
              <td className="py-1.5 pr-4 text-zinc-400">{c.dialect}</td>
              <td className="py-1.5 pr-4">
                {c.hasSchemaModel ? (
                  <span className="text-emerald-400">✓</span>
                ) : (
                  <span className="text-amber-400">
                    missing
                    {c.schemaModelUpdatedAt && <SchemaAge updatedAt={c.schemaModelUpdatedAt} />}
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-2 text-center">
                {c.schemaModelId ? (
                  <button
                    onClick={() => onRefresh(c)}
                    disabled={status === 'pending' || status === 'queued'}
                    title={errMsg ?? (status === 'ok' ? 'Refresh queued in Omni' : status === 'queued' ? 'Waiting to be sent' : 'Refresh schema')}
                    className={`px-1.5 py-0.5 rounded text-xs transition-colors disabled:cursor-not-allowed ${
                      status === 'pending' || status === 'queued' ? 'text-zinc-500' :
                      status === 'ok' ? 'text-emerald-400 hover:text-emerald-300' :
                      status === 'error' ? 'text-red-400 hover:text-red-300' :
                      'text-zinc-600 hover:text-zinc-300'
                    }`}
                  >
                    {status === 'pending' || status === 'queued' ? '…' : status === 'ok' ? '✓' : status === 'error' ? '✗' : '↻'}
                  </button>
                ) : (
                  <span className="text-zinc-700">—</span>
                )}
              </td>
              <td className="py-1.5 text-right">
                <button
                  onClick={() => onToggleExclude(c.id)}
                  title={isExcluded ? 'Include in count' : 'Exclude from count'}
                  className="text-zinc-600 hover:text-zinc-300 transition-colors px-1"
                >
                  {isExcluded ? 'include' : 'exclude'}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
