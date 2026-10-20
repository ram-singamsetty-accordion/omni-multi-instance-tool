import type { Instance, OmniDoc, OmniFolder, OmniLabel } from '../../shared/types.js';
import type { OmniConnection, OmniDocState, OmniDraftPatch, OmniExportPayload, OmniImportResponse, OmniLabelsListResponse, OmniListResponse, OmniModelRecord, OmniModelYaml, OmniSchemaModel, ScimListResponse, ScimUser } from './types.js';

const TIMEOUT_MS = 60_000;
// Omni API limit: 60 req/min per key. Leave headroom → ~50/min ≈ 1200ms between requests.
const MIN_REQUEST_GAP_MS = 1200;
const MAX_RETRIES_ON_429 = 5;

const keyChain = new Map<string, Promise<void>>();
const lastStart = new Map<string, number>();

async function acquireSlot(apiKey: string): Promise<void> {
  const prev = keyChain.get(apiKey) ?? Promise.resolve();
  const mine = prev.then(async () => {
    const last = lastStart.get(apiKey) ?? 0;
    const wait = Math.max(0, last + MIN_REQUEST_GAP_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastStart.set(apiKey, Date.now());
  });
  keyChain.set(apiKey, mine.catch(() => {}));
  await mine;
}

async function backoffForRetry(apiKey: string, retryAfterSec: number | null, attempt: number): Promise<void> {
  const base = retryAfterSec !== null ? retryAfterSec * 1000 : Math.min(30_000, 1000 * 2 ** attempt);
  lastStart.set(apiKey, Date.now() + base);
  await sleep(base);
}

export class OmniError extends Error {
  constructor(public status: number, public url: string, message: string) {
    super(`${status} ${url}: ${message}`);
    this.name = 'OmniError';
  }
}

export class OmniClient {
  constructor(private readonly inst: Instance) {}

  get label(): string { return this.inst.label; }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const base = this.inst.baseUrl.replace(/\/+$/, '');
    const u = new URL(`${base}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private async request(method: string, path: string, opts: {
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    // false: a client-side timeout fails at once as a 408 instead of being retried.
    retryTimeouts?: boolean;
  } = {}): Promise<Response> {
    const url = this.url(path, opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.inst.apiKey}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES_ON_429; attempt++) {
      await acquireSlot(this.inst.apiKey);
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        });
        clearTimeout(t);
        if (res.status === 429) {
          if (attempt >= MAX_RETRIES_ON_429) {
            const text = await res.text().catch(() => '');
            throw new OmniError(429, url, text || 'rate limited');
          }
          const ra = parseRetryAfter(res.headers.get('retry-after'));
          await backoffForRetry(this.inst.apiKey, ra, attempt);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new OmniError(res.status, url, text || res.statusText);
        }
        return res;
      } catch (err) {
        clearTimeout(t);
        lastErr = err;
        if (err instanceof OmniError) {
          if (err.status === 429) continue;
          if (err.status < 500) throw err;
        }
        if (opts.retryTimeouts === false && (err as { name?: string } | null)?.name === 'AbortError') {
          throw new OmniError(408, url, `no response within ${TIMEOUT_MS / 1000}s`);
        }
        if (attempt >= MAX_RETRIES_ON_429) break;
        await sleep(Math.min(10_000, 500 * 2 ** attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('omni request failed');
  }

  async listFolder(folderId: string, opts: { includeLabels?: boolean } = {}): Promise<OmniDoc[]> {
    const out: OmniDoc[] = [];
    let cursor: string | undefined;
    const include = opts.includeLabels ? 'labels' : undefined;
    do {
      const res = await this.request('GET', '/api/v1/documents', {
        query: { folderId, pageSize: 100, cursor, include },
      });
      const data = await res.json() as OmniListResponse;
      for (const r of data.records) {
        out.push({
          identifier: r.identifier,
          name: r.name,
          folderId: r.folderId,
          type: r.type,
          updatedAt: r.updatedAt,
          description: r.description ?? null,
          labels: Array.isArray(r.labels) ? r.labels : undefined,
        });
      }
      cursor = data.pageInfo?.hasNextPage ? data.pageInfo.nextCursor ?? undefined : undefined;
    } while (cursor);
    return out;
  }

  async listFolders(): Promise<OmniFolder[]> {
    const out: OmniFolder[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request('GET', '/api/v1/folders', { query: { pageSize: 100, cursor } });
      const data = await res.json() as { pageInfo?: { hasNextPage?: boolean; nextCursor?: string | null }; records?: OmniFolder[] };
      for (const f of data.records ?? []) out.push({ id: f.id, name: f.name, path: f.path, scope: f.scope });
      cursor = data.pageInfo?.hasNextPage ? data.pageInfo.nextCursor ?? undefined : undefined;
    } while (cursor);
    return out;
  }

  async listLabels(): Promise<OmniLabel[]> {
    const res = await this.request('GET', '/api/v1/labels');
    const data = await res.json() as OmniLabelsListResponse;
    return (data.labels ?? []).map(l => ({
      name: l.name,
      color: l.color ?? null,
      description: l.description ?? null,
      isVerified: l.isVerified,
      isHomepageSection: l.isHomepageSection,
    }));
  }

  async createLabel(body: { name: string; color?: string | null; description?: string | null; isVerified?: boolean; isHomepageSection?: boolean }): Promise<void> {
    const payload: Record<string, unknown> = { name: body.name };
    if (body.color) payload.color = body.color;
    if (body.description !== undefined && body.description !== null) payload.description = body.description;
    await this.request('POST', '/api/v1/labels', { body: payload });
  }

  async setDocumentLabels(identifier: string, add: string[], remove: string[] = []): Promise<void> {
    if (add.length === 0 && remove.length === 0) return;
    await this.request('PATCH', `/api/v1/documents/${encodeURIComponent(identifier)}/labels`, {
      body: { add, remove },
    });
  }

  async exportDoc(identifier: string): Promise<OmniExportPayload> {
    const res = await this.request('GET', `/api/unstable/documents/${encodeURIComponent(identifier)}/export`);
    return await res.json() as OmniExportPayload;
  }

  async importDoc(body: {
    exportPayload: OmniExportPayload;
    baseModelId: string;
    folderPath: string;
    documentName: string;
  }): Promise<OmniImportResponse & { raw: unknown }> {
    const { exportPayload, baseModelId, folderPath, documentName } = body;
    const payload: Record<string, unknown> = {
      ...exportPayload,
      baseModelId,
      document: { ...(exportPayload.document ?? {}), name: documentName },
    };
    if (folderPath) payload.folderPath = folderPath;
    delete payload.identifier;
    const res = await this.request('POST', '/api/unstable/documents/import', { body: payload });
    const raw = await res.json() as Record<string, unknown>;
    // The live response puts the new document under `workbook` ({ workbook: { identifier, documentId } }).
    const workbook = raw.workbook && typeof raw.workbook === 'object' ? raw.workbook as Record<string, unknown> : undefined;
    const identifier =
      (typeof workbook?.identifier === 'string' ? workbook.identifier : undefined) ??
      (typeof raw.identifier === 'string' ? raw.identifier : undefined) ??
      (raw.document && typeof (raw.document as any).identifier === 'string' ? (raw.document as any).identifier : undefined) ??
      (typeof raw.miniUuid === 'string' ? raw.miniUuid : undefined) ??
      '';
    const documentId =
      (typeof workbook?.documentId === 'string' ? workbook.documentId : undefined) ??
      (typeof raw.documentId === 'string' ? raw.documentId : undefined) ??
      (typeof raw.id === 'string' ? raw.id : undefined) ??
      (raw.document && typeof (raw.document as any).id === 'string' ? (raw.document as any).id : undefined) ??
      '';
    const miniUuidMap: Record<string, string> = {};
    if (raw.miniUuidMap && typeof raw.miniUuidMap === 'object') {
      for (const [k, v] of Object.entries(raw.miniUuidMap as Record<string, unknown>)) {
        if (typeof v === 'string') miniUuidMap[k] = v;
      }
    }
    return { documentId, identifier, miniUuidMap, raw };
  }

  async getModel(modelId: string): Promise<OmniModelRecord | null> {
    const res = await this.request('GET', '/api/v1/models', { query: { modelId } });
    const data = await res.json() as { records?: OmniModelRecord[] };
    return (data.records ?? []).find(r => r.id === modelId) ?? null;
  }

  // mode=extension returns only the files this model defines, not the files inherited from its base model.
  async getModelYaml(modelId: string, opts: { mode?: string; includeChecksums?: boolean } = {}): Promise<OmniModelYaml> {
    const res = await this.request('GET', `/api/v1/models/${encodeURIComponent(modelId)}/yaml`, {
      query: { mode: opts.mode, includeChecksums: opts.includeChecksums ? 'true' : undefined },
    });
    const data = await res.json() as OmniModelYaml;
    return { files: data.files ?? {}, checksums: data.checksums };
  }

  async writeModelYaml(modelId: string, body: { fileName: string; yaml: string; mode?: string; previousChecksum?: string }): Promise<void> {
    await this.request('POST', `/api/v1/models/${encodeURIComponent(modelId)}/yaml`, { body });
  }

  // Runs a semantic query and returns its rows. Omni returns 400 when a field cannot compile.
  async runQuery(query: Record<string, unknown>, opts: { environmentConnectionId?: string } = {}): Promise<unknown[]> {
    const body: Record<string, unknown> = { query, resultType: 'json', cache: 'SkipCache' };
    if (opts.environmentConnectionId) body.environmentConnectionId = opts.environmentConnectionId;
    // Not retried on a client-side timeout: each retry would rerun the same warehouse query.
    const res = await this.request('POST', '/api/v1/query/run', { body, retryTimeouts: false });
    const data = await res.json() as unknown;
    return Array.isArray(data) ? data : [];
  }

  async deleteDoc(identifier: string): Promise<void> {
    await this.request('DELETE', `/api/v1/documents/${encodeURIComponent(identifier)}`);
  }

  // PATCH /api/v1/documents/{identifier} was removed by Omni on 2026-07-31 (returns 410).
  // Metadata edits now go through the v2 draft workflow: patch a draft, then publish it.
  // `clearExistingDraft` discards any existing main-workspace draft first (DELETE /api/v1/documents/{id}/draft).
  async patchDoc(identifier: string, body: { name?: string; description?: string | null; summary?: string; clearExistingDraft?: boolean }): Promise<void> {
    const { clearExistingDraft, ...patch } = body;
    await this.patchAndPublish(identifier, patch, clearExistingDraft);
  }

  // Published state of a document (queryPresentations, controls, settings, containers).
  async getDocState(identifier: string): Promise<OmniDocState> {
    const res = await this.request('GET', `/api/v2/documents/${encodeURIComponent(identifier)}`);
    return await res.json() as OmniDocState;
  }

  // In-place content update: keeps the destination document's identifier, so schedules,
  // usage analytics, bookmarks and links survive. Discards any stale main draft first.
  async updateDocContent(identifier: string, patch: OmniDraftPatch): Promise<void> {
    await this.patchAndPublish(identifier, patch, true);
  }

  private async patchAndPublish(identifier: string, patch: OmniDraftPatch, clearExistingDraft?: boolean): Promise<void> {
    const id = encodeURIComponent(identifier);
    if (clearExistingDraft) {
      try {
        await this.request('DELETE', `/api/v1/documents/${id}/draft`);
      } catch (err) {
        if (!(err instanceof OmniError && err.status === 404)) throw err;
      }
    }
    await this.request('PATCH', `/api/v2/documents/${id}/draft`, { body: patch });
    await this.request('POST', `/api/v2/documents/${id}/draft/publish`);
  }

  async listConnections(): Promise<OmniConnection[]> {
    const res = await this.request('GET', '/api/v1/connections');
    const data = await res.json() as { connections: OmniConnection[] };
    return data.connections ?? [];
  }

  async listEmbedUsers(): Promise<ScimUser[]> {
    const out: ScimUser[] = [];
    let startIndex = 1;
    const count = 100;
    while (true) {
      const res = await this.request('GET', '/api/scim/v2/embed/users', {
        query: { count, startIndex },
      });
      const data = await res.json() as ScimListResponse;
      const resources = data.Resources ?? [];
      out.push(...resources);
      if (out.length >= data.totalResults || resources.length < count) break;
      startIndex += resources.length;
    }
    return out;
  }

  async refreshSchemaModel(modelId: string): Promise<{ jobId: string; modelId: string; status: string }> {
    const res = await this.request('POST', `/api/v1/models/${encodeURIComponent(modelId)}/refresh`);
    return await res.json() as { jobId: string; modelId: string; status: string };
  }

  async listSchemaModels(): Promise<OmniSchemaModel[]> {
    const out: OmniSchemaModel[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request('GET', '/api/v1/models', {
        query: { pageSize: 100, sortDirection: 'desc', sortField: 'updatedAt', modelKind: 'SCHEMA', ...(cursor ? { cursor } : {}) },
      });
      const data = await res.json() as { pageInfo?: { hasNextPage?: boolean; nextCursor?: string }; records: OmniSchemaModel[] };
      out.push(...(data.records ?? []));
      cursor = data.pageInfo?.hasNextPage ? data.pageInfo.nextCursor ?? undefined : undefined;
    } while (cursor);
    return out;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return n;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return null;
}
