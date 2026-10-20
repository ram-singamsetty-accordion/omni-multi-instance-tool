import { createHash } from 'node:crypto';
import type { Instance, OmniDoc, OmniFolder, OmniLabel } from '../../shared/types.js';
import type { OmniConnection, OmniDocState, OmniDraftPatch, OmniExportPayload, OmniImportResponse, OmniLabelsListResponse, OmniListResponse, OmniModelRecord, OmniModelYaml, OmniSchemaModel, ScimListResponse, ScimUser } from './types.js';

const TIMEOUT_MS = 60_000;
// Omni API limit: 60 req/min per key. Leave headroom → ~50/min ≈ 1200ms between requests.
const MIN_REQUEST_GAP_MS = 1200;
const MAX_RETRIES_ON_429 = 5;
// A Retry-After above this fails the request instead of parking it (and, via lastStart, the whole key).
const MAX_BACKOFF_MS = 60_000;

// Keyed by a digest so the maps never hold the plaintext API key.
const keyChain = new Map<string, Promise<void>>();
const lastStart = new Map<string, number>();
const rateId = (apiKey: string): string => createHash('sha256').update(apiKey).digest('hex');

async function acquireSlot(rateKey: string): Promise<void> {
  const prev = keyChain.get(rateKey) ?? Promise.resolve();
  const mine = prev.then(async () => {
    // Re-check after every sleep: a 429 on another in-flight request may have pushed the mark out meanwhile.
    for (;;) {
      const wait = (lastStart.get(rateKey) ?? 0) + MIN_REQUEST_GAP_MS - Date.now();
      if (wait <= 0) break;
      await sleep(wait);
    }
    lastStart.set(rateKey, Date.now());
  });
  keyChain.set(rateKey, mine.catch(() => {}));
  await mine;
}

async function backoffForRetry(rateKey: string, url: string, retryAfterSec: number | null, attempt: number): Promise<void> {
  const base = retryAfterSec !== null ? retryAfterSec * 1000 : Math.min(30_000, 1000 * 2 ** attempt);
  if (base > MAX_BACKOFF_MS) throw new OmniError(429, url, `rate limited; server asked to wait ${Math.round(base / 1000)}s`);
  lastStart.set(rateKey, Math.max(lastStart.get(rateKey) ?? 0, Date.now() + base)); // never shorten a longer cool-down
  await sleep(base);
}

function stripUserinfo(s: string): string {
  return s.replace(/(:\/\/)[^/\s@]*@/g, '$1');
}

function scrub(msg: string, apiKey: string): string {
  return stripUserinfo(apiKey ? msg.split(apiKey).join('[redacted]') : msg);
}

export class OmniError extends Error {
  constructor(public status: number, public url: string, message: string) {
    super(`${status} ${url}: ${message}`);
    this.name = 'OmniError';
  }

  // HTTP status this server answers with: an upstream failure, not a fault in this server (408 is generated locally by the client timeout).
  get statusCode(): number {
    return this.status === 429 ? 429 : this.status === 408 ? 504 : 502;
  }
}

export interface OmniClientOptions {
  // Per-client budget for client-timeout, network and 5xx retries (429 handling is unaffected).
  timeoutMs?: number;
  maxAttempts?: number;
}

export class OmniClient {
  private readonly rateKey: string;

  constructor(private readonly inst: Instance, private readonly opts: OmniClientOptions = {}) {
    this.rateKey = rateId(inst.apiKey);
  }

  get label(): string { return this.inst.label; }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const base = this.inst.baseUrl.trim().replace(/\/+$/, '');
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
    // false: a lost response (client timeout, 5xx, network error) is not retried, because the server may
    // already have done the work. Default: false for POST, true otherwise.
    retryTransient?: boolean;
    // false: an HTTP 5xx is thrown at once (work where each retry would rerun a warehouse query).
    retryServerErrors?: boolean;
    timeoutMs?: number;
  } = {}): Promise<Response> {
    const retryTransient = opts.retryTransient ?? method !== 'POST';
    const retryServerErrors = opts.retryServerErrors ?? true;
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs ?? TIMEOUT_MS;
    const lastTransientAttempt = (this.opts.maxAttempts ?? MAX_RETRIES_ON_429 + 1) - 1;
    const url = this.url(path, opts.query);
    const safeUrl = stripUserinfo(url);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.inst.apiKey}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES_ON_429; attempt++) {
      await acquireSlot(this.rateKey);
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
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
            throw new OmniError(429, safeUrl, text || 'rate limited');
          }
          const ra = parseRetryAfter(res.headers.get('retry-after'));
          await backoffForRetry(this.rateKey, safeUrl, ra, attempt);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new OmniError(res.status, safeUrl, text || res.statusText);
        }
        return res;
      } catch (err) {
        clearTimeout(t);
        lastErr = err;
        if (err instanceof OmniError) {
          // Final here: other 4xx, and a 429 that used up its retries or exceeded the Retry-After cap.
          if (err.status < 500) throw err;
          if (!retryTransient || !retryServerErrors) throw err;
        } else {
          // Request-construction failures (bad header value, credentials in the URL) are deterministic and
          // carry no `cause`; real network failures are TypeError('fetch failed') with one.
          if (err instanceof TypeError && (err as { cause?: unknown }).cause === undefined) {
            throw new OmniError(400, safeUrl, scrub(err.message, this.inst.apiKey));
          }
          const aborted = (err as { name?: string } | null)?.name === 'AbortError';
          if (aborted && (opts.retryTimeouts === false || !retryTransient)) {
            throw new OmniError(408, safeUrl, `no response within ${timeoutMs / 1000}s${retryTransient ? '' : '; the request may still have been applied'}`);
          }
          if (!retryTransient) throw err;
        }
        if (attempt >= lastTransientAttempt) break;
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
      isVerified: l.verified,
      isHomepageSection: l.homepage,
    }));
  }

  async createLabel(body: { name: string; color?: string | null; description?: string | null; isVerified?: boolean; isHomepageSection?: boolean }): Promise<void> {
    const payload: Record<string, unknown> = { name: body.name };
    if (body.color) payload.color = body.color;
    if (body.description !== undefined && body.description !== null) payload.description = body.description;
    if (body.isVerified) payload.verified = true;
    if (body.isHomepageSection) payload.homepage = true;
    // Safe to retry after a lost response: the runner tolerates the 409 for a label that already exists.
    try {
      await this.request('POST', '/api/v1/labels', { body: payload, retryTransient: true });
    } catch (err) {
      // Creating a verified or homepage label needs admin permission; fall back to a plain label.
      if ((payload.verified || payload.homepage) && err instanceof OmniError && err.status === 403) {
        console.warn(`[migrator] ${this.inst.label}: label "${body.name}" created without verified/homepage flags (admin permission required)`);
        delete payload.verified;
        delete payload.homepage;
        await this.request('POST', '/api/v1/labels', { body: payload, retryTransient: true });
        return;
      }
      throw err;
    }
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
    // Without a path Omni imports into its default location, not the folder the caller means.
    if (!folderPath) throw new Error('importDoc requires a folderPath');
    const payload: Record<string, unknown> = {
      ...exportPayload,
      baseModelId,
      document: { ...(exportPayload.document ?? {}), name: documentName },
      folderPath,
    };
    delete payload.identifier;
    // Not retried after a lost response: Omni may already have created the dashboard, and a retry would add a duplicate.
    const res = await this.request('POST', '/api/unstable/documents/import', { body: payload, timeoutMs: 180_000 });
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
    const want = modelId.trim();
    const res = await this.request('GET', '/api/v1/models', { query: { modelId: want } });
    const data = await res.json() as { records?: OmniModelRecord[] };
    // Ids are uuids, which are case-insensitive; the server returns the canonical lower-case form.
    return (data.records ?? []).find(r => r.id?.toLowerCase() === want.toLowerCase()) ?? null;
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
    // A checksummed write retried after a lost response would 409 against its own first write; a checksum-less one is idempotent.
    await this.request('POST', `/api/v1/models/${encodeURIComponent(modelId)}/yaml`, { body, retryTransient: !body.previousChecksum });
  }

  // Runs a semantic query and returns its rows. Omni returns 400 when a field cannot compile.
  async runQuery(query: Record<string, unknown>, opts: { environmentConnectionId?: string } = {}): Promise<unknown[]> {
    const body: Record<string, unknown> = { query, resultType: 'json', cache: 'SkipCache' };
    if (opts.environmentConnectionId) body.environmentConnectionId = opts.environmentConnectionId;
    // Not retried on a client-side timeout or a 5xx: each retry would rerun the same warehouse query.
    const res = await this.request('POST', '/api/v1/query/run', { body, retryTimeouts: false, retryTransient: true, retryServerErrors: false });
    const data = await res.json() as unknown;
    return Array.isArray(data) ? data : [];
  }

  async deleteDoc(identifier: string): Promise<void> {
    await this.request('DELETE', `/api/v1/documents/${encodeURIComponent(identifier)}`);
  }

  // PATCH /api/v1/documents/{identifier} was removed by Omni on 2026-07-31 (returns 410).
  // Metadata edits now go through the v2 draft workflow: patch a draft, then publish it.
  // `clearExistingDraft` discards any existing main-workspace draft first (DELETE /api/v1/documents/{id}/draft),
  // and discards the draft the patch created if the patch or publish then fails. Without it, a failed publish leaves its draft.
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
  // usage analytics, bookmarks and links survive. Discards any stale main draft first, and the
  // draft it created itself if the patch or publish fails.
  async updateDocContent(identifier: string, patch: OmniDraftPatch): Promise<void> {
    await this.patchAndPublish(identifier, patch, true);
  }

  // 404 means there is no draft to discard.
  private async discardDraft(identifier: string): Promise<void> {
    try {
      await this.request('DELETE', `/api/v1/documents/${encodeURIComponent(identifier)}/draft`);
    } catch (err) {
      if (!(err instanceof OmniError && err.status === 404)) throw err;
    }
  }

  private async patchAndPublish(identifier: string, patch: OmniDraftPatch, clearExistingDraft?: boolean): Promise<void> {
    const id = encodeURIComponent(identifier);
    if (clearExistingDraft) await this.discardDraft(identifier);
    try {
      await this.request('PATCH', `/api/v2/documents/${id}/draft`, { body: patch });
      await this.request('POST', `/api/v2/documents/${id}/draft/publish`);
    } catch (err) {
      // Only when this call cleared the draft first: whatever draft exists now came from our PATCH.
      // Without that, the draft may be an editor's work and is left alone. A publish that timed out (408)
      // may still be applied, so its draft is also left alone.
      if (clearExistingDraft && !(err instanceof OmniError && err.status === 408)) {
        await this.discardDraft(identifier).catch(discardErr => {
          console.warn(`[migrator] ${this.inst.label}: could not discard the draft left on ${identifier} after a failed update: ${discardErr instanceof Error ? discardErr.message : String(discardErr)}`);
        });
      }
      throw err; // the original error, so the runner still sees OmniError status 400
    }
  }

  async listConnections(): Promise<OmniConnection[]> {
    const res = await this.request('GET', '/api/v1/connections');
    const data = await res.json() as { connections: OmniConnection[] };
    return data.connections ?? [];
  }

  // onPage runs after each completed page (a caller's progress signal); throwing from it stops the paging.
  async listEmbedUsers(onPage?: () => void): Promise<ScimUser[]> {
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
      onPage?.();
      if (out.length >= data.totalResults || resources.length < count) break;
      startIndex += resources.length;
    }
    return out;
  }

  async refreshSchemaModel(modelId: string): Promise<{ jobId: string; modelId: string; status: string }> {
    const res = await this.request('POST', `/api/v1/models/${encodeURIComponent(modelId)}/refresh`);
    return await res.json() as { jobId: string; modelId: string; status: string };
  }

  async listSchemaModels(onPage?: () => void): Promise<OmniSchemaModel[]> {
    const out: OmniSchemaModel[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request('GET', '/api/v1/models', {
        query: { pageSize: 100, sortDirection: 'desc', sortField: 'updatedAt', modelKind: 'SCHEMA', ...(cursor ? { cursor } : {}) },
      });
      const data = await res.json() as { pageInfo?: { hasNextPage?: boolean; nextCursor?: string }; records: OmniSchemaModel[] };
      out.push(...(data.records ?? []));
      onPage?.();
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
