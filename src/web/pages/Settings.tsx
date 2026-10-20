import { useState } from 'react';
import { api } from '../lib/api';

export default function Settings() {
  return (
    <div className="max-w-lg flex flex-col gap-8">
      <h2 className="text-lg font-medium">Settings</h2>
      <ChangePassphrase />
    </div>
  );
}

function ChangePassphrase() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [error, setError] = useState('');

  // Editing any field clears a previous 'updated' or error message.
  const touch = (set: (v: string) => void) => (v: string): void => {
    set(v);
    setStatus(s => (s === 'loading' ? s : 'idle'));
  };

  const mismatch = next && confirm && next !== confirm;
  const canSubmit = current && next && confirm && !mismatch && status !== 'loading';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setStatus('loading');
    setError('');
    try {
      await api.changePassphrase(current, next);
      setStatus('ok');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
      setStatus('error');
    }
  };

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded p-5 flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium text-zinc-200">Change passphrase</h3>
        <p className="text-xs text-zinc-500 mt-0.5">Re-encrypts the vault with a new passphrase. The current session stays active.</p>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <PassField label="Current passphrase" value={current} onChange={touch(setCurrent)} />
        <PassField label="New passphrase" value={next} onChange={touch(setNext)} />
        <PassField
          label="Confirm new passphrase"
          value={confirm}
          onChange={touch(setConfirm)}
          error={mismatch ? 'Passphrases do not match' : undefined}
        />
        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-1.5 bg-zinc-100 text-zinc-900 rounded text-sm font-medium disabled:opacity-40"
          >
            {status === 'loading' ? 'Saving…' : 'Update passphrase'}
          </button>
          {status === 'ok' && <span className="text-sm text-emerald-400">Passphrase updated</span>}
          {status === 'error' && <span className="text-sm text-red-400">{error}</span>}
        </div>
      </form>
    </section>
  );
}

function PassField({ label, value, onChange, error }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-zinc-400 mb-1">{label}</label>
      <input
        type="password"
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`w-full bg-zinc-950 border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-500 ${
          error ? 'border-red-700' : 'border-zinc-700'
        }`}
      />
      {error && <p className="text-xs text-red-400 mt-0.5">{error}</p>}
    </div>
  );
}
