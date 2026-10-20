import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, PlanChangedError } from '../lib/api';
import { FolderPicker } from '../lib/FolderPicker';
import type { FolderRef, JobPlan, OmniDoc, PostMigrationAction, PostMigrationActionResult } from '../../shared/types';

export default function Migrate() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: instances, isLoading: instancesLoading, error: instancesError } = useQuery({ queryKey: ['instances'], queryFn: api.listInstances });

  const sources = useMemo(() => instances?.filter(i => i.role === 'source') ?? [], [instances]);
  const dests = useMemo(() => instances?.filter(i => i.role === 'destination') ?? [], [instances]);

  const [sourceId, setSourceId] = useState<string>('');
  const [destIds, setDestIds] = useState<string[]>([]);
  const [sourceFolder, setSourceFolder] = useState<FolderRef | null>(null);
  const [destFolders, setDestFolders] = useState<Record<string, FolderRef>>({});
  const [docIds, setDocIds] = useState<string[]>([]);
  const [emptyFirst, setEmptyFirst] = useState(false);
  const [planState, setPlanState] = useState<{ plan: JobPlan; key: string } | null>(null);
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [postMigrationActions, setPostMigrationActions] = useState<PostMigrationAction[]>([]);
  const [enabledActionIndices, setEnabledActionIndices] = useState<Set<number>>(new Set());

  const sourceInstance = useMemo(() => instances?.find(i => i.id === sourceId), [instances, sourceId]);
  const sourceFolderId = sourceFolder?.id ?? sourceInstance?.folderId ?? '';

  const docs = useQuery({
    queryKey: ['folder', sourceId, sourceFolderId],
    queryFn: () => api.listFolder(sourceId, sourceFolder?.id),
    enabled: !!sourceId && !!sourceFolderId,
  });

  // Selected docs that vanished from the refetched listing (deleted, moved, archived) are dropped.
  const effectiveDocIds = useMemo(() => {
    if (!docs.data) return [];
    const present = new Set(docs.data.map(d => d.identifier));
    return docIds.filter(id => present.has(id));
  }, [docIds, docs.data]);
  useEffect(() => {
    if (docs.data && effectiveDocIds.length !== docIds.length) setDocIds(effectiveDocIds);
  }, [docs.data, effectiveDocIds, docIds]);

  const selectedDestFolders = useMemo(() => {
    const out: Record<string, FolderRef> = {};
    for (const id of destIds) if (destFolders[id]) out[id] = destFolders[id]!;
    return out;
  }, [destIds, destFolders]);
  const destsMissingFolder = dests.filter(d => destIds.includes(d.id) && !destFolders[d.id] && !d.folderId);

  // The plan is only valid for the exact form it was built from; any edit hides it and disables Execute.
  const formKey = JSON.stringify({ sourceId, destIds, docIds: effectiveDocIds, emptyFirst, sourceFolder, destFolders: selectedDestFolders });
  const plan = planState && planState.key === formKey ? planState.plan : null;

  // Only re-sync on a source change: a re-sync after each save's refetch would reset the per-run toggles.
  useEffect(() => {
    const actions = sourceInstance?.postMigrationActions ?? [];
    setPostMigrationActions(actions);
    setEnabledActionIndices(new Set(actions.map((_, i) => i)));
  }, [sourceId]);

  const preview = useMutation({
    mutationFn: async () => {
      const key = formKey;
      const p = await api.previewJob({ sourceId, destIds, docIds: effectiveDocIds, emptyFirst, sourceFolder: sourceFolder ?? undefined, destFolders: selectedDestFolders });
      return { p, key };
    },
    onSuccess: ({ p, key }) => {
      execute.reset();
      setPlanState({ plan: p, key });
    },
  });

  // Execute names the plan the user reviewed. If the destination changed since, the server runs
  // nothing and returns the new plan, which replaces the one on screen for a fresh review.
  const execute = useMutation({
    mutationFn: ({ plan: reviewed }: { plan: JobPlan; key: string }) => api.createJob({
      sourceId, destIds, docIds: effectiveDocIds, emptyFirst,
      expectedDigest: reviewed.digest,
      sourceFolder: sourceFolder ?? undefined,
      destFolders: selectedDestFolders,
      postMigrationActions: postMigrationActions.filter((_, i) => enabledActionIndices.has(i)),
    }),
    onSuccess: ({ job }) => nav(`/jobs/${job.id}`),
    onError: (e, { key }) => {
      if (e instanceof PlanChangedError) setPlanState({ plan: e.plan, key });
    },
  });

  const toggle = (arr: string[], id: string): string[] =>
    arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id];

  const canPreview = sourceId && destIds.length > 0 && effectiveDocIds.length > 0 && destsMissingFolder.length === 0;

  return (
    <div className="space-y-6">
      <section className="bg-zinc-900 border border-zinc-800 rounded p-4 space-y-4">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Source</label>
          <select
            value={sourceId}
            onChange={e => { setSourceId(e.target.value); setSourceFolder(null); setDocIds([]); }}
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-sm"
          >
            <option value="">— pick source —</option>
            {sources.map(s => (
              <option key={s.id} value={s.id}>{s.label} ({s.baseUrl})</option>
            ))}
          </select>
          {sourceInstance && (
            <div className="mt-2">
              <label className="block text-xs text-zinc-400 mb-1">Source folder</label>
              <FolderPicker
                key={sourceInstance.id}
                instanceId={sourceInstance.id}
                value={sourceFolder}
                defaultFolder={{ id: sourceInstance.folderId, path: sourceInstance.folderPath }}
                onChange={f => { setSourceFolder(f); setDocIds([]); }}
              />
            </div>
          )}
        </div>

        <div>
          <div className="text-xs text-zinc-400 mb-2">Destinations</div>
          <div className="flex flex-wrap gap-2">
            {dests.map(d => (
              <label
                key={d.id}
                className={`text-sm px-3 py-1.5 border rounded cursor-pointer ${destIds.includes(d.id) ? 'bg-blue-900/40 border-blue-700' : 'border-zinc-700'}`}
              >
                <input
                  type="checkbox"
                  className="mr-2"
                  checked={destIds.includes(d.id)}
                  onChange={() => setDestIds(toggle(destIds, d.id))}
                />
                {d.label}
              </label>
            ))}
            {instancesLoading && <span className="text-sm text-zinc-500">loading…</span>}
            {instancesError && <span className="text-sm text-red-400">{(instancesError as Error).message}</span>}
            {instances && dests.length === 0 && <span className="text-sm text-zinc-500">No destinations. Add some under Instances.</span>}
          </div>
          {destIds.length > 0 && (
            <div className="mt-3 space-y-2">
              {dests.filter(d => destIds.includes(d.id)).map(d => (
                <div key={d.id} className="grid grid-cols-[8rem_1fr] items-center gap-2">
                  <span className="text-xs text-zinc-400 truncate">{d.label} folder</span>
                  <FolderPicker
                    instanceId={d.id}
                    value={destFolders[d.id] ?? null}
                    defaultFolder={{ id: d.folderId, path: d.folderPath }}
                    onChange={f => {
                      setDestFolders(prev => {
                        const next = { ...prev };
                        if (f) next[d.id] = f; else delete next[d.id];
                        return next;
                      });
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={emptyFirst} onChange={e => setEmptyFirst(e.target.checked)} />
          Empty each destination folder before migrating (docs that already exist by name are still updated in place)
        </label>
      </section>

      {sourceId && (
        <section className="bg-zinc-900 border border-zinc-800 rounded p-4">
          <div className="flex items-center mb-3">
            <h3 className="text-sm font-medium text-zinc-200">Documents in source folder</h3>
            <span className="ml-auto text-xs text-zinc-500">{docs.data?.length ?? 0} total</span>
          </div>
          {!sourceFolderId && <div className="text-sm text-amber-300">Pick a source folder.</div>}
          {docs.isLoading && <div className="text-sm text-zinc-500">loading…</div>}
          {docs.error && <div className="text-sm text-red-400">{(docs.error as Error).message}</div>}
          {docs.data && (
            <div className="max-h-96 overflow-auto border border-zinc-800 rounded">
              <table className="w-full text-sm">
                <thead className="bg-zinc-950 sticky top-0">
                  <tr className="text-left text-xs text-zinc-500">
                    <th className="p-2 w-8">
                      <input
                        type="checkbox"
                        checked={docs.data.length > 0 && effectiveDocIds.length === docs.data.length}
                        onChange={e => setDocIds(e.target.checked ? docs.data.map(d => d.identifier) : [])}
                      />
                    </th>
                    <th className="p-2">Name</th>
                    <th className="p-2">Identifier</th>
                    <th className="p-2 w-32">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {docs.data.map(d => {
                    const missingDesc = !d.description || d.description.trim() === '';
                    const missingLabels = !d.labels || d.labels.length === 0;
                    const hasFlag = missingDesc || missingLabels;
                    const open = fixingId === d.identifier;
                    return (
                      <Fragment key={d.identifier}>
                        <tr className="border-t border-zinc-800">
                          <td className="p-2">
                            <input
                              type="checkbox"
                              checked={docIds.includes(d.identifier)}
                              onChange={() => setDocIds(toggle(effectiveDocIds, d.identifier))}
                            />
                          </td>
                          <td className="p-2">{d.name}</td>
                          <td className="p-2 text-zinc-500 font-mono text-xs">{d.identifier}</td>
                          <td className="p-2">
                            {hasFlag && (
                              <button
                                onClick={() => setFixingId(open ? null : d.identifier)}
                                className="flex gap-1 flex-wrap"
                                title="Click to fix"
                              >
                                {missingDesc && (
                                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-amber-700/60 bg-amber-900/30 text-amber-300 hover:bg-amber-900/50">
                                    no desc
                                  </span>
                                )}
                                {missingLabels && (
                                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-amber-700/60 bg-amber-900/30 text-amber-300 hover:bg-amber-900/50">
                                    no labels
                                  </span>
                                )}
                              </button>
                            )}
                          </td>
                        </tr>
                        {open && (
                          <tr className="border-t border-zinc-800 bg-zinc-950/60">
                            <td colSpan={4} className="p-3">
                              <FixPanel
                                instanceId={sourceId}
                                doc={d}
                                needDesc={missingDesc}
                                needLabels={missingLabels}
                                onClose={() => setFixingId(null)}
                                onSaved={() => {
                                  qc.invalidateQueries({ queryKey: ['folder', sourceId] });
                                  setFixingId(null);
                                }}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {sourceId && (
        <PostMigrationActionsEditor
          key={sourceId}
          sourceId={sourceId}
          actions={postMigrationActions}
          enabledIndices={enabledActionIndices}
          onChangeActions={(actions, enabled) => {
            setPostMigrationActions(actions);
            setEnabledActionIndices(enabled);
          }}
          onToggleEnabled={idx => setEnabledActionIndices(prev => {
            const next = new Set(prev);
            next.has(idx) ? next.delete(idx) : next.add(idx);
            return next;
          })}
        />
      )}

      <div className="flex gap-3">
        <button
          disabled={!canPreview || preview.isPending}
          onClick={() => preview.mutate()}
          className="bg-zinc-200 text-zinc-900 rounded px-4 py-2 font-medium disabled:opacity-40"
        >
          {preview.isPending ? 'building preview…' : 'Preview'}
        </button>
        {plan && (
          <button
            disabled={execute.isPending}
            onClick={() => execute.mutate({ plan, key: formKey })}
            className="bg-emerald-500 text-emerald-950 rounded px-4 py-2 font-medium disabled:opacity-40"
          >
            {execute.isPending ? 'starting…' : 'Execute migration'}
          </button>
        )}
      </div>

      {destsMissingFolder.length > 0 && (
        <div className="text-sm text-amber-300">
          Pick a folder for: {destsMissingFolder.map(d => d.label).join(', ')}
        </div>
      )}
      {preview.error && <div className="text-sm text-red-400">{(preview.error as Error).message}</div>}
      {plan && execute.error && (
        <div className={`text-sm ${execute.error instanceof PlanChangedError ? 'text-amber-300' : 'text-red-400'}`}>
          {(execute.error as Error).message}
        </div>
      )}
      {plan && <PlanView plan={plan} />}
    </div>
  );
}

function PlanView({ plan }: { plan: JobPlan }) {
  const byDest = plan.steps.reduce<Record<string, typeof plan.steps>>((acc, s) => {
    (acc[s.destId] ??= []).push(s);
    return acc;
  }, {});
  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded p-4">
      <h3 className="text-sm font-medium mb-1">Plan preview ({plan.steps.length} steps)</h3>
      <div className="text-xs text-zinc-500 mb-3">
        from {plan.sourceLabel} · <span className="font-mono">{plan.sourceFolder.path || plan.sourceFolder.id}</span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {Object.entries(byDest).map(([destId, steps]) => (
          <div key={destId} className="border border-zinc-800 rounded p-3">
            <div className="text-xs text-zinc-400 mb-2">
              {steps[0]!.destLabel}
              {plan.destFolders[destId] && (
                <span className="ml-2 font-mono text-zinc-500">→ {plan.destFolders[destId]!.path || plan.destFolders[destId]!.id}</span>
              )}
            </div>
            <ul className="text-sm space-y-1 max-h-60 overflow-auto">
              {steps.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className={`text-xs uppercase w-16 ${kindColor(s.kind)}`}>{s.kind}</span>
                  <span className="text-zinc-300 truncate">{s.docName ?? s.docId}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function FixPanel({
  instanceId,
  doc,
  needDesc,
  needLabels,
  onClose,
  onSaved,
}: {
  instanceId: string;
  doc: OmniDoc;
  needDesc: boolean;
  needLabels: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [desc, setDesc] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [clearExistingDraft, setClearExistingDraft] = useState(false);
  const [publishedDesc, setPublishedDesc] = useState<string | null>(null);
  const qc = useQueryClient();

  const labels = useQuery({
    queryKey: ['labels', instanceId],
    queryFn: () => api.listLabels(instanceId),
    enabled: needLabels,
  });

  const save = useMutation({
    mutationFn: async () => {
      // Each patchDoc publishes a new version, so a retry after a label failure must not repeat it.
      if (needDesc && desc.trim() && desc !== publishedDesc) {
        await api.patchDoc(instanceId, doc.identifier, {
          description: desc,
          ...(clearExistingDraft ? { clearExistingDraft: true } : {}),
        });
        setPublishedDesc(desc);
      }
      if (needLabels && selected.length > 0) {
        await api.setDocumentLabels(instanceId, doc.identifier, { add: selected });
      }
    },
    onSuccess: () => onSaved(),
    // The description may already be published; refetch so the row and needDesc reflect it.
    onError: () => { qc.invalidateQueries({ queryKey: ['folder', instanceId] }); },
  });

  const toggleLabel = (name: string): void =>
    setSelected(prev => (prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]));

  const nothingToSave =
    (!needDesc || desc.trim() === '') && (!needLabels || selected.length === 0);

  return (
    <div className="space-y-3">
      {needDesc && (
        <div>
          <div className="text-xs text-zinc-400 mb-1">Description</div>
          <textarea
            value={desc}
            onChange={e => setDesc(e.target.value)}
            rows={3}
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-sm"
            placeholder="Add a description"
          />
          <label className="flex items-center gap-2 text-xs text-zinc-400 mt-1">
            <input
              type="checkbox"
              checked={clearExistingDraft}
              onChange={e => setClearExistingDraft(e.target.checked)}
            />
            Clear existing draft (required if document has an unpublished draft)
          </label>
        </div>
      )}
      {needLabels && (
        <div>
          <div className="text-xs text-zinc-400 mb-1">Labels</div>
          {labels.isLoading && <div className="text-xs text-zinc-500">loading labels…</div>}
          {labels.error && <div className="text-xs text-red-400">{(labels.error as Error).message}</div>}
          {labels.data && (
            labels.data.length === 0 ? (
              <div className="text-xs text-zinc-500">No labels exist in this instance.</div>
            ) : (
              <div className="flex flex-wrap gap-1.5 max-h-40 overflow-auto">
                {labels.data.map(l => {
                  const on = selected.includes(l.name);
                  return (
                    <button
                      key={l.name}
                      onClick={() => toggleLabel(l.name)}
                      className={`text-xs px-2 py-0.5 rounded border ${
                        on
                          ? 'bg-blue-900/40 border-blue-700 text-blue-200'
                          : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      {l.name}
                    </button>
                  );
                })}
              </div>
            )
          )}
        </div>
      )}
      <div className="flex gap-2">
        <button
          disabled={save.isPending || nothingToSave}
          onClick={() => save.mutate()}
          className="bg-emerald-500 text-emerald-950 rounded px-3 py-1 text-sm font-medium disabled:opacity-40"
        >
          {save.isPending ? 'saving…' : 'Save'}
        </button>
        <button
          onClick={onClose}
          className="text-zinc-400 hover:text-zinc-200 text-sm px-3 py-1"
        >
          Cancel
        </button>
        {save.error && <span className="text-xs text-red-400 self-center">{(save.error as Error).message}</span>}
      </div>
    </div>
  );
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const blankAction: PostMigrationAction = { method: 'POST', url: '', headers: {}, body: '' };

// Header rows carry a stable id so renaming one never remounts it or collides with another.
interface HeaderRow { id: number; key: string; value: string }
let rowSeq = 0;
const toRows = (h: Record<string, string>): HeaderRow[] =>
  Object.entries(h).map(([key, value]) => ({ id: ++rowSeq, key, value }));

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function ActionResult({ result: r }: { result: PostMigrationActionResult }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`text-xs rounded ${r.ok ? 'bg-emerald-950' : 'bg-red-950'}`}>
      <button
        className={`w-full flex items-center gap-2 px-2 py-1 text-left ${r.ok ? 'text-emerald-300' : 'text-red-300'}`}
        onClick={() => (r.responseBody || r.error) && setOpen(v => !v)}
      >
        <span className="font-mono">{r.method}</span>
        <span className="font-mono flex-1 truncate">{r.url}</span>
        <span>{r.status ?? 'network error'}</span>
        {(r.responseBody || r.error) && <span className="opacity-50">{open ? '▾' : '▸'}</span>}
      </button>
      {open && (
        <pre className={`px-2 pb-2 text-xs overflow-x-auto whitespace-pre-wrap break-all ${r.ok ? 'text-emerald-400/80' : 'text-red-400/80'}`}>
          {r.error ?? r.responseBody}
        </pre>
      )}
    </div>
  );
}

function PostMigrationActionsEditor({
  sourceId,
  actions,
  enabledIndices,
  onChangeActions,
  onToggleEnabled,
}: {
  sourceId: string;
  actions: PostMigrationAction[];
  enabledIndices: Set<number>;
  onChangeActions: (actions: PostMigrationAction[], enabled: Set<number>) => void;
  onToggleEnabled: (idx: number) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingAction, setEditingAction] = useState<PostMigrationAction | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [runResults, setRunResults] = useState<PostMigrationActionResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const nameCounts = new Map<string, number>();
  for (const r of headerRows) {
    const n = r.key.trim().toLowerCase();
    if (n) nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
  }
  const dupIds = new Set(headerRows.filter(r => (nameCounts.get(r.key.trim().toLowerCase()) ?? 0) > 1).map(r => r.id));

  const startEdit = (action: PostMigrationAction, index: number | null): void => {
    setEditingAction(action);
    setEditingIndex(index);
    setHeaderRows(toRows(action.headers));
  };

  const closeEdit = (): void => {
    setEditingAction(null);
    setEditingIndex(null);
    setHeaderRows([]);
  };

  const saveToSource = async (next: PostMigrationAction[], prev: PostMigrationAction[], prevEnabled: Set<number>): Promise<void> => {
    setActionError(null);
    try {
      await api.saveInstanceActions(sourceId, next);
      qc.invalidateQueries({ queryKey: ['instances'] });
    } catch (e) {
      // Roll back explicitly: the refetch returns the unchanged server list, which no longer re-syncs the parent.
      // Skip it if the source changed meanwhile, since prev belongs to the previous source.
      if (!mounted.current) return;
      onChangeActions(prev, prevEnabled);
      setActionError(`Could not save actions: ${(e as Error).message}`);
    }
  };

  const commitEdit = (): void => {
    if (!editingAction) return;
    const saved: PostMigrationAction = {
      ...editingAction,
      url: editingAction.url.trim(),
      headers: Object.fromEntries(headerRows.filter(r => r.key.trim()).map(r => [r.key.trim(), r.value])),
      body: editingAction.method === 'GET' ? '' : editingAction.body,
    };
    const next = [...actions];
    let enabled = enabledIndices;
    if (editingIndex === null) {
      next.push(saved);
      enabled = new Set([...enabledIndices, next.length - 1]);
    } else {
      next[editingIndex] = saved;
    }
    onChangeActions(next, enabled);
    void saveToSource(next, actions, enabledIndices);
    closeEdit();
  };

  const removeAction = (idx: number): void => {
    const next = actions.filter((_, i) => i !== idx);
    const enabled = new Set([...enabledIndices].filter(i => i !== idx).map(i => (i > idx ? i - 1 : i)));
    onChangeActions(next, enabled);
    void saveToSource(next, actions, enabledIndices);
  };

  const setHeaderKey = (id: number, key: string): void =>
    setHeaderRows(rows => rows.map(r => (r.id === id ? { ...r, key } : r)));

  const setHeaderValue = (id: number, value: string): void =>
    setHeaderRows(rows => rows.map(r => (r.id === id ? { ...r, value } : r)));

  const addHeader = (): void => setHeaderRows(rows => [...rows, { id: ++rowSeq, key: '', value: '' }]);

  const removeHeader = (id: number): void => setHeaderRows(rows => rows.filter(r => r.id !== id));

  const runNow = async (): Promise<void> => {
    setRunning(true);
    setRunResults(null);
    setActionError(null);
    try {
      const enabled = actions.filter((_, i) => enabledIndices.has(i));
      const { results } = await api.runActions(enabled);
      setRunResults(results);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const enabledCount = actions.filter((_, i) => enabledIndices.has(i)).length;

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-sm text-left"
        onClick={() => setOpen(v => !v)}
      >
        <span className="font-medium text-zinc-200">
          Post-migration actions
          {actions.length > 0 && (
            <span className="ml-2 text-xs text-violet-400">
              {enabledCount}/{actions.length} enabled
            </span>
          )}
        </span>
        <span className="text-zinc-500 text-xs">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="border-t border-zinc-800 px-4 pb-4 pt-3 space-y-3">
          <p className="text-xs text-zinc-500">
            Saved to this source. Enabled actions run in order after all destinations finish. Toggle per run.
          </p>

          {actions.length === 0 && editingAction === null && (
            <div className="text-xs text-zinc-600">No actions configured.</div>
          )}

          {actions.map((a, idx) => (
            <div key={idx} className={`flex items-center gap-2 bg-zinc-950 rounded px-2 py-1.5 text-xs ${!enabledIndices.has(idx) ? 'opacity-40' : ''}`}>
              <input
                type="checkbox"
                checked={enabledIndices.has(idx)}
                onChange={() => onToggleEnabled(idx)}
                className="shrink-0"
              />
              <span className="font-mono text-zinc-400 w-14 shrink-0">{a.method}</span>
              <span className="font-mono text-zinc-300 flex-1 truncate">{a.url}</span>
              <button
                className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                disabled={editingAction !== null}
                onClick={() => startEdit(a, idx)}
              >
                edit
              </button>
              <button
                className="text-red-500 hover:text-red-400 disabled:opacity-40"
                disabled={editingAction !== null}
                onClick={() => removeAction(idx)}
              >
                ×
              </button>
            </div>
          ))}

          {editingAction !== null && (
            <div className="bg-zinc-950 border border-zinc-700 rounded p-3 space-y-2 text-xs">
              <div className="flex gap-2">
                <select
                  value={editingAction.method}
                  onChange={e => setEditingAction({ ...editingAction, method: e.target.value, ...(e.target.value === 'GET' ? { body: '' } : {}) })}
                  className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
                >
                  {HTTP_METHODS.map(m => <option key={m}>{m}</option>)}
                </select>
                <input
                  className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 font-mono"
                  placeholder="https://example.com/webhook"
                  value={editingAction.url}
                  onChange={e => setEditingAction({ ...editingAction, url: e.target.value })}
                />
              </div>
              {editingAction.url.trim() !== '' && !isHttpUrl(editingAction.url) && (
                <div className="text-amber-300">URL must be a full http:// or https:// address.</div>
              )}

              <div className="space-y-1">
                <div className="text-zinc-500">Headers</div>
                {headerRows.map(row => (
                  <div key={row.id} className="flex gap-1">
                    <input
                      className={`w-36 bg-zinc-900 border rounded px-2 py-0.5 font-mono ${dupIds.has(row.id) ? 'border-red-500' : 'border-zinc-700'}`}
                      placeholder="Header-Name"
                      title={dupIds.has(row.id) ? 'Duplicate header name' : undefined}
                      value={row.key}
                      onChange={e => setHeaderKey(row.id, e.target.value)}
                    />
                    <input
                      className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 font-mono"
                      placeholder="value"
                      value={row.value}
                      onChange={e => setHeaderValue(row.id, e.target.value)}
                    />
                    <button className="text-red-500 hover:text-red-400 px-1" onClick={() => removeHeader(row.id)}>×</button>
                  </div>
                ))}
                {dupIds.size > 0 && <div className="text-red-400">Duplicate header names. Rename or remove one.</div>}
                <button className="text-zinc-500 hover:text-zinc-300" onClick={addHeader}>+ header</button>
              </div>

              <div>
                <div className="text-zinc-500 mb-1">Body</div>
                <textarea
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 font-mono h-20 resize-y disabled:opacity-40"
                  placeholder={editingAction.method === 'GET' ? 'GET requests send no body' : '{"key": "value"}'}
                  disabled={editingAction.method === 'GET'}
                  value={editingAction.body}
                  onChange={e => setEditingAction({ ...editingAction, body: e.target.value })}
                />
              </div>

              <div className="flex gap-2">
                <button
                  className="bg-zinc-100 text-zinc-900 rounded px-3 py-1 font-medium disabled:opacity-40"
                  disabled={!isHttpUrl(editingAction.url) || dupIds.size > 0}
                  onClick={commitEdit}
                >
                  {editingIndex === null ? 'Add' : 'Save'}
                </button>
                <button className="text-zinc-500 hover:text-zinc-300" onClick={closeEdit}>cancel</button>
              </div>
            </div>
          )}

          {editingAction === null && (
            <button
              className="text-xs text-violet-400 hover:text-violet-300"
              onClick={() => startEdit({ ...blankAction }, null)}
            >
              + add action
            </button>
          )}

          {enabledCount > 0 && editingAction === null && (
            <div className="pt-1">
              <button
                className="text-xs bg-violet-900 text-violet-200 hover:bg-violet-800 rounded px-3 py-1 disabled:opacity-40"
                disabled={running}
                onClick={() => void runNow()}
              >
                {running ? 'running…' : `test run (${enabledCount})`}
              </button>
            </div>
          )}

          {actionError && <div className="text-xs text-red-400 break-all">{actionError}</div>}

          {runResults && (
            <div className="space-y-1">
              {runResults.map(r => <ActionResult key={r.index} result={r} />)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function kindColor(k: string): string {
  if (k === 'delete') return 'text-red-400';
  if (k === 'export') return 'text-amber-400';
  if (k === 'update') return 'text-violet-400';
  if (k === 'meta') return 'text-sky-400';
  if (k === 'models') return 'text-violet-400';
  if (k === 'verify') return 'text-teal-400';
  return 'text-emerald-400';
}
