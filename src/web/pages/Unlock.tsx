import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';

export default function Unlock({ vaultExists }: { vaultExists: boolean }) {
  const qc = useQueryClient();
  const [p, setP] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const mismatch = !vaultExists && confirm !== '' && confirm !== p;
  const m = useMutation({
    // Only the explicit "Create vault" form may create one; a missing file on Unlock is an error.
    mutationFn: (passphrase: string) => api.unlock(passphrase, !vaultExists),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['unlock-status'] }),
    onError: (e: Error) => {
      setErr(e.message);
      // 409: the vault was created or removed since this form loaded, so refresh which form to show.
      if (e instanceof ApiError && e.status === 409) {
        setConfirm('');
        qc.invalidateQueries({ queryKey: ['unlock-status'] });
      }
    },
  });

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form
        className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 w-96 space-y-4"
        onSubmit={e => {
          e.preventDefault();
          if (!vaultExists && p !== confirm) return;
          setErr(null);
          m.mutate(p);
        }}
      >
        <h1 className="text-lg font-semibold">
          {vaultExists ? 'Unlock vault' : 'Create vault'}
        </h1>
        <p className="text-sm text-zinc-400">
          {vaultExists
            ? 'Enter the passphrase to decrypt your saved instances.'
            : 'Pick a strong passphrase. It encrypts your Omni API keys on disk. Losing it means re-entering everything.'}
        </p>
        <input
          type="password"
          value={p}
          onChange={e => setP(e.target.value)}
          autoFocus
          className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-zinc-100"
          placeholder="passphrase"
        />
        {!vaultExists && (
          <input
            type="password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-zinc-100"
            placeholder="confirm passphrase"
          />
        )}
        {mismatch && <div className="text-sm text-red-400">Passphrases do not match</div>}
        {err && <div className="text-sm text-red-400">{err}</div>}
        <button
          disabled={m.isPending || !p || (!vaultExists && p !== confirm)}
          className="w-full bg-zinc-100 text-zinc-900 rounded py-2 font-medium disabled:opacity-40"
        >
          {m.isPending ? 'unlocking…' : vaultExists ? 'Unlock' : 'Create'}
        </button>
      </form>
    </div>
  );
}
