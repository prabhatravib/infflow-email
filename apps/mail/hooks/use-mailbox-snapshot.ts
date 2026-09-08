import {
  resolveEmailGroupId,
  type MailboxSnapshot,
  type MailboxThread,
} from '@/lib/hexa-mailbox-context';
import { categorizationResultsAtom } from '@/store/categorization';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/providers/query-provider';
import { useStats } from '@/hooks/use-stats';
import { useLocation } from 'react-router';
import { useAtomValue } from 'jotai';

/**
 * The mail list fills the `mail.get` cache one row at a time as threads mount,
 * so the cache settles in bursts. Re-read on the trailing edge instead of on
 * every individual write.
 */
const CACHE_SETTLE_MS = 1500;

/** The shape this hook needs out of a cached `mail.listThreads` infinite query. */
interface CachedThreadListing {
  pages?: { threads?: { id: string }[] }[];
}

/**
 * Reads the mailbox the user is already looking at, without issuing a single
 * request of its own: thread ids come from the folder's cached `listThreads`
 * pages and headers from the `mail.get` entries the list rows populated. A
 * thread the list has not rendered yet simply does not appear.
 */
export const useMailboxSnapshot = (): MailboxSnapshot => {
  const categorizationResults = useAtomValue(categorizationResultsAtom);
  const queryClient = useQueryClient();
  const { data: stats } = useStats();
  const location = useLocation();
  const trpc = useTRPC();
  const [cacheVersion, setCacheVersion] = useState(0);

  const folder = useMemo(
    () => /^\/mail\/([^/]+)/.exec(location.pathname)?.[1] ?? '',
    [location.pathname],
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      // Only resolved data can change the snapshot. Reacting to observer churn
      // too would let this hook's own re-render feed itself.
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      clearTimeout(timer);
      timer = setTimeout(() => setCacheVersion((version) => version + 1), CACHE_SETTLE_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [queryClient]);

  return useMemo(() => {
    const folderCounts = (stats ?? [])
      .filter((stat): stat is { label: string; count: number } => !!stat?.label)
      .map((stat) => ({ label: stat.label, count: stat.count ?? 0 }));

    // A folder can have more than one cached listing (different search terms or
    // connections). The most recently updated one is what the list is showing.
    const listing = queryClient
      .getQueryCache()
      .findAll(trpc.mail.listThreads.pathFilter())
      .filter((query) => {
        const input = (query.queryKey[1] as { input?: { folder?: string } } | undefined)?.input;
        const data = query.state.data as CachedThreadListing | undefined;
        return !!folder && input?.folder === folder && !!data?.pages;
      })
      .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0];

    const threadIds: string[] = ((listing?.state.data as CachedThreadListing | undefined)?.pages ?? [])
      .flatMap((page) => page?.threads ?? [])
      .map((thread) => thread?.id)
      .filter(Boolean);

    const threads: MailboxThread[] = [];
    for (const id of threadIds) {
      const cached = queryClient.getQueryData(trpc.mail.get.queryKey({ id }));
      const latest = cached?.latest;
      if (!latest) continue;
      threads.push({
        id,
        sender: latest.sender?.name?.trim().replace(/^['"]|['"]$/g, '') || latest.sender?.email || 'Unknown sender',
        subject: latest.subject || '(no subject)',
        receivedOn: latest.receivedOn ?? '',
        unread: cached.hasUnread ?? latest.unread ?? false,
        categories: categorizationResults.get(id) ?? [],
      });
    }

    // Undated threads sort last rather than poisoning the comparator with NaN.
    const receivedAt = (thread: MailboxThread) => Date.parse(thread.receivedOn) || 0;
    threads.sort((a, b) => receivedAt(b) - receivedAt(a));

    const groupTallies = { fubo: 0, jobs: 0, others: 0 };
    for (const id of threadIds) {
      groupTallies[resolveEmailGroupId(categorizationResults.get(id))] += 1;
    }

    return {
      folder,
      folderCounts,
      groupCounts: [
        { id: 'fubo', name: 'FUBO Related', count: groupTallies.fubo },
        { id: 'jobs', name: 'Jobs and Employment', count: groupTallies.jobs },
        { id: 'others', name: 'Others', count: groupTallies.others },
      ],
      threads,
      listedThreadCount: threadIds.length,
    };
    // `cacheVersion` is the read trigger: the cache mutates in place, so nothing
    // else in this list changes when new thread headers land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, stats, categorizationResults, cacheVersion, queryClient, trpc]);
};
