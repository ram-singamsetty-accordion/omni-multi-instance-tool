import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { FolderRef } from '../../shared/types';

// Search an instance's folders by name or path and pick one. `value` null means "use the instance default".
export function FolderPicker({
  instanceId,
  value,
  defaultFolder,
  onChange,
}: {
  instanceId: string;
  value: FolderRef | null;
  defaultFolder: { id: string; path: string };
  onChange: (folder: FolderRef | null) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const results = useQuery({
    queryKey: ['folders', instanceId, debounced],
    queryFn: () => api.searchFolders(instanceId, debounced),
    enabled: open,
    staleTime: 60_000,
  });

  // A forced reload never joins an in-flight listing, so it is blocked while the list is already loading.
  const reload = async (): Promise<void> => {
    if (refreshing || results.isFetching) return;
    setRefreshing(true);
    setReloadError(null);
    try {
      await api.searchFolders(instanceId, '', true);
      await qc.invalidateQueries({ queryKey: ['folders', instanceId] });
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : 'reload failed');
    } finally {
      setRefreshing(false);
    }
  };

  const hasDefault = !!defaultFolder.id;
  const current = value ?? (hasDefault ? defaultFolder : null);

  return (
    <div ref={boxRef} className="relative">
      <div className="flex items-center gap-2 text-sm">
        <button
          type="button"
          onClick={() => { setReloadError(null); setOpen(v => !v); }}
          className={`flex-1 text-left bg-zinc-950 border rounded px-2 py-1.5 truncate ${current ? 'border-zinc-700' : 'border-amber-700'}`}
        >
          {current ? (
            <>
              {value?.name && <span className="text-zinc-200">{value.name}</span>}
              <span className={`font-mono text-xs ${value?.name ? 'ml-2 text-zinc-500' : 'text-zinc-300'}`}>
                {current.path || current.id}
              </span>
              {!value && <span className="ml-2 text-xs text-zinc-500">(instance default)</span>}
            </>
          ) : (
            <span className="text-amber-300">No default folder — search for one</span>
          )}
        </button>
        {value && hasDefault && (
          <button type="button" onClick={() => onChange(null)} className="text-xs text-zinc-500 hover:text-zinc-300">
            use default
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-20 mt-1 w-full bg-zinc-900 border border-zinc-700 rounded shadow-lg">
          <div className="flex items-center gap-2 p-2 border-b border-zinc-800">
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
              maxLength={200}
              placeholder="Search folders by name or path"
              className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm"
            />
            <button
              type="button"
              disabled={refreshing || results.isFetching}
              onClick={() => void reload()}
              title="Fetch the folder list again from Omni"
              className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
            >
              {refreshing ? 'reloading…' : 'reload'}
            </button>
          </div>
          {reloadError && <div className="p-2 text-xs text-red-400 border-b border-zinc-800">Reload failed: {reloadError}</div>}
          <div className="max-h-72 overflow-auto">
            {results.isLoading && <div className="p-2 text-xs text-zinc-500">loading folders… (first load lists every folder)</div>}
            {results.error && <div className="p-2 text-xs text-red-400">{(results.error as Error).message}</div>}
            {results.data && results.data.folders.length === 0 && (
              <div className="p-2 text-xs text-zinc-500">No folders match.</div>
            )}
            {results.data?.folders.map(f => (
              <button
                type="button"
                key={f.id}
                onClick={() => { onChange({ id: f.id, path: f.path, name: f.name }); setOpen(false); setQ(''); }}
                className={`w-full text-left px-2 py-1.5 text-sm hover:bg-zinc-800 ${current?.id === f.id ? 'bg-blue-900/30' : ''}`}
              >
                <div className="text-zinc-200 truncate">{f.name}</div>
                <div className="text-xs text-zinc-500 font-mono truncate">{f.path}</div>
              </button>
            ))}
            {results.data && results.data.total > results.data.folders.length && (
              <div className="p-2 text-xs text-zinc-500">
                Showing {results.data.folders.length} of {results.data.total}. Type more to narrow.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
