import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { resetDashboardCache } from '../lib/dashboardCache';
import type { DashboardFilter, Instance, InstancePublic, InstanceRole } from '../../shared/types';

type DashboardTab = 'connections' | 'users';

function tabEnabled(inst: InstancePublic, tab: DashboardTab): boolean {
  if (!inst.dashboardTabs) return true;
  return inst.dashboardTabs.includes(tab);
}

const blank: Omit<Instance, 'id'> = {
  label: '',
  role: 'destination',
  baseUrl: '',
  apiKey: '',
  userId: '',
  modelId: '',
  folderId: '',
  folderPath: '',
  entityGroupSeparator: '',
};

export default function Instances() {
  const qc = useQueryClient();
  const { data: instances, isLoading, error: loadError } = useQuery({ queryKey: ['instances'], queryFn: api.listInstances });
  const [form, setForm] = useState<Omit<Instance, 'id'> & { id?: string }>(blank);

  const setTabs = useMutation({
    mutationFn: ({ id, tabs }: { id: string; tabs: DashboardTab[] }) =>
      api.setInstanceDashboardTabs(id, tabs),
    // Resetting an observer detaches its in-flight mutation, so only clear a finished one.
    onMutate: () => { if (!del.isPending) del.reset(); },
    onSuccess: () => {
      resetDashboardCache(qc);
      return qc.invalidateQueries({ queryKey: ['instances'] });
    },
  });

  const toggleTab = (inst: InstancePublic, tab: DashboardTab) => {
    const current = inst.dashboardTabs ?? ['connections', 'users'];
    const next = tabEnabled(inst, tab)
      ? current.filter(t => t !== tab)
      : [...new Set([...current, tab])];
    setTabs.mutate({ id: inst.id, tabs: next });
  };
  const saveFilter = useMutation({
    mutationFn: ({ id, filter }: { id: string; filter: DashboardFilter }) =>
      api.setInstanceDashboardFilter(id, filter),
    onSuccess: () => {
      resetDashboardCache(qc);
      return qc.invalidateQueries({ queryKey: ['instances'] });
    },
  });
  const saveFilterFor = (id: string, filter: DashboardFilter) =>
    saveFilter.mutateAsync({ id, filter });
  const create = useMutation({
    mutationFn: (b: Omit<Instance, 'id'>) => api.createInstance(b),
    onSuccess: () => {
      setForm(blank);
      qc.invalidateQueries({ queryKey: ['instances'] });
      resetDashboardCache(qc);
    },
  });
  const update = useMutation({
    mutationFn: ({ id, b }: { id: string; b: Omit<Instance, 'id'> }) => api.updateInstance(id, b),
    onSuccess: () => {
      setForm(blank);
      qc.invalidateQueries({ queryKey: ['instances'] });
      resetDashboardCache(qc);
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteInstance(id),
    onMutate: () => { if (!setTabs.isPending) setTabs.reset(); },
    onSuccess: (_d, id) => {
      setForm(f => (f.id === id ? blank : f));
      qc.invalidateQueries({ queryKey: ['instances'] });
      resetDashboardCache(qc);
    },
  });

  const formError = form.id ? update.error : create.error;
  const listError = del.error ?? setTabs.error;

  const submit = (): void => {
    if (create.isPending || update.isPending) return;
    const { id, ...body } = form;
    if (id) update.mutate({ id, b: body });
    else create.mutate(body);
  };

  const cancelEdit = (): void => {
    create.reset();
    update.reset();
    setForm(blank);
  };

  const startEdit = (i: InstancePublic): void => {
    create.reset();
    update.reset();
    setForm({
      id: i.id,
      label: i.label,
      role: i.role,
      baseUrl: i.baseUrl,
      apiKey: '',
      userId: i.userId,
      modelId: i.modelId,
      folderId: i.folderId,
      folderPath: i.folderPath,
      entityGroupSeparator: i.entityGroupSeparator ?? '',
    });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <section>
        <h2 className="text-lg font-medium mb-3">Instances</h2>
        <div className="space-y-2">
          {listError && (
            <div className="text-xs text-red-400 break-words whitespace-pre-wrap mb-2">{listError.message}</div>
          )}
          {isLoading && <div className="text-sm text-zinc-500">loading…</div>}
          {loadError && (
            <div className="text-sm text-red-400 break-words whitespace-pre-wrap">{(loadError as Error).message}</div>
          )}
          {instances?.map(i => (
            <div key={i.id} className="bg-zinc-900 border border-zinc-800 rounded text-sm">
              <div className="p-3 flex items-center gap-3">
                <span className={`text-xs px-2 py-0.5 rounded ${i.role === 'source' ? 'bg-emerald-900 text-emerald-200' : 'bg-blue-900 text-blue-200'}`}>
                  {i.role}
                </span>
                <div className="flex-1">
                  <div className="text-zinc-100">{i.label}</div>
                  <div className="text-zinc-500 text-xs">{i.baseUrl} · key {i.apiKeyMasked}</div>
                </div>
                <div className="flex items-center gap-1">
                  {(['connections', 'users'] as DashboardTab[]).map(tab => {
                    const on = tabEnabled(i, tab);
                    return (
                      <button
                        key={tab}
                        onClick={() => toggleTab(i, tab)}
                        disabled={setTabs.isPending}
                        title={on ? `Hide from ${tab} tab` : `Show in ${tab} tab`}
                        className={`text-xs px-1.5 py-0.5 rounded border transition-colors disabled:opacity-60 ${
                          on
                            ? 'border-emerald-800 text-emerald-400 hover:border-emerald-600'
                            : 'border-zinc-800 text-zinc-600 hover:text-zinc-400'
                        }`}
                      >
                        {tab[0]!.toUpperCase()}
                      </button>
                    );
                  })}
                </div>
                <button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={() => startEdit(i)}>edit</button>
                <button
                  className="text-xs text-red-400 hover:text-red-300"
                  onClick={() => { if (confirm(`Delete ${i.label}?`)) del.mutate(i.id); }}
                >
                  delete
                </button>
              </div>
              <FilterEditor
                instance={i}
                onSave={filter => saveFilterFor(i.id, filter)}
              />
            </div>
          ))}
          {instances && instances.length === 0 && (
            <div className="text-sm text-zinc-500">No instances yet. Add one →</div>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium mb-3">{form.id ? 'Edit instance' : 'Add instance'}</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded p-4 space-y-3 text-sm">
          <Field label="Label" value={form.label} onChange={v => setForm({ ...form, label: v })} />
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Role</label>
            <select
              value={form.role}
              onChange={e => setForm({ ...form, role: e.target.value as InstanceRole })}
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5"
            >
              <option value="source">source</option>
              <option value="destination">destination</option>
            </select>
          </div>
          <Field label="Base URL" value={form.baseUrl} onChange={v => setForm({ ...form, baseUrl: v })} placeholder="https://acme.omniapp.co" />
          <Field
            label={form.id ? 'API Key (leave blank to keep existing; required if you change the Base URL)' : 'API Key'}
            value={form.apiKey}
            onChange={v => setForm({ ...form, apiKey: v })}
            type="password"
          />
          <Field label="User ID" value={form.userId} onChange={v => setForm({ ...form, userId: v })} />
          <Field label="Base Model ID (for import)" value={form.modelId} onChange={v => setForm({ ...form, modelId: v })} />
          <Field label="Folder ID (for list / delete)" value={form.folderId} onChange={v => setForm({ ...form, folderId: v })} />
          <Field label="Folder Path (for import target)" value={form.folderPath} onChange={v => setForm({ ...form, folderPath: v })} placeholder="Marketing/Imported" />
          <Field label="Entity group separator (optional)" value={form.entityGroupSeparator ?? ''} onChange={v => setForm({ ...form, entityGroupSeparator: v })} placeholder="e.g.  | " />
          <div className="flex gap-2 pt-2">
            <button
              className="bg-zinc-100 text-zinc-900 rounded px-4 py-1.5 font-medium disabled:opacity-40"
              disabled={create.isPending || update.isPending || !form.label.trim() || !form.baseUrl.trim() || (!form.id && !form.apiKey.trim())}
              onClick={submit}
            >
              {form.id ? 'Save' : 'Create'}
            </button>
            {form.id && (
              <button className="text-xs text-zinc-400" onClick={cancelEdit}>
                cancel
              </button>
            )}
          </div>
          {formError && (
            <div className="text-xs text-red-400 break-words whitespace-pre-wrap">{formError.message}</div>
          )}
        </div>
      </section>
    </div>
  );
}

type MatchMode = 'contains' | 'exact';
type FilterPattern = { value: string; mode: MatchMode };

function parsePatterns(input: string, mode: MatchMode): FilterPattern[] {
  return input.split(',').map(s => s.trim()).filter(Boolean).map(value => ({ value, mode }));
}

function dedupePatterns(list: FilterPattern[]): FilterPattern[] {
  const seen = new Set<string>();
  return list.filter(p => {
    const k = `${p.mode}:${p.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function initPatterns(contains: string[] = [], exact: string[] = []): FilterPattern[] {
  return dedupePatterns([
    ...contains.map(value => ({ value, mode: 'contains' as MatchMode })),
    ...exact.map(value => ({ value, mode: 'exact' as MatchMode })),
  ]);
}

function toFilter(db: FilterPattern[], ids: FilterPattern[]): DashboardFilter {
  return {
    databaseContains: db.filter(p => p.mode === 'contains').map(p => p.value),
    databaseExact: db.filter(p => p.mode === 'exact').map(p => p.value),
    externalIdContains: ids.filter(p => p.mode === 'contains').map(p => p.value),
    externalIdExact: ids.filter(p => p.mode === 'exact').map(p => p.value),
  };
}

function PatternChips({
  patterns,
  onChange,
}: {
  patterns: FilterPattern[];
  onChange: (p: FilterPattern[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {patterns.map((p, i) => (
        <span key={`${p.mode}:${p.value}`} className="flex items-center gap-1 bg-zinc-800 text-zinc-300 rounded px-1.5 py-0.5">
          <button
            title={p.mode === 'contains' ? 'Switch to exact match' : 'Switch to contains match'}
            onClick={() => onChange(dedupePatterns(patterns.map((x, j) => j === i ? { ...x, mode: x.mode === 'contains' ? 'exact' : 'contains' } : x)))}
            className={`font-mono text-[10px] px-0.5 rounded ${p.mode === 'contains' ? 'text-zinc-500 hover:text-zinc-300' : 'text-blue-400 hover:text-blue-300'}`}
          >
            {p.mode === 'contains' ? '~' : '='}
          </button>
          {p.value}
          <button onClick={() => onChange(patterns.filter((_, j) => j !== i))} className="text-zinc-500 hover:text-zinc-200">×</button>
        </span>
      ))}
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: MatchMode; onChange: (m: MatchMode) => void }) {
  return (
    <button
      type="button"
      aria-pressed={mode === 'exact'}
      title={mode === 'contains' ? 'Contains match — click for exact' : 'Exact match — click for contains'}
      onClick={() => onChange(mode === 'contains' ? 'exact' : 'contains')}
      className={`shrink-0 px-2 py-1 rounded border text-[10px] font-mono transition-colors ${
        mode === 'contains'
          ? 'border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'
          : 'border-blue-700 text-blue-400 hover:border-blue-500'
      }`}
    >
      {mode === 'contains' ? '~contains' : '=exact'}
    </button>
  );
}

function FilterEditor({
  instance,
  onSave,
}: {
  instance: InstancePublic;
  onSave: (filter: DashboardFilter) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [dbPatterns, setDbPatterns] = useState<FilterPattern[]>(() =>
    initPatterns(instance.dashboardFilter?.databaseContains, instance.dashboardFilter?.databaseExact)
  );
  const [idPatterns, setIdPatterns] = useState<FilterPattern[]>(() =>
    initPatterns(instance.dashboardFilter?.externalIdContains, instance.dashboardFilter?.externalIdExact)
  );
  const [dbInput, setDbInput] = useState('');
  const [dbMode, setDbMode] = useState<MatchMode>('contains');
  const [idInput, setIdInput] = useState('');
  const [idMode, setIdMode] = useState<MatchMode>('contains');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  // Re-seed the draft whenever the server value changes (own save, or a stale cache refreshing).
  // Keyed on the serialised filter so unrelated list refetches do not wipe unsaved edits.
  const serverKey = JSON.stringify(instance.dashboardFilter ?? null);
  useEffect(() => {
    setDbPatterns(initPatterns(instance.dashboardFilter?.databaseContains, instance.dashboardFilter?.databaseExact));
    setIdPatterns(initPatterns(instance.dashboardFilter?.externalIdContains, instance.dashboardFilter?.externalIdExact));
  }, [serverKey]);

  // Text typed but not yet added still counts: Update filter saves it too.
  const draftDb = dedupePatterns([...dbPatterns, ...parsePatterns(dbInput, dbMode)]);
  const draftIds = dedupePatterns([...idPatterns, ...parsePatterns(idInput, idMode)]);
  const savedFilter = toFilter(
    initPatterns(instance.dashboardFilter?.databaseContains, instance.dashboardFilter?.databaseExact),
    initPatterns(instance.dashboardFilter?.externalIdContains, instance.dashboardFilter?.externalIdExact)
  );
  const savedCount = Object.values(savedFilter).reduce((n, a) => n + a.length, 0);
  const dirty = JSON.stringify(toFilter(draftDb, draftIds)) !== JSON.stringify(savedFilter);

  const addDb = () => {
    setDbPatterns(p => dedupePatterns([...p, ...parsePatterns(dbInput, dbMode)]));
    setDbInput('');
  };
  const addId = () => {
    setIdPatterns(p => dedupePatterns([...p, ...parsePatterns(idInput, idMode)]));
    setIdInput('');
  };

  const handleSave = async () => {
    setDbPatterns(draftDb);
    setIdPatterns(draftIds);
    setDbInput('');
    setIdInput('');
    setSaving(true);
    setSaved(false);
    setErr(null);
    try {
      await onSave(toFilter(draftDb, draftIds));
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-zinc-800">
      <button
        className="w-full text-left text-xs text-zinc-500 hover:text-zinc-300 px-3 py-1.5 flex items-center gap-1"
        onClick={() => setOpen(o => !o)}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>skip filters</span>
        {savedCount > 0 && <span className="text-zinc-600">({savedCount} active)</span>}
        {dirty && <span className="text-amber-400">unsaved changes</span>}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3 text-xs">
          <div>
            <div className="flex items-center justify-between text-zinc-500 mb-1">
              <span>Connections — skip if database matches</span>
              {dbPatterns.length > 0 && (
                <button onClick={() => setDbPatterns([])} className="text-zinc-500 hover:text-zinc-200">clear all</button>
              )}
            </div>
            <div className="flex gap-1 mb-1">
              <ModeToggle mode={dbMode} onChange={setDbMode} />
              <input
                value={dbInput}
                onChange={e => setDbInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addDb()}
                placeholder="e.g. internal_, test_ (comma-separated)"
                className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              <button onClick={addDb} className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-300">add</button>
            </div>
            <PatternChips patterns={dbPatterns} onChange={setDbPatterns} />
          </div>
          <div>
            <div className="flex items-center justify-between text-zinc-500 mb-1">
              <span>Users — skip if external ID matches</span>
              {idPatterns.length > 0 && (
                <button onClick={() => setIdPatterns([])} className="text-zinc-500 hover:text-zinc-200">clear all</button>
              )}
            </div>
            <div className="flex gap-1 mb-1">
              <ModeToggle mode={idMode} onChange={setIdMode} />
              <input
                value={idInput}
                onChange={e => setIdInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addId()}
                placeholder="e.g. test-, embed_ (comma-separated)"
                className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              <button onClick={addId} className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-300">add</button>
            </div>
            <PatternChips patterns={idPatterns} onChange={setIdPatterns} />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1 bg-zinc-100 text-zinc-900 rounded font-medium disabled:opacity-40"
            >
              {saving ? 'saving…' : 'Update filter'}
            </button>
            <button
              onClick={() => { setDbPatterns([]); setIdPatterns([]); setDbInput(''); setIdInput(''); }}
              disabled={saving || draftDb.length + draftIds.length === 0}
              className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded disabled:opacity-40"
            >
              Clear all filters
            </button>
            {saved && <span className="text-emerald-400">Saved</span>}
            {err && <span className="text-red-400 break-words min-w-0">{err}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-zinc-400 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5"
      />
    </div>
  );
}
