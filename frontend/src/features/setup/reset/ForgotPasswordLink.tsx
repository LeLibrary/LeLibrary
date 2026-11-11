import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchResetConfig } from '@/api/reset';
import { queryKeys } from '@/api/query-keys';

// Whether this server offers password reset and setup deletion. Shared by the
// unlock modal (link) and the /reset page.
export function useResetConfig() {
  return useQuery({
    queryKey: queryKeys.resetConfig,
    queryFn: ({ signal }) => fetchResetConfig(signal),
    staleTime: 5 * 60_000,
  });
}

// The note at the bottom of the unlock modal. Off (or an older server): the
// old "no recovery" line. On: a link into the reset flow. Nothing while the
// answer is loading, so the note never flashes before the link.
export function UnlockRecovery({ uuid }: { uuid: string }) {
  const { data } = useResetConfig();
  if (!data) return null;
  if (!data.enabled) {
    return <small className="edit-unlock-note">No email, no recovery. Forgotten passwords cannot be reset.</small>;
  }
  return (
    <small className="edit-unlock-note">
      <Link className="pw-reset-link" to={`/reset?setup=${encodeURIComponent(uuid)}`}>Forgot your password?</Link>
    </small>
  );
}
