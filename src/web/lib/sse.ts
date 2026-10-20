import type { JobEvent } from '../../shared/types';

// onSync runs on every (re)connect: events published while disconnected are lost, so refetch the job.
export function streamJob(
  jobId: string,
  onEvent: (e: JobEvent) => void,
  onError?: (e: Event) => void,
  onSync?: () => void,
): () => void {
  const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  const handler = (ev: MessageEvent): void => {
    try { onEvent(JSON.parse(ev.data) as JobEvent); } catch { /* ignore */ }
  };
  for (const name of ['item', 'job', 'post-migration']) es.addEventListener(name, handler as EventListener);
  es.addEventListener('done', ev => {
    handler(ev as MessageEvent);
    es.close(); // the server ended the stream on purpose: do not let EventSource reconnect
  });
  if (onSync) es.addEventListener('hello', () => onSync());
  if (onError) es.addEventListener('error', onError);
  return () => es.close();
}
