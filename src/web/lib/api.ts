import type {
  InstancePublic,
  Instance,
  DashboardFilter,
  FolderRef,
  OmniDoc,
  OmniFolder,
  OmniLabel,
  JobPlan,
  Job,
  JobWithItems,
  PostMigrationAction,
  PostMigrationActionResult,
} from '../../shared/types';

export interface ConnectionStat {
  id: string;
  name: string;
  dialect: string;
  database: string;
  hasSchemaModel: boolean;
  schemaModelId: string | null;
  schemaModelUpdatedAt: string | null;
  filtered?: boolean;
}

export interface InstanceDashboardStats {
  instanceId: string;
  instanceLabel: string;
  instanceRole: string;
  baseUrl: string;
  totalConnections: number;
  connections: ConnectionStat[];
  filteredCount?: number;
  error?: string;
}

export interface EmbedUserStat {
  id: string;
  displayName: string;
  userName: string;
  active: boolean;
  embedExternalId: string;
  groups: Array<{ display: string; value: string }>;
  lastLogin?: string | null;
  createdAt?: string;
  filtered?: boolean;
}

export interface InstanceEmbedUserStats {
  instanceId: string;
  instanceLabel: string;
  instanceRole: string;
  baseUrl: string;
  users: EmbedUserStat[];
  filteredCount?: number;
  error?: string;
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${text || res.statusText}`);
  }
  return await res.json() as T;
}

export const api = {
  unlockStatus: () => fetch('/api/unlock/status').then(j<{ unlocked: boolean; vaultExists: boolean }>),
  unlock: (passphrase: string) =>
    fetch('/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    }).then(j<{ ok: true }>),
  lock: () => fetch('/api/lock', { method: 'POST' }).then(j<{ ok: true }>),

  listInstances: () => fetch('/api/instances').then(j<InstancePublic[]>),
  createInstance: (body: Omit<Instance, 'id'>) =>
    fetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j<InstancePublic>),
  updateInstance: (id: string, body: Omit<Instance, 'id'>) =>
    fetch(`/api/instances/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j<InstancePublic>),
  deleteInstance: (id: string) =>
    fetch(`/api/instances/${id}`, { method: 'DELETE' }).then(j<{ ok: true }>),
  setInstanceDashboardTabs: (id: string, tabs: ('connections' | 'users')[]) =>
    fetch(`/api/instances/${id}/dashboard-tabs`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabs }),
    }).then(j<{ ok: true }>),
  setInstanceDashboardFilter: (id: string, filter: DashboardFilter) =>
    fetch(`/api/instances/${id}/dashboard-filter`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filter),
    }).then(j<{ ok: true }>),
  saveInstanceActions: (id: string, actions: PostMigrationAction[]) =>
    fetch(`/api/instances/${id}/actions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(actions),
    }).then(j<{ ok: true }>),

  listFolder: (instanceId: string, folderId?: string) =>
    fetch(`/api/instances/${instanceId}/folder${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''}`).then(j<OmniDoc[]>),
  searchFolders: (instanceId: string, q: string, refresh = false) =>
    fetch(`/api/instances/${instanceId}/folders?q=${encodeURIComponent(q)}${refresh ? '&refresh=1' : ''}`)
      .then(j<{ folders: OmniFolder[]; total: number; cachedAt: number }>),

  patchDoc: (instanceId: string, docId: string, body: { name?: string; description?: string | null; clearExistingDraft?: boolean }) =>
    fetch(`/api/instances/${instanceId}/documents/${encodeURIComponent(docId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j<{ ok: true }>),

  listLabels: (instanceId: string) =>
    fetch(`/api/instances/${instanceId}/labels`).then(j<OmniLabel[]>),
  setDocumentLabels: (instanceId: string, docId: string, body: { add?: string[]; remove?: string[] }) =>
    fetch(`/api/instances/${instanceId}/documents/${encodeURIComponent(docId)}/labels`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j<{ ok: true }>),

  previewJob: (body: { sourceId: string; destIds: string[]; docIds: string[]; emptyFirst: boolean; sourceFolder?: FolderRef; destFolders?: Record<string, FolderRef> }) =>
    fetch('/api/jobs/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j<JobPlan>),
  createJob: (body: { sourceId: string; destIds: string[]; docIds: string[]; emptyFirst: boolean; postMigrationActions?: PostMigrationAction[]; sourceFolder?: FolderRef; destFolders?: Record<string, FolderRef> }) =>
    fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j<{ job: Job; plan: JobPlan }>),
  runActions: (actions: PostMigrationAction[]) =>
    fetch('/api/actions/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(actions),
    }).then(j<{ results: PostMigrationActionResult[] }>),
  retryJob: (id: string) =>
    fetch(`/api/jobs/${id}/retry`, { method: 'POST' }).then(j<{ job: Job }>),
  listJobs: () => fetch('/api/jobs').then(j<Job[]>),
  getJob: (id: string) => fetch(`/api/jobs/${id}`).then(j<JobWithItems & { running: boolean }>),

  getDashboardStats: () => fetch('/api/dashboard/stats').then(j<InstanceDashboardStats[]>),
  getEmbedUserStats: () => fetch('/api/dashboard/embed-users').then(j<InstanceEmbedUserStats[]>),

  changePassphrase: (currentPassphrase: string, newPassphrase: string) =>
    fetch('/api/settings/change-passphrase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassphrase, newPassphrase }),
    }).then(j<{ ok: true }>),

  refreshSchema: (instanceId: string, modelId: string) =>
    fetch(`/api/dashboard/${instanceId}/refresh-schema`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId }),
    }).then(j<{ jobId: string; modelId: string; status: string }>),

  getAppDisabled: () =>
    fetch('/api/dashboard/app-disabled').then(j<{ keys: string[] }>),
  setAppDisabled: (keys: string[]) =>
    fetch('/api/dashboard/app-disabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    }).then(j<{ ok: true }>),

};
