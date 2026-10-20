import type { OmniClient } from '../omni/client.js';
import { OmniError } from '../omni/client.js';
import type { OmniExportPayload } from '../omni/types.js';

// Tab-only fields and CTEs (query views) live in the export's `queryModels`: one QUERY-kind model per tab,
// extending the workbook model. The unstable import API recreates those models EMPTY (no views, no topics),
// so tiles that use them break on the target. The fix, proven on AU → UK:
//   1. rewrite source shared-model / connection IDs in the payload before import,
//   2. after import, pair each source tab with its imported tab (miniUuidMap) and copy the source
//      query model's extension YAML into the imported query model,
//   3. rewrite raw CTE column references ("cte"."view.field") to field references (${cte.alias}),
//      because a CTE re-created from YAML exposes its aliased column names, not the raw ones,
//   4. run every tile's query on the target to prove it compiles.

export interface TargetBinding {
  sharedModelId: string;
  connectionId: string;
  // Environment connection to bind query models to. Omni picks the environment per query run, so this
  // only needs to be a valid connection on the target; the base connection is used when unset.
  environmentConnectionId?: string;
}

/** Returns a copy of the export with every source shared-model and connection ID replaced by the target's. */
export function rewriteSourceIds(payload: OmniExportPayload, target: TargetBinding): { payload: OmniExportPayload; replaced: number } {
  const wm = payload.workbookModel;
  const map = new Map<string, string>();
  if (wm?.base_model_id) map.set(wm.base_model_id, target.sharedModelId);
  if (wm?.connection_id) map.set(wm.connection_id, target.connectionId);
  const envTarget = target.environmentConnectionId ?? target.connectionId;
  const envIds = [wm?.environment_connection_id, ...Object.values(payload.queryModels ?? {}).map(q => q.environment_connection_id)];
  for (const id of envIds) {
    if (id && !map.has(id)) map.set(id, envTarget);
  }
  for (const [from, to] of map) if (from === to) map.delete(from);

  let replaced = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const to = map.get(node);
      if (to === undefined) return node;
      replaced++;
      return to;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return { payload: walk(payload) as OmniExportPayload, replaced };
}

interface Tile {
  miniUuid: string;
  name: string;
  modelExtensionId: string | null;
  query: Record<string, unknown>;
}

export function listTiles(payload: OmniExportPayload): Tile[] {
  const dashboard = payload.dashboard as { queryPresentationCollection?: { queryPresentationCollectionMemberships?: unknown[] } } | undefined;
  const memberships = dashboard?.queryPresentationCollection?.queryPresentationCollectionMemberships ?? [];
  const tiles: Tile[] = [];
  for (const m of memberships) {
    const qp = (m as { queryPresentation?: Record<string, any> }).queryPresentation;
    const queryJson = qp?.query?.queryJson;
    if (!qp || !queryJson || typeof queryJson !== 'object') continue;
    tiles.push({
      miniUuid: String(qp.miniUuid ?? ''),
      name: String(qp.name ?? ''),
      modelExtensionId: typeof queryJson.model_extension_id === 'string' ? queryJson.model_extension_id : null,
      query: queryJson as Record<string, unknown>,
    });
  }
  return tiles;
}

/**
 * Pairs each source query model with the query model Omni created for the same tab on import.
 * Uses the import's miniUuidMap; falls back to the tile name when that name is unique on both sides.
 */
export function pairQueryModels(source: OmniExportPayload, imported: OmniExportPayload, miniUuidMap: Record<string, string>): Map<string, string> {
  const srcTiles = listTiles(source);
  const dstTiles = listTiles(imported);
  const dstByMini = new Map(dstTiles.map(t => [t.miniUuid, t]));
  const nameCount = (tiles: Tile[], name: string) => tiles.filter(t => t.name === name).length;

  const pairs = new Map<string, string>();
  for (const src of srcTiles) {
    if (!src.modelExtensionId) continue;
    const mapped = miniUuidMap[src.miniUuid];
    let dst = mapped ? dstByMini.get(mapped) : undefined;
    if (!dst && nameCount(srcTiles, src.name) === 1 && nameCount(dstTiles, src.name) === 1) {
      dst = dstTiles.find(t => t.name === src.name);
    }
    if (!dst) throw new Error(`tile "${src.name}" has tab-only fields but no matching tile was found in the imported dashboard`);
    if (!dst.modelExtensionId) throw new Error(`imported tile "${src.name}" has no query model to receive its tab-only fields`);
    const prev = pairs.get(src.modelExtensionId);
    if (prev && prev !== dst.modelExtensionId) throw new Error(`source query model ${src.modelExtensionId} maps to two imported query models`);
    pairs.set(src.modelExtensionId, dst.modelExtensionId);
  }
  return pairs;
}

const QUERY_VIEW_SUFFIX = '.query.view';

function viewNameOf(fileName: string): string {
  return fileName.slice(0, -QUERY_VIEW_SUFFIX.length).split('/').pop() ?? fileName;
}

/**
 * Reads the `query.fields` block of a query-view file: source field → output column alias.
 * Keys and values may be quoted, and comment lines or trailing comments are ignored.
 */
export function parseQueryViewAliases(yaml: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  const lines = yaml.split(/\r?\n/);
  let inQuery = false;
  let inFields = false;
  for (const line of lines) {
    if (/^\s*(#.*)?$/.test(line)) continue; // blank and comment lines never end a block
    if (/^\S/.test(line)) {
      inQuery = /^query:\s*(#.*)?$/.test(line);
      inFields = false;
      continue;
    }
    if (!inQuery) continue;
    if (/^ {2}\S/.test(line)) {
      inFields = /^ {2}fields:\s*(#.*)?$/.test(line);
      continue;
    }
    if (!inFields) continue;
    const m = line.match(/^ {4}(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w.[\]]*)):\s*["']?([A-Za-z_]\w*)["']?\s*(?:#.*)?$/);
    if (m) aliases[(m[1] ?? m[2] ?? m[3])!] = m[4]!;
  }
  return aliases;
}

const RAW_COLUMN_REF = /(?:"([A-Za-z_]\w*)"\.)?"([A-Za-z_]\w*\.[A-Za-z_]\w*(?:\[[A-Za-z_]\w*\])?)"/g;

// A quoted YAML key (`"view.field": alias`) is a field declaration, not a column reference inside SQL.
function isQuotedYamlKey(text: string, start: number, end: number): boolean {
  return /^[ \t]*:(?!:)/.test(text.slice(end)) && text.slice(text.lastIndexOf('\n', start - 1) + 1, start).trim() === '';
}

/**
 * Rewrites raw CTE column references to Omni field references so they survive re-creation from YAML:
 *   "cte"."view.field"             → ${cte.alias}    (any file)
 *   "cte"."view.field[timeframe]"  → ${cte.alias}    (any file)
 *   "view.field"                   → ${self.alias}   (only inside the CTE's own .query.view file)
 * References with no known alias are left unchanged and reported.
 */
export function fixRawColumnRefs(files: Record<string, string>): { files: Record<string, string>; changed: string[]; unresolved: string[] } {
  const aliasesByView = new Map<string, Record<string, string>>();
  for (const [fileName, yaml] of Object.entries(files)) {
    if (fileName.endsWith(QUERY_VIEW_SUFFIX)) aliasesByView.set(viewNameOf(fileName), parseQueryViewAliases(yaml));
  }
  const out: Record<string, string> = {};
  const changed: string[] = [];
  const unresolved: string[] = [];
  for (const [fileName, yaml] of Object.entries(files)) {
    const self = fileName.endsWith(QUERY_VIEW_SUFFIX) ? viewNameOf(fileName) : null;
    const next = yaml.replace(RAW_COLUMN_REF, (whole, cte: string | undefined, field: string, offset: number, text: string) => {
      const view = cte ?? self;
      if (!view || isQuotedYamlKey(text, offset, offset + whole.length)) return whole;
      const alias = aliasesByView.get(view)?.[field];
      if (!alias) {
        // A qualified ref to a non-CTE table is ordinary SQL; only report refs into a known CTE.
        if (aliasesByView.has(view)) unresolved.push(`${fileName}: ${whole}`);
        return whole;
      }
      return `\${${view}.${alias}}`;
    });
    if (next !== yaml) changed.push(fileName);
    out[fileName] = next;
  }
  return { files: out, changed, unresolved };
}

function isEmptyDefault(fileName: string, yaml: string): boolean {
  const body = yaml.trim();
  return (fileName === 'model' && body === '{}') || (fileName === 'relationships' && body === '[]');
}

/** True when a query model's extension files hold anything beyond the empty defaults (tab-only fields, CTEs). */
export function hasAuthoredContent(files: Record<string, string>): boolean {
  return Object.entries(files).some(([name, yaml]) => !isEmptyDefault(name, yaml));
}

// View and query-view files first, then relationships, then topics (topics reference the views).
function writeOrder(fileName: string): number {
  if (fileName.endsWith('.topic')) return 2;
  if (fileName === 'relationships') return 1;
  return 0;
}

export interface CopyResult {
  queryModels: number;
  filesWritten: number;
  refsRewritten: string[];
  warnings: string[];
}

/** Copies the extension YAML of each paired source query model into its imported query model. */
export async function copyQueryModels(
  sourceClient: OmniClient,
  destClient: OmniClient,
  pairs: Map<string, string>,
  sourceYamlCache: Map<string, Record<string, string>>,
): Promise<CopyResult> {
  const result: CopyResult = { queryModels: pairs.size, filesWritten: 0, refsRewritten: [], warnings: [] };
  for (const [srcId, dstId] of pairs) {
    let srcFiles = sourceYamlCache.get(srcId);
    if (!srcFiles) {
      srcFiles = (await sourceClient.getModelYaml(srcId, { mode: 'extension' })).files;
      sourceYamlCache.set(srcId, srcFiles);
    }
    const authored = Object.fromEntries(Object.entries(srcFiles).filter(([name, yaml]) => !isEmptyDefault(name, yaml)));
    if (Object.keys(authored).length === 0) continue;

    const fixed = fixRawColumnRefs(authored);
    result.refsRewritten.push(...fixed.changed.map(f => `${dstId}:${f}`));
    result.warnings.push(...fixed.unresolved);

    const dst = await destClient.getModelYaml(dstId, { mode: 'extension', includeChecksums: true });
    const names = Object.keys(fixed.files).sort((a, b) => writeOrder(a) - writeOrder(b) || a.localeCompare(b));
    for (const fileName of names) {
      const previousChecksum = dst.checksums?.[fileName];
      await destClient.writeModelYaml(dstId, {
        fileName,
        yaml: fixed.files[fileName]!,
        mode: 'extension',
        ...(previousChecksum ? { previousChecksum } : {}),
      });
      result.filesWritten++;
    }
  }
  return result;
}

export interface VerifyResult {
  checked: number;
  failures: { tile: string; error: string }[];
  timeouts: string[];
  unverified: { tile: string; reason: string }[];
}

// Errors that say nothing about the tile: auth/permission, rate limit, gateway/unavailable, transport failures.
// 500 stays a tile failure (documented 'Query execution error'); 400 and 404 are genuine tile failures too.
function isUnverifiable(err: unknown): boolean {
  if (!(err instanceof OmniError)) return true;
  return [401, 403, 429, 502, 503, 504].includes(err.status);
}

/**
 * Runs each tile's query (limit 5) on the target. A 400 means the tile cannot compile, i.e. it is broken.
 * A timeout, or an error unrelated to the tile (auth, rate limit, gateway, network), leaves it unverified.
 */
export async function verifyTiles(client: OmniClient, imported: OmniExportPayload, opts: { environmentConnectionId?: string; onlyTileNames?: Set<string> } = {}): Promise<VerifyResult> {
  const result: VerifyResult = { checked: 0, failures: [], timeouts: [], unverified: [] };
  const { onlyTileNames, ...runOpts } = opts;
  for (const tile of listTiles(imported)) {
    if (onlyTileNames && !onlyTileNames.has(tile.name)) continue;
    const query = { ...tile.query, limit: 5 };
    result.checked++;
    try {
      await client.runQuery(query, runOpts);
    } catch (err) {
      if (err instanceof OmniError && err.status === 408) {
        result.timeouts.push(tile.name);
        continue;
      }
      if (isUnverifiable(err)) {
        result.unverified.push({ tile: tile.name, reason: extractQueryError(err) });
        continue;
      }
      result.failures.push({ tile: tile.name, error: extractQueryError(err) });
    }
  }
  return result;
}

function extractQueryError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const detail = m ? JSON.parse(`"${m[1]}"`) as string : msg;
  return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
}
