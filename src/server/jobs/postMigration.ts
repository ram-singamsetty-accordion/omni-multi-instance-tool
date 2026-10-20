import type { PostMigrationAction, PostMigrationActionResult } from '../../shared/types.js';

const ACTION_TIMEOUT_MS = 60_000; // matches TIMEOUT_MS in omni/client.ts
const MAX_BODY_CHARS = 20_000;

export async function runPostMigrationActions(
  actions: PostMigrationAction[],
): Promise<PostMigrationActionResult[]> {
  const results: PostMigrationActionResult[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    try {
      // Blank header names (the editor's "+ header" row) make fetch throw, so drop them.
      const headers: Record<string, string> = Object.fromEntries(
        Object.entries(a.headers ?? {})
          .map(([k, v]) => [k.trim(), v] as const)
          .filter(([k]) => k !== ''),
      );
      // fetch rejects a body on GET/HEAD.
      const bodyless = /^(GET|HEAD)$/i.test(a.method);
      const body = !bodyless && a.body ? a.body : undefined;
      const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
      if (body && !hasContentType) {
        // A string body defaults to text/plain, which JSON-only receivers ignore.
        try {
          const parsed: unknown = JSON.parse(body);
          if (parsed !== null && typeof parsed === 'object') headers['Content-Type'] = 'application/json';
        } catch {
          // not JSON: keep fetch's text/plain default
        }
      }
      const res = await fetch(a.url, { method: a.method, headers, body, signal: AbortSignal.timeout(ACTION_TIMEOUT_MS) });
      const raw = await res.text();
      let responseBody: string;
      try {
        responseBody = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        responseBody = raw;
      }
      if (responseBody.length > MAX_BODY_CHARS) {
        responseBody = `${responseBody.slice(0, MAX_BODY_CHARS)}\n... truncated (${responseBody.length} chars total)`;
      }
      results.push({ index: i, method: a.method, url: a.url, status: res.status, ok: res.ok, responseBody });
    } catch (err) {
      const error =
        err instanceof Error && err.name === 'TimeoutError'
          ? `no response within ${ACTION_TIMEOUT_MS / 1000}s`
          : err instanceof Error
            ? err.message
            : String(err);
      results.push({ index: i, method: a.method, url: a.url, status: null, ok: false, error });
    }
  }
  return results;
}
