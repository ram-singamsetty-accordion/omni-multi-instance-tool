import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import type { FolderRef, Job, JobItem, JobItemKind, JobItemStatus, JobStatus, PostMigrationAction, PostMigrationActionResult } from '../../shared/types.js';

interface JobRow {
  id: string;
  source_id: string;
  dest_ids: string;
  doc_ids: string;
  empty_first: number;
  status: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  parent_job_id: string | null;
  post_migration_actions: string | null;
  post_migration_results: string | null;
  source_folder: string | null;
  dest_folders: string | null;
}

interface ItemRow {
  id: string;
  job_id: string;
  dest_id: string;
  kind: string;
  doc_id: string | null;
  doc_name: string | null;
  status: string;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
  export_hash: string | null;
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    sourceId: r.source_id,
    destIds: JSON.parse(r.dest_ids) as string[],
    docIds: JSON.parse(r.doc_ids) as string[],
    emptyFirst: r.empty_first === 1,
    status: r.status as JobStatus,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    parentJobId: r.parent_job_id,
    postMigrationActions: r.post_migration_actions ? (JSON.parse(r.post_migration_actions) as PostMigrationAction[]) : [],
    postMigrationResults: r.post_migration_results ? (JSON.parse(r.post_migration_results) as PostMigrationActionResult[]) : undefined,
    sourceFolder: r.source_folder ? (JSON.parse(r.source_folder) as FolderRef) : null,
    destFolders: r.dest_folders ? (JSON.parse(r.dest_folders) as Record<string, FolderRef>) : {},
  };
}

function rowToItem(r: ItemRow): JobItem {
  return {
    id: r.id,
    jobId: r.job_id,
    destId: r.dest_id,
    kind: r.kind as JobItemKind,
    docId: r.doc_id,
    docName: r.doc_name,
    status: r.status as JobItemStatus,
    error: r.error,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    exportHash: r.export_hash,
  };
}

export interface CreateJobRow {
  sourceId: string;
  destIds: string[];
  docIds: string[];
  emptyFirst: boolean;
  parentJobId?: string;
  postMigrationActions?: PostMigrationAction[];
  sourceFolder?: FolderRef | null;
  destFolders?: Record<string, FolderRef>;
}

const REDACTED = '********';

// The vault is the only encrypted store and the jobs table is plaintext SQLite, so header values and
// bodies (tokens) are never written to it. The run itself uses the real actions passed in memory.
function redactActions(actions: PostMigrationAction[]): PostMigrationAction[] {
  return actions.map(a => ({
    ...a,
    headers: Object.fromEntries(Object.keys(a.headers ?? {}).map(k => [k, REDACTED])),
    body: a.body ? REDACTED : '',
  }));
}

export function createJob(input: CreateJobRow): Job {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const actions = input.postMigrationActions ?? [];
  const sourceFolder = input.sourceFolder ?? null;
  const destFolders = input.destFolders ?? {};
  db.prepare(`
    INSERT INTO jobs (id, source_id, dest_ids, doc_ids, empty_first, status, created_at, parent_job_id, post_migration_actions, source_folder, dest_folders)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(
    id,
    input.sourceId,
    JSON.stringify(input.destIds),
    JSON.stringify(input.docIds),
    input.emptyFirst ? 1 : 0,
    now,
    input.parentJobId ?? null,
    actions.length > 0 ? JSON.stringify(redactActions(actions)) : null,
    sourceFolder ? JSON.stringify(sourceFolder) : null,
    Object.keys(destFolders).length > 0 ? JSON.stringify(destFolders) : null,
  );
  return {
    id,
    sourceId: input.sourceId,
    destIds: input.destIds,
    docIds: input.docIds,
    emptyFirst: input.emptyFirst,
    status: 'pending',
    createdAt: now,
    startedAt: null,
    endedAt: null,
    parentJobId: input.parentJobId ?? null,
    postMigrationActions: actions,
    sourceFolder,
    destFolders,
  };
}

export interface NewItem {
  jobId: string;
  destId: string;
  kind: JobItemKind;
  docId: string | null;
  docName: string | null;
}

export function createItems(items: NewItem[]): JobItem[] {
  if (items.length === 0) return [];
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO job_items (id, job_id, dest_id, kind, doc_id, doc_name, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);
  const created: JobItem[] = [];
  const txn = db.transaction((rows: NewItem[]) => {
    for (const r of rows) {
      const id = randomUUID();
      stmt.run(id, r.jobId, r.destId, r.kind, r.docId, r.docName);
      created.push({
        id,
        jobId: r.jobId,
        destId: r.destId,
        kind: r.kind,
        docId: r.docId,
        docName: r.docName,
        status: 'pending',
        error: null,
        startedAt: null,
        endedAt: null,
        exportHash: null,
      });
    }
  });
  txn(items);
  return created;
}

export function updateItem(id: string, patch: Partial<Pick<JobItem, 'status' | 'error' | 'startedAt' | 'endedAt' | 'exportHash'>>): void {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status); }
  if (patch.error !== undefined) { fields.push('error = ?'); values.push(patch.error); }
  if (patch.startedAt !== undefined) { fields.push('started_at = ?'); values.push(patch.startedAt); }
  if (patch.endedAt !== undefined) { fields.push('ended_at = ?'); values.push(patch.endedAt); }
  if (patch.exportHash !== undefined) { fields.push('export_hash = ?'); values.push(patch.exportHash); }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE job_items SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function updateJob(id: string, patch: Partial<Pick<Job, 'status' | 'startedAt' | 'endedAt' | 'postMigrationResults'>>): void {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status); }
  if (patch.startedAt !== undefined) { fields.push('started_at = ?'); values.push(patch.startedAt); }
  if (patch.endedAt !== undefined) { fields.push('ended_at = ?'); values.push(patch.endedAt); }
  if (patch.postMigrationResults !== undefined) { fields.push('post_migration_results = ?'); values.push(JSON.stringify(patch.postMigrationResults)); }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getJob(id: string): Job | undefined {
  const r = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  return r ? rowToJob(r) : undefined;
}

export function listJobs(limit = 50): Job[] {
  const rows = getDb().prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as JobRow[];
  return rows.map(rowToJob);
}

export function getItems(jobId: string): JobItem[] {
  const rows = getDb().prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY rowid').all(jobId) as ItemRow[];
  return rows.map(rowToItem);
}

export function getFailedItems(jobId: string): JobItem[] {
  const rows = getDb().prepare(`SELECT * FROM job_items WHERE job_id = ? AND status = 'failed'`).all(jobId) as ItemRow[];
  return rows.map(rowToItem);
}

// Job state only advances in memory, so a server stop leaves jobs 'running' and their unfinished
// items 'running'/'pending'. Called once at startup: marks those items failed (so Retry can pick
// them up) and gives each job the status its items imply. Returns the number of jobs closed.
export function failInterruptedJobs(): number {
  const db = getDb();
  const now = Date.now();
  const txn = db.transaction((): number => {
    db.prepare(`
      UPDATE job_items SET status = 'failed', ended_at = ?,
        error = CASE status
          WHEN 'running' THEN 'interrupted: the server stopped while this step was running; check the destination for a partial result before retrying'
          ELSE 'interrupted: the server stopped before this step ran'
        END
      WHERE status IN ('running', 'pending') AND job_id IN (SELECT id FROM jobs WHERE status IN ('pending', 'running'))
    `).run(now);
    return db.prepare(`
      UPDATE jobs SET ended_at = ?, status = CASE
        WHEN EXISTS (SELECT 1 FROM job_items i WHERE i.job_id = jobs.id AND i.status = 'failed')
          THEN CASE WHEN EXISTS (SELECT 1 FROM job_items i WHERE i.job_id = jobs.id AND i.status IN ('succeeded', 'skipped')) THEN 'partial' ELSE 'failed' END
        ELSE 'succeeded'
      END
      WHERE status IN ('pending', 'running')
    `).run(now).changes;
  });
  return txn();
}
