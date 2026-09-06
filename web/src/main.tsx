import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { onUnauthorized } from './api/client';
import { ME_KEY } from './api/hooks';
import { registerServiceWorker } from './pwa';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

// Any 401 from a data call means the session is gone: drop the user so the guard redirects to /login.
onUnauthorized(() => {
  queryClient.setQueryData(ME_KEY, null);
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);

registerServiceWorker();
