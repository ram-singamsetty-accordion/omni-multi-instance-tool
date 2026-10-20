const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// Throws a plain Error with a user-facing message. Returns the bare origin: path, query, fragment
// and trailing slash are dropped, so OmniClient can append '/api/v1/...' to it.
export function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('Base URL is not a valid URL');
  }
  if (u.username || u.password) throw new Error('Base URL must not contain credentials');
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.includes(u.hostname));
  if (!ok) throw new Error('Base URL must be an https:// URL (http:// only for localhost)');
  return u.origin;
}

// Origin for comparing a stored base URL with a submitted one; values without a usable origin compare as-is.
export function baseUrlOrigin(url: string): string {
  try {
    const o = new URL(url.trim()).origin;
    return o === 'null' ? url : o;
  } catch {
    return url;
  }
}
