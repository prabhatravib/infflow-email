import type { SelectedEmailContext, SelectedEmailMessage } from '@/lib/hexa-email-context';
import { MAX_PRECEDING_MESSAGES } from '@/lib/hexa-email-context';
import { useActiveConnection } from '@/hooks/use-connections';
import { useTRPC } from '@/providers/query-provider';
import { useEffect, useMemo, useState } from 'react';
import { useSettings } from '@/hooks/use-settings';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { useQueryState } from 'nuqs';

/**
 * The conversation the user actually has open, in the shape the Hexa reference
 * pack needs.
 *
 * `threadId` is the URL query state the mail list, the keyboard navigation and a
 * pasted deep link all write to, so all three ways of opening an email land here.
 * The thread itself comes from the same `mail.get` cache entry the reading pane
 * uses - this hook adds an observer, never a second request.
 */
export interface SelectedEmailContextResult {
  selected: SelectedEmailContext | null;
  /** Account scope. Changing accounts must invalidate the open conversation. */
  scopeId: string;
}

interface ProviderPerson {
  name?: string;
  email: string;
}

interface ProviderMessage {
  id: string;
  subject?: string;
  sender?: ProviderPerson;
  to?: ProviderPerson[];
  cc?: ProviderPerson[] | null;
  receivedOn?: string;
  decodedBody?: string;
  unread?: boolean;
  isDraft?: boolean;
  attachments?: {
    attachmentId: string;
    filename: string;
    mimeType: string;
    size: number;
    headers: { name?: string | null; value?: string | null }[];
  }[];
}

const toSelectedMessage = (message: ProviderMessage): SelectedEmailMessage => ({
  id: message.id,
  subject: message.subject,
  sender: message.sender,
  to: message.to ?? [],
  cc: message.cc ?? [],
  receivedOn: message.receivedOn,
  decodedBody: message.decodedBody,
  attachments: message.attachments ?? [],
  unread: message.unread,
  isDraft: message.isDraft,
});

export const useSelectedEmailContext = (): SelectedEmailContextResult => {
  const [threadId] = useQueryState('threadId');
  const { data: session } = useSession();
  const { data: settings } = useSettings();
  const { data: activeConnection } = useActiveConnection();
  const trpc = useTRPC();

  const threadQuery = useQuery(
    trpc.mail.get.queryOptions(
      { id: threadId! },
      {
        enabled: !!threadId && !!session?.user.id,
        staleTime: 1000 * 60 * 60,
      },
    ),
  );

  const scopeId = activeConnection?.id ?? '';

  // `mail.get` is cached by thread id alone, so a thread fetched before an
  // account switch would still be readable after it. Nothing proves that body
  // belongs to the account now signed in, so until the query has resolved again
  // the conversation counts as not loaded rather than as the other account's.
  const [accountGuard, setAccountGuard] = useState({ scopeId: '', since: 0 });
  useEffect(() => {
    setAccountGuard((previous) =>
      previous.scopeId === scopeId
        ? previous
        : { scopeId, since: previous.scopeId ? Date.now() : 0 },
    );
  }, [scopeId]);

  const { data: fetched, isPending, isError, error, dataUpdatedAt } = threadQuery;
  const predatesAccountSwitch = accountGuard.since > 0 && dataUpdatedAt < accountGuard.since;
  const data = predatesAccountSwitch ? undefined : fetched;

  return useMemo(() => {
    if (!threadId) return { selected: null, scopeId };

    const base = {
      threadId,
      connectionId: scopeId || null,
      availableMessageCount: 0,
      totalReplies: 0,
      hasUnread: false,
      labels: [] as string[],
      draftCount: 0,
      preceding: [] as SelectedEmailMessage[],
      remoteImagesBlocked: false,
    };

    if (isError) {
      return {
        selected: {
          ...base,
          status: 'error' as const,
          error: error instanceof Error ? error.message : 'unknown error',
        },
        scopeId,
      };
    }
    if (!data) {
      // Data that predates an account switch counts as not yet arrived, not as an
      // empty conversation: the assistant must not imply it looked and found nothing.
      const stillArriving = isPending || predatesAccountSwitch;
      return {
        selected: { ...base, status: stillArriving ? ('loading' as const) : ('empty' as const) },
        scopeId,
      };
    }

    const allMessages = (data.messages ?? []) as ProviderMessage[];
    // Drafts are the user's unsent text. They are counted but never quoted.
    const sent = allMessages.filter((message) => !message.isDraft);
    const newest = sent[sent.length - 1];
    const preceding = sent
      .slice(Math.max(0, sent.length - 1 - MAX_PRECEDING_MESSAGES), sent.length - 1)
      .reverse()
      .map(toSelectedMessage);

    const senderEmail = newest?.sender?.email ?? '';
    const remoteImagesBlocked = !(
      settings?.settings?.externalImages ||
      (senderEmail ? settings?.settings?.trustedSenders?.includes(senderEmail) : false)
    );

    return {
      selected: {
        ...base,
        status: newest ? ('ready' as const) : ('empty' as const),
        subject: newest?.subject ?? data.latest?.subject,
        availableMessageCount: sent.length,
        totalReplies: data.totalReplies ?? sent.length,
        hasUnread: data.hasUnread ?? false,
        labels: (data.labels ?? []).map((label) => label.name).filter(Boolean),
        draftCount: allMessages.length - sent.length,
        newest: newest ? toSelectedMessage(newest) : undefined,
        preceding,
        remoteImagesBlocked,
      },
      scopeId,
    };
  }, [
    threadId,
    scopeId,
    data,
    isPending,
    predatesAccountSwitch,
    isError,
    error,
    settings?.settings,
  ]);
};
