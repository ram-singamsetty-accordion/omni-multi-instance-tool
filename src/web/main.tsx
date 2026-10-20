import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ApiError } from './lib/api';
import './styles.css';

// A 423 means the server restarted or locked; re-check unlock-status so App routes back to Unlock.
const onApiError = (err: unknown): void => {
  if (err instanceof ApiError && err.status === 423) void client.invalidateQueries({ queryKey: ['unlock-status'] });
};

const client: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
