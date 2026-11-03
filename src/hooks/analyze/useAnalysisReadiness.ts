import { useEffect, useState } from 'react';

/**
 * Analysis pipeline readiness (local replacement for `useFirebaseReadiness`).
 *
 * Upstream waited for Firestore before allowing "read cache / restore last
 * analysis", so this hook used to poll `ensureFirebaseInitialized()`. The local
 * build has no remote to reach: the backend is Flask + SQLite and a failed cache
 * read simply degrades to a cache miss, so readiness is set immediately with no
 * network probe or retry timer.
 *
 * The async `useEffect` shape is kept (false on the first frame, true on the
 * next) so the timing of downstream effects watching that flag does not become
 * synchronous.
 */
export const useAnalysisReadiness = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  return { ready };
};