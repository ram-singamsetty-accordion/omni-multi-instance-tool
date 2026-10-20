import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { streamJob } from '../lib/sse';
import type { JobItem, JobItemStatus, PostMigrationActionResult } from '../../shared/types';

export default function JobDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data } = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.getJob(id),
  });
  const [liveItems, setLiveItems] = useState<Record<string, Partial<JobItem>>>({});
  const [postMigrationRunning, setPostMigrationRunning] = useState(false);

  useEffect(() => {
    if (!id) return;
    const stop = streamJob(id, evt => {
      if (evt.type === 'item' && evt.itemId) {
        setLiveItems(prev => ({
          ...prev,
          [evt.itemId!]: { status: evt.status as JobItemStatus, error: evt.error ?? null },
        }));
      } else if (evt.type === 'job') {
        qc.invalidateQueries({ queryKey: ['job', id] });
      } else if (evt.type === 'post-migration') {
        if (evt.status === 'running') {
          setPostMigrationRunning(true);
        } else {
          setPostMigrationRunning(false);
          qc.invalidateQueries({ queryKey: ['job', id] });
        }
      }
    });
    return stop;
  }, [id, qc]);

  const items = useMemo<JobItem[]>(() => {
    if (!data) return [];
    return data.items.map(i => ({ ...i, ...(liveItems[i.id] ?? {}) }));
  }, [data, liveItems]);

  const retry = useMutation({
    mutationFn: () => api.retryJob(id),
    onSuccess: ({ job }) => nav(`/jobs/${job.id}`),
  });

  if (!data) return <div className="text-sm text-zinc-500">loading…</div>;

  const failedCount = items.filter(i => i.status === 'failed').length;
  const succeededCount = items.filter(i => i.status === 'succeeded').length;
  const skippedCount = items.filter(i => i.status === 'skipped').length;

  const byDest = items.reduce<Record<string, JobItem[]>>((acc, it) => {
    (acc[it.destId] ??= []).push(it);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-4">
        <div>
          <h2 className="text-lg font-semibold">Job {id.slice(0, 8)}</h2>
          <div className="text-xs text-zinc-500">
            status <span className={`font-medium ${jobStatusColor(data.status)}`}>{data.status}</span>
            {' · '}{succeededCount}/{items.length} ok{skippedCount ? ` · ${skippedCount} skipped` : ''}{failedCount ? ` · ${failedCount} failed` : ''}
            {data.parentJobId && ' · retry'}
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          {failedCount > 0 && !data.running && (
            <button
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
              className="bg-amber-500 text-amber-950 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-40"
            >
              {retry.isPending ? 'starting…' : `Retry ${failedCount} failed`}
            </button>
          )}
        </div>
      </header>

      {(postMigrationRunning || (data.postMigrationActions?.length > 0 && data.postMigrationResults)) && (
        <div className="bg-zinc-900 border border-zinc-800 rounded p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="font-medium text-zinc-300">Post-migration actions</span>
            {postMigrationRunning && <span className="text-amber-400 animate-pulse">running…</span>}
          </div>
          {data.postMigrationResults && (
            <ul className="space-y-1">
              {data.postMigrationResults.map((r, i) => (
                <PostMigrationResultRow key={i} result={r} />
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {Object.entries(byDest).map(([destId, list]) => (
          <div key={destId} className="bg-zinc-900 border border-zinc-800 rounded p-3">
            <div className="flex items-center text-xs text-zinc-400 mb-2">
              <span>dest {destId.slice(0, 8)}</span>
              <span className="ml-auto">
                {list.filter(i => i.status === 'succeeded' || i.status === 'skipped').length}/{list.length}
              </span>
            </div>
            <ul className="space-y-1 text-sm max-h-96 overflow-auto">
              {list.map(it => (
                <li key={it.id} className="flex items-center gap-2">
                  <StatusDot status={it.status} />
                  <span className={`text-xs uppercase w-14 ${kindColor(it.kind)}`}>{it.kind}</span>
                  <span className="truncate text-zinc-300 flex-1">{it.docName ?? it.docId ?? '—'}</span>
                  {it.error && (
                    <span
                      className={`text-xs truncate max-w-[180px] ${it.status === 'failed' ? 'text-red-400' : 'text-zinc-500'}`}
                      title={it.error}
                    >
                      {it.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: JobItemStatus }) {
  const m: Record<JobItemStatus, string> = {
    pending: 'bg-zinc-600',
    running: 'bg-amber-400 animate-pulse',
    succeeded: 'bg-emerald-400',
    failed: 'bg-red-500',
    skipped: 'bg-zinc-500',
  };
  return <span className={`inline-block w-2 h-2 rounded-full ${m[status]}`} />;
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

function jobStatusColor(s: string): string {
  if (s === 'succeeded') return 'text-emerald-400';
  if (s === 'failed') return 'text-red-400';
  if (s === 'partial') return 'text-amber-400';
  if (s === 'running') return 'text-blue-400';
  return 'text-zinc-400';
}

function PostMigrationResultRow({ result: r }: { result: PostMigrationActionResult }) {
  const [open, setOpen] = useState(false);
  const hasBody = !!(r.responseBody || r.error);
  return (
    <li className={`text-xs rounded ${r.ok ? 'bg-emerald-950' : 'bg-red-950'}`}>
      <button
        className={`w-full flex items-center gap-2 px-2 py-1 text-left ${r.ok ? 'text-emerald-300' : 'text-red-300'}`}
        onClick={() => hasBody && setOpen(v => !v)}
      >
        <span className="font-mono">{r.method}</span>
        <span className="font-mono flex-1 truncate">{r.url}</span>
        <span>{r.status ?? 'network error'}</span>
        {hasBody && <span className="opacity-50">{open ? '▾' : '▸'}</span>}
      </button>
      {open && (
        <pre className={`px-2 pb-2 text-xs overflow-x-auto whitespace-pre-wrap break-all ${r.ok ? 'text-emerald-400/80' : 'text-red-400/80'}`}>
          {r.error ?? r.responseBody}
        </pre>
      )}
    </li>
  );
}
