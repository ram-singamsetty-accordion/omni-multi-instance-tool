export type InstanceRole = 'source' | 'destination';

export interface DashboardFilter {
  databaseContains: string[];
  databaseExact: string[];
  externalIdContains: string[];
  externalIdExact: string[];
}

export interface PostMigrationAction {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface PostMigrationActionResult {
  index: number;
  method: string;
  url: string;
  status: number | null;
  ok: boolean;
  error?: string;
  responseBody?: string;
}

export interface Instance {
  id: string;
  label: string;
  role: InstanceRole;
  baseUrl: string;
  apiKey: string;
  userId: string;
  modelId: string;
  folderId: string;
  folderPath: string;
  postMigrationActions?: PostMigrationAction[];
  dashboardTabs?: ('connections' | 'users')[];
  dashboardFilter?: DashboardFilter;
  entityGroupSeparator?: string;
}

export type InstancePublic = Omit<Instance, 'apiKey'> & { apiKeyMasked: string };

export interface OmniDoc {
  identifier: string;
  name: string;
  folderId?: string;
  type?: string;
  updatedAt?: string;
  description?: string | null;
  labels?: string[];
}

export interface OmniFolder {
  id: string;
  name: string;
  path: string;
  scope?: string;
}

// Folder chosen for one migration run. Overrides the folder saved on the instance.
export interface FolderRef {
  id: string;
  path: string;
  name?: string;
}

export interface OmniLabel {
  name: string;
  color?: string | null;
  description?: string | null;
  isVerified?: boolean;
  isHomepageSection?: boolean;
}

export type JobItemKind = 'delete' | 'export' | 'import' | 'update' | 'models' | 'verify' | 'meta';
// Failed steps a retry can redo. Not models/verify: a retry re-plans against what is now on the
// destination, so a dashboard that landed becomes an update, which never rebuilds query models and
// would report a false green.
export const RETRYABLE_ITEM_KINDS: readonly JobItemKind[] = ['delete', 'export', 'import', 'update', 'meta'];
export type JobItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type JobStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'canceled';

export interface JobItem {
  id: string;
  jobId: string;
  destId: string;
  kind: JobItemKind;
  docId: string | null;
  docName: string | null;
  status: JobItemStatus;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  exportHash: string | null;
}

export interface Job {
  id: string;
  sourceId: string;
  destIds: string[];
  docIds: string[];
  emptyFirst: boolean;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  parentJobId: string | null;
  postMigrationActions: PostMigrationAction[];
  postMigrationResults?: PostMigrationActionResult[];
  sourceFolder: FolderRef | null;
  destFolders: Record<string, FolderRef>;
}

export interface JobWithItems extends Job {
  items: JobItem[];
}

export interface JobPlanStep {
  destId: string;
  destLabel: string;
  kind: JobItemKind;
  docId: string | null;
  docName: string | null;
}

export interface JobPlan {
  sourceId: string;
  sourceLabel: string;
  sourceFolder: FolderRef;
  destFolders: Record<string, FolderRef>;
  destIds: string[];
  docIds: string[];
  emptyFirst: boolean;
  steps: JobPlanStep[];
  // Hash of the steps. Execute sends the digest of the plan the user reviewed and is refused when a
  // fresh plan differs, so destination changes since the preview never run unreviewed.
  digest: string;
}

export interface JobEvent {
  jobId: string;
  itemId?: string;
  // 'done' is the last event of a stream: the job is no longer running and the server ends the response.
  type: 'item' | 'job' | 'post-migration' | 'done';
  status: JobItemStatus | JobStatus | 'done';
  error?: string;
  at: number;
}
