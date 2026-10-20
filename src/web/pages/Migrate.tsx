import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { FolderPicker } from '../lib/FolderPicker';
import type { FolderRef, JobPlan, OmniDoc, PostMigrationAction, PostMigrationActionResult } from '../../shared/types';

export default function Migrate() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: instances } = useQuery({ queryKey: ['instances'], queryFn: api.listInstances });

  const sources = useMemo(() => instances?.filter(i => i.role === 'source') ?? [], [instances]);
  const dests = useMemo(() => instances?.filter(i => i.role === 'destination') ?? [], [instances]);

  const [sourceId, setSourceId] = useState<string>('');
  const [destIds, setDestIds] = useState<string[]>([]);
  const [sourceFolder, setSourceFolder] = useState<FolderRef | null>(null);
  const [destFolders, setDestFolders] = useState<Record<string, FolderRef>>({});
  const [docIds, setDocIds] = useState<string[]>([]);
  const [emptyFirst, setEmptyFirst] = useState(false);
  const [plan, setPlan] = useState<JobPlan | null>(null);
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

  const selectedDestFolders = useMemo(() => {
    const out: Record<string, FolderRef> = {};
    for (const id of destIds) if (destFolders[id]) out[id] = destFolders[id]!;
    return out;
  }, [destIds, destFolders]);
  const destsMissingFolder = dests.filter(d => destIds.includes(d.id) && !destFolders[d.id] && !d.folderId);

  useEffect(() => {
    const actions = sourceInstance?.postMigrationActions ?? [];
    setPostMigrationActions(actions);
    setEnabledActionIndices(new Set(actions.map((_, i) => i)));
  }, [sourceId, sourceInstance?.postMigrationActions]);

  const preview = useMutation({
    mutationFn: () => api.previewJob({ sourceId, destIds, docIds, emptyFirst, sourceFolder: sourceFolder ?? undefined, destFolders: selectedDestFolders }),
    onSuccess: p => setPlan(p),
  });

  const execute = useMutation({
    mutationFn: () => api.createJob({
      sourceId, destIds, docIds, emptyFirst,
      sourceFolder: sourceFolder ?? undefined,
      destFolders: selectedDestFolders,
      postMigrationActions: postMigrationActions.filter((_, i) => enabledActionIndices.has(i)),
    }),
    onSuccess: ({ job }) => nav(`/jobs/${job.id}`),
  });

  const toggle = (arr: string[], id: string): string[] =>
    arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id];

  const canPreview = sourceId && destIds.length > 0 && docIds.length > 0 && destsMissingFolder.length === 0;

  return (
    <div className="space-y-6">
      <section className="bg-zinc-900 border border-zinc-800 rounded p-4 space-y-4">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Source</label>
          <select
            value={sourceId}
            onChange={e => { setSourceId(e.target.value); setSourceFolder(null); setDocIds([]); setPlan(null); }}
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
                instanceId={sourceInstance.id}
                value={sourceFolder}
                defaultFolder={{ id: sourceInstance.folderId, path: sourceInstance.folderPath }}
                onChange={f => { setSourceFolder(f); setDocIds([]); setPlan(null); }}
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
                  onChange={() => { setDestIds(toggle(destIds, d.id)); setPlan(null); }}
                />
                {d.label}
              </label>
            ))}
            {dests.length === 0 && <span className="text-sm text-zinc-500">No destinations. Add some under Instances.</span>}
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
                      setPlan(null);
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={emptyFirst} onChange={e => { setEmptyFirst(e.target.checked); setPlan(null); }} />
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
                        checked={docs.data.length > 0 && docIds.length === docs.data.length}
                        onChange={e => {
                          setDocIds(e.target.checked ? docs.data.map(d => d.identifier) : []);
                          setPlan(null);
                        }}
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
                              onChange={() => { setDocIds(toggle(docIds, d.identifier)); setPlan(null); }}
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
          sourceId={sourceId}
          actions={postMigrationActions}
          enabledIndices={enabledActionIndices}
          onChangeActions={actions => {
            setPostMigrationActions(actions);
            setEnabledActionIndices(new Set(actions.map((_, i) => i)));
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
            onClick={() => execute.mutate()}
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

  const labels = useQuery({
    queryKey: ['labels', instanceId],
    queryFn: () => api.listLabels(instanceId),
    enabled: needLabels,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (needDesc && desc.trim()) {
        await api.patchDoc(instanceId, doc.identifier, {
          description: desc,
          ...(clearExistingDraft ? { clearExistingDraft: true } : {}),
        });
      }
      if (needLabels && selected.length > 0) {
        await api.setDocumentLabels(instanceId, doc.identifier, { add: selected });
      }
    },
    onSuccess: () => onSaved(),
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
  onChangeActions: (actions: PostMigrationAction[]) => void;
  onToggleEnabled: (idx: number) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingAction, setEditingAction] = useState<PostMigrationAction | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [runResults, setRunResults] = useState<PostMigrationActionResult[] | null>(null);
  const [running, setRunning] = useState(false);

  const saveToSource = async (next: PostMigrationAction[]): Promise<void> => {
    await api.saveInstanceActions(sourceId, next);
    qc.invalidateQueries({ queryKey: ['instances'] });
  };

  const commitEdit = (): void => {
    if (!editingAction) return;
    const next = [...actions];
    if (editingIndex === null) next.push(editingAction);
    else next[editingIndex] = editingAction;
    onChangeActions(next);
    void saveToSource(next);
    setEditingAction(null);
    setEditingIndex(null);
  };

  const removeAction = (idx: number): void => {
    const next = actions.filter((_, i) => i !== idx);
    onChangeActions(next);
    void saveToSource(next);
  };

  const setHeader = (key: string, value: string): void => {
    if (!editingAction) return;
    setEditingAction({ ...editingAction, headers: { ...editingAction.headers, [key]: value } });
  };

  const addHeader = (): void => {
    if (!editingAction) return;
    setEditingAction({ ...editingAction, headers: { ...editingAction.headers, '': '' } });
  };

  const removeHeader = (key: string): void => {
    if (!editingAction) return;
    const { [key]: _, ...rest } = editingAction.headers;
    void _;
    setEditingAction({ ...editingAction, headers: rest });
  };

  const runNow = async (): Promise<void> => {
    setRunning(true);
    setRunResults(null);
    try {
      const enabled = actions.filter((_, i) => enabledIndices.has(i));
      const { results } = await api.runActions(enabled);
      setRunResults(results);
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
              <button className="text-zinc-500 hover:text-zinc-300" onClick={() => { setEditingAction(a); setEditingIndex(idx); }}>edit</button>
              <button className="text-red-500 hover:text-red-400" onClick={() => removeAction(idx)}>×</button>
            </div>
          ))}

          {editingAction !== null && (
            <div className="bg-zinc-950 border border-zinc-700 rounded p-3 space-y-2 text-xs">
              <div className="flex gap-2">
                <select
                  value={editingAction.method}
                  onChange={e => setEditingAction({ ...editingAction, method: e.target.value })}
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

              <div className="space-y-1">
                <div className="text-zinc-500">Headers</div>
                {Object.entries(editingAction.headers).map(([k, v]) => (
                  <div key={k} className="flex gap-1">
                    <input
                      className="w-36 bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 font-mono"
                      placeholder="Header-Name"
                      defaultValue={k}
                      onBlur={e => {
                        const newKey = e.target.value;
                        if (newKey !== k && editingAction) {
                          const { [k]: val, ...rest } = editingAction.headers;
                          setEditingAction({ ...editingAction, headers: { ...rest, [newKey]: val ?? v } });
                        }
                      }}
                    />
                    <input
                      className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 font-mono"
                      placeholder="value"
                      value={v}
                      onChange={e => setHeader(k, e.target.value)}
                    />
                    <button className="text-red-500 hover:text-red-400 px-1" onClick={() => removeHeader(k)}>×</button>
                  </div>
                ))}
                <button className="text-zinc-500 hover:text-zinc-300" onClick={addHeader}>+ header</button>
              </div>

              <div>
                <div className="text-zinc-500 mb-1">Body</div>
                <textarea
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 font-mono h-20 resize-y"
                  placeholder='{"key": "value"}'
                  value={editingAction.body}
                  onChange={e => setEditingAction({ ...editingAction, body: e.target.value })}
                />
              </div>

              <div className="flex gap-2">
                <button
                  className="bg-zinc-100 text-zinc-900 rounded px-3 py-1 font-medium disabled:opacity-40"
                  disabled={!editingAction.url}
                  onClick={commitEdit}
                >
                  {editingIndex === null ? 'Add' : 'Save'}
                </button>
                <button className="text-zinc-500 hover:text-zinc-300" onClick={() => { setEditingAction(null); setEditingIndex(null); }}>cancel</button>
              </div>
            </div>
          )}

          {editingAction === null && (
            <button
              className="text-xs text-violet-400 hover:text-violet-300"
              onClick={() => { setEditingAction({ ...blankAction }); setEditingIndex(null); }}
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
