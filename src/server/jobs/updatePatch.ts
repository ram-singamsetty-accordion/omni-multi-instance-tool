import type { OmniDocState, OmniDraftPatch } from '../omni/types.js';

// Builds the v2 draft PATCH body that updates a destination dashboard in place from the source's
// state (both read with GET /api/v2/documents/{id}).

// Omni rejects a draft PATCH carrying more than 48 non-null query presentations.
const MAX_TABS_PER_PATCH = 48;

// Make the destination mirror the source while sending as little as possible: changed or new tabs
// and controls, null for ones that exist only at the destination, and order / settings / layout /
// description only when they differ. Anything omitted is left untouched by Omni.
// `changedTabs` names the tabs whose content changes (new or edited), for the verify step.
export function buildUpdatePatch(source: OmniDocState, dest: OmniDocState): { patch: OmniDraftPatch; changedTabs: string[] } {
  const patch: OmniDraftPatch = { summary: 'migration: update content from source' };
  const changedTabs: string[] = [];
  // The destination's own model ids, so the body has the same shape as a GET (which Omni documents
  // as a valid PATCH body). Omni rejects ids that don't match the document, so the source's must
  // never be sent.
  if (dest.modelId) patch.modelId = dest.modelId;
  if (dest.workbookModelId) patch.workbookModelId = dest.workbookModelId;
  if ((source.description ?? null) !== (dest.description ?? null)) patch.description = source.description ?? null;

  const srcTabs = source.queryPresentations?.data ?? {};
  const destTabs = (dest.queryPresentations?.data ?? {}) as Record<string, Record<string, unknown> | null>;
  const srcOrder = source.queryPresentations?.order;
  const sendTabOrder = !!srcOrder && canonical(srcOrder) !== canonical(dest.queryPresentations?.order);
  const tabData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(srcTabs)) {
    if (v === null || typeof v !== 'object') continue;
    // Cloned: the source state is cached and shared by every destination in the job.
    const { model_extension_id: _ignored, ...tab } = structuredClone(v) as Record<string, unknown>;
    const destTab = destTabs[k] ?? null;
    fillTableWrap(tab, destTab);
    if (destTab && canonical(tab) === canonical(omitKey(destTab, 'model_extension_id'))) {
      // Unchanged. Omni rejects an order naming tabs the patch doesn't carry, so when the order is
      // sent, resend unchanged tabs verbatim (Omni treats a verbatim tab as a no-op).
      if (sendTabOrder) tabData[k] = tab;
      continue;
    }
    // The v2 read strips each query's modelId (the "workbook model anchor"); the export payload
    // shows it is the document's workbook model. A changed tile is rejected without it
    // ("queryPresentations: expected string, received undefined").
    const query = tab.query as Record<string, unknown> | null | undefined;
    if (query && typeof query === 'object' && typeof query.modelId !== 'string' && dest.workbookModelId) {
      query.modelId = dest.workbookModelId;
    }
    tabData[k] = tab;
    changedTabs.push(String(tab.name ?? ''));
  }
  const tabCount = Object.keys(tabData).length;
  if (tabCount > MAX_TABS_PER_PATCH) {
    throw new Error(`update needs to send ${tabCount} tabs; Omni accepts at most ${MAX_TABS_PER_PATCH} per draft patch, so it can't be updated in place yet`);
  }
  for (const k of Object.keys(destTabs)) {
    if (!(k in srcTabs)) tabData[k] = null;
  }
  if (Object.keys(tabData).length > 0 || sendTabOrder) {
    patch.queryPresentations = { data: tabData };
    if (sendTabOrder) patch.queryPresentations.order = srcOrder;
  }

  if (source.controls) {
    const srcCtls = source.controls.data ?? {};
    const destCtls = dest.controls?.data ?? {};
    const sendCtlOrder = !!source.controls.order && canonical(source.controls.order) !== canonical(dest.controls?.order);
    const ctlData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(srcCtls)) {
      if (sendCtlOrder || !(k in destCtls) || canonical(v) !== canonical(destCtls[k])) ctlData[k] = v;
    }
    for (const k of Object.keys(destCtls)) {
      if (!(k in srcCtls)) ctlData[k] = null;
    }
    if (Object.keys(ctlData).length > 0 || sendCtlOrder) {
      patch.controls = { data: ctlData };
      if (sendCtlOrder) patch.controls.order = source.controls.order;
    }
  }
  if (source.settings && canonical(source.settings) !== canonical(dest.settings)) patch.settings = source.settings;
  if (Array.isArray(source.containers) && source.containers.length > 0 && canonical(source.containers) !== canonical(dest.containers)) {
    patch.containers = source.containers;
  }
  return { patch, changedTabs };
}

// True when the patch would change something (beyond the summary and the model ids).
export function hasContentChanges(patch: OmniDraftPatch): boolean {
  return patch.description !== undefined || !!patch.queryPresentations || !!patch.controls ||
    !!patch.settings || !!patch.containers;
}

// Short human summary of what a patch changes, for the job item note.
export function describeChanges(patch: OmniDraftPatch, changedTabs: string[]): string {
  const parts: string[] = [];
  if (changedTabs.length) {
    const shown = changedTabs.slice(0, 5).map(n => `"${n}"`).join(', ');
    parts.push(`${changedTabs.length} tab(s) changed: ${shown}${changedTabs.length > 5 ? ', …' : ''}`);
  }
  const removed = Object.values(patch.queryPresentations?.data ?? {}).filter(t => t === null).length;
  if (removed) parts.push(`${removed} tab(s) removed`);
  if (patch.queryPresentations?.order) parts.push('tab order');
  if (patch.controls) parts.push('filters');
  if (patch.settings) parts.push('settings');
  if (patch.containers) parts.push('layout');
  if (patch.description !== undefined) parts.push('description');
  return parts.join('; ');
}

// JSON with sorted object keys, so equal content compares equal regardless of key order.
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : x));
}

function omitKey(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = o;
  return rest;
}

// Older table tiles store text wrapping per column (columnFormats.*.wrap) and have no
// visConfig.config.wrapAllText; Omni's import fills it in. Do the same so the tile matches how
// Omni stores it: reuse the destination tile's value when it has one, else 'wrap' (what the
// import set for such a tile).
function fillTableWrap(tab: Record<string, unknown>, destTab: Record<string, unknown> | null): void {
  type TableVis = { visConfig?: { visType?: string; config?: Record<string, unknown> } };
  const inner = (tab.visConfig as TableVis | null)?.visConfig;
  if (inner?.visType !== 'omni-table' || !inner.config || typeof inner.config.wrapAllText === 'string') return;
  const destValue = (destTab?.visConfig as TableVis | null)?.visConfig?.config?.wrapAllText;
  inner.config.wrapAllText = typeof destValue === 'string' ? destValue : 'wrap';
}
