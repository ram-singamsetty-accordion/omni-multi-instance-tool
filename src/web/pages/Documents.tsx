import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { FolderPicker } from '../lib/FolderPicker';
import type { FolderRef } from '../../shared/types';

export default function Documents() {
  const qc = useQueryClient();
  const { data: instances, isLoading: instancesLoading, error: instancesError } = useQuery({ queryKey: ['instances'], queryFn: api.listInstances });
  const sources = useMemo(() => instances?.filter(i => i.role === 'source') ?? [], [instances]);

  const [sourceId, setSourceId] = useState<string>('');
  const [folder, setFolder] = useState<FolderRef | null>(null);
  const src = useMemo(() => sources.find(s => s.id === sourceId), [sources, sourceId]);
  const folderId = folder?.id ?? src?.folderId ?? '';

  // Same key shape as Migrate, so both pages share the cached listing.
  const docs = useQuery({
    queryKey: ['folder', sourceId, folderId],
    queryFn: () => api.listFolder(sourceId, folder?.id),
    enabled: !!sourceId && !!folderId,
  });

  return (
    <div className="space-y-6">
      <section className="bg-zinc-900 border border-zinc-800 rounded p-4 space-y-4">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Source instance</label>
          <select
            value={sourceId}
            onChange={e => { setSourceId(e.target.value); setFolder(null); }}
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-sm"
          >
            <option value="">— pick source —</option>
            {sources.map(s => (
              <option key={s.id} value={s.id}>{s.label} ({s.baseUrl})</option>
            ))}
          </select>
          {instancesLoading && <div className="mt-1 text-xs text-zinc-500">loading…</div>}
          {instancesError && <div className="mt-1 text-xs text-red-400">{(instancesError as Error).message}</div>}
          {instances && sources.length === 0 && (
            <div className="mt-1 text-xs text-zinc-500">No source instances configured. Add one on the Instances page.</div>
          )}
          {src && (
            <div className="mt-2">
              <label className="block text-xs text-zinc-400 mb-1">Folder</label>
              <FolderPicker
                key={src.id}
                instanceId={src.id}
                value={folder}
                defaultFolder={{ id: src.folderId, path: src.folderPath }}
                onChange={setFolder}
              />
            </div>
          )}
        </div>
      </section>

      {sourceId && (
        <section className="bg-zinc-900 border border-zinc-800 rounded p-4">
          <div className="flex items-center mb-3">
            <h3 className="text-sm font-medium text-zinc-200">Documents</h3>
            <span className="ml-auto text-xs text-zinc-500">{docs.data?.length ?? 0} total</span>
          </div>
          {!folderId && <div className="text-sm text-amber-300">Pick a folder.</div>}
          {docs.isLoading && <div className="text-sm text-zinc-500">loading…</div>}
          {docs.error && <div className="text-sm text-red-400">{(docs.error as Error).message}</div>}
          {docs.data && (
            <ul className="divide-y divide-zinc-800 border border-zinc-800 rounded">
              {docs.data.map(d => (
                <DocumentRow
                  key={d.identifier}
                  instanceId={sourceId}
                  docId={d.identifier}
                  name={d.name}
                  description={d.description ?? null}
                  onSaved={() => qc.invalidateQueries({ queryKey: ['folder', sourceId] })}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function DocumentRow({
  instanceId,
  docId,
  name,
  description,
  onSaved,
}: {
  instanceId: string;
  docId: string;
  name: string;
  description: string | null;
  onSaved: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftDesc, setDraftDesc] = useState<string>('');
  const [draftName, setDraftName] = useState<string>('');
  const [clearExistingDraft, setClearExistingDraft] = useState(false);
  // Values at Edit time: only real changes are sent, so a refetch while the editor is open can't be reverted.
  const [orig, setOrig] = useState({ name: '', description: '' });

  const buildPatch = (): { name?: string; description?: string | null; clearExistingDraft?: boolean } => {
    const body: { name?: string; description?: string | null; clearExistingDraft?: boolean } = {};
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== orig.name.trim()) body.name = trimmed;
    if (draftDesc !== orig.description) body.description = draftDesc === '' ? null : draftDesc;
    return body;
  };
  const pending = buildPatch();
  const dirty = Object.keys(pending).length > 0;
  const renaming = pending.name !== undefined;

  const save = useMutation({
    mutationFn: () => {
      const body = buildPatch();
      // Each patch publishes a new version, so a save with no changes never reaches Omni.
      if (Object.keys(body).length === 0) return Promise.resolve({ ok: true as const });
      if (clearExistingDraft) body.clearExistingDraft = true;
      return api.patchDoc(instanceId, docId, body);
    },
    onSuccess: async () => {
      await onSaved();
      setEditing(false);
    },
  });

  const startEdit = (): void => {
    save.reset();
    setOrig({ name, description: description ?? '' });
    setEditing(true);
    setDraftDesc(description ?? '');
    setDraftName(name);
    setClearExistingDraft(false);
  };

  const submit = (): void => {
    if (renaming && !confirm(
      'Destination copies are matched by NAME during migration. Renaming this source document means the next migration will import a NEW destination document (new identifier, no schedules) instead of updating the existing one, and the old copy is left behind (or deleted if "Empty each destination folder" is on). Continue?',
    )) return;
    save.mutate();
  };

  return (
    <li className="p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-zinc-200 truncate">{name}</div>
          <div className="text-xs text-zinc-500 font-mono truncate">{docId}</div>
          {editing ? (
            <div className="mt-2 space-y-2">
              <input
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                maxLength={254}
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-sm"
                placeholder="Name"
              />
              <textarea
                value={draftDesc}
                onChange={e => setDraftDesc(e.target.value)}
                rows={3}
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-sm"
                placeholder="(empty = clear description)"
              />
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={clearExistingDraft}
                  onChange={e => setClearExistingDraft(e.target.checked)}
                />
                Clear existing draft (required if document has an unpublished draft)
              </label>
              <div className="flex gap-2">
                <button
                  disabled={save.isPending || draftName.trim() === '' || !dirty}
                  onClick={submit}
                  className="bg-emerald-500 text-emerald-950 rounded px-3 py-1 text-sm font-medium disabled:opacity-40"
                >
                  {save.isPending ? 'saving…' : 'Save'}
                </button>
                <button
                  disabled={save.isPending}
                  onClick={() => { setEditing(false); setDraftDesc(''); setDraftName(''); setClearExistingDraft(false); }}
                  className="text-zinc-400 hover:text-zinc-200 text-sm px-3 py-1 disabled:opacity-40"
                >
                  Cancel
                </button>
                {save.error && <span className="text-xs text-red-400 self-center">{(save.error as Error).message}</span>}
              </div>
            </div>
          ) : (
            <div className={`text-sm mt-1 whitespace-pre-wrap ${description ? 'text-zinc-400' : 'text-zinc-600 italic'}`}>
              {description || '(no description)'}
            </div>
          )}
        </div>
        {!editing && (
          <button
            onClick={startEdit}
            className="text-xs text-zinc-300 border border-zinc-700 rounded px-2 py-1 hover:bg-zinc-800"
          >
            Edit
          </button>
        )}
      </div>
    </li>
  );
}

