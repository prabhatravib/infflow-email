import { MAX_THREAD_HEADER_IDS, type IThreadHeader } from '../../server/src/lib/driver/types';
import { threadHeadersAtom } from '@/store/thread-headers';
import { useTRPC } from '@/providers/query-provider';
import { useQueries } from '@tanstack/react-query';
import { useAtomValue, useSetAtom } from 'jotai';
import { useSession } from '@/lib/auth-client';
import { useEffect, useMemo } from 'react';

/**
 * A thread whose headers were requested but not returned -- the driver drops a
 * thread it could not load rather than failing the page. Recording the miss is
 * what lets a row tell "still loading" from "will never arrive": without it an
 * unloadable thread would hold a placeholder in the list forever.
 */
const missingHeader = (id: string): IThreadHeader => ({
  id,
  latest: undefined,
  hasUnread: false,
  hasDraft: false,
  isGroupThread: false,
  labels: [],
  totalReplies: 0,
});

/**
 * Fetches headers for the threads the list knows about, in batches, and puts
 * them where the rows and the Hexa mailbox overview can read them.
 *
 * Chunks are cut by position in the id list, so a chunk's key does not change
 * when the next page is appended and already-fetched batches are never refetched.
 *
 * Call this once, from the list. Rows read with `useThreadHeader`.
 */
export const useHydrateThreadHeaders = (threadIds: string[]) => {
  const { data: session } = useSession();
  // Set-only: the list itself must not re-render every time a batch lands. Rows
  // subscribe individually through `useThreadHeader`.
  const setHeaders = useSetAtom(threadHeadersAtom);
  const trpc = useTRPC();

  const chunks = useMemo(() => {
    const result: string[][] = [];
    for (let i = 0; i < threadIds.length; i += MAX_THREAD_HEADER_IDS) {
      result.push(threadIds.slice(i, i + MAX_THREAD_HEADER_IDS));
    }
    return result;
  }, [threadIds]);

  const results = useQueries({
    queries: chunks.map((ids) =>
      trpc.mail.listThreadHeaders.queryOptions(
        { ids },
        {
          enabled: !!session?.user.id && ids.length > 0,
          // Headers change when a thread is read, starred or labelled. The
          // mutations that do those things drive the row through the optimistic
          // atoms, so this only has to be fresh enough to survive a reload.
          staleTime: 1000 * 60 * 5,
        },
      ),
    ),
  });

  // One effect over all batches rather than one per batch: several can resolve in
  // the same tick, and a per-batch write would make each overwrite the others'.
  // The dependency is the batches' update stamps, not the result array, which is
  // a fresh array on every render and would re-run this continuously.
  const resolvedAt = results.map((result) => result.dataUpdatedAt).join(',');
  useEffect(() => {
    const arrived: IThreadHeader[] = [];
    const missed: string[] = [];

    results.forEach((result, index) => {
      if (!result.data) return;
      const returned = new Set(result.data.map((header) => header.id));
      arrived.push(...result.data);
      for (const id of chunks[index] ?? []) {
        if (!returned.has(id)) missed.push(id);
      }
    });

    if (!arrived.length && !missed.length) return;

    setHeaders((previous) => {
      const changed =
        arrived.some((header) => previous.get(header.id) !== header) ||
        missed.some((id) => !previous.has(id));
      if (!changed) return previous;

      const next = new Map(previous);
      for (const header of arrived) next.set(header.id, header);
      // A miss must not overwrite a header already known, only fill a gap.
      for (const id of missed) if (!next.has(id)) next.set(id, missingHeader(id));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedAt, chunks, setHeaders]);

  return { isLoading: results.some((result) => result.isLoading) };
};

/**
 * One thread's headers. `isPending` stays true only while the batch carrying this
 * thread is in flight; a thread the server could not load resolves to a header
 * with no `latest`, which the row renders as nothing rather than as a placeholder.
 */
export const useThreadHeader = (threadId: string) => {
  const headers = useAtomValue(threadHeadersAtom);
  const header = headers.get(threadId);
  return {
    header,
    latest: header?.latest,
    isPending: !header,
  };
};
