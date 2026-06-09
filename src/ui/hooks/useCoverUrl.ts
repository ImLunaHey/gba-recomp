import { useQuery } from '@tanstack/react-query';

// useCoverUrl — given a candidate list of thumbnail URLs (typically
// from buildThumbnailUrls in hasheous.ts), probe each in order via
// Image() and resolve to the first one that loads. Returns null if
// every candidate 404s or the candidate list is empty. Cached by
// the canonical title string so the same probe doesn't re-run on
// every render across the app.
export function useCoverUrl(title: string, candidates: string[]) {
  return useQuery<string | null>({
    queryKey: ['cover-url', title],
    enabled: candidates.length > 0,
    staleTime: Infinity,
    queryFn: async () => {
      for (const url of candidates) {
        const ok = await new Promise<boolean>((res) => {
          const img = new Image();
          img.onload = () => res(true);
          img.onerror = () => res(false);
          img.src = url;
        });
        if (ok) return url;
      }
      return null;
    },
  });
}
