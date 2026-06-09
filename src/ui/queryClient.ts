import { QueryClient } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';

// Single shared QueryClient for the app. Defaults tuned for our use:
// metadata lookups change rarely, so cache aggressively and refetch
// only on mount when the data is missing.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 24 * 60 * 60 * 1000,  // 24 h
      gcTime:    7  * 24 * 60 * 60 * 1000, // 7 days in memory
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

// Persist the cache to localStorage so reloads don't re-fetch
// already-known metadata. The persister uses a single key so we can
// invalidate the whole thing by bumping `buster`.
export const persister = createSyncStoragePersister({
  storage: typeof localStorage === 'undefined' ? undefined : localStorage,
  key: 'gba-recomp:rq:v1',
  throttleTime: 1000,
});
