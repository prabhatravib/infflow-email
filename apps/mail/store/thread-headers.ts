import type { IThreadHeader } from '../../server/src/lib/driver/types';
import { atom } from 'jotai';

/**
 * Sender, subject, date and label state for every thread the list has fetched
 * headers for, keyed by thread id.
 *
 * This is the list's data source and the Hexa mailbox overview's. It exists as
 * an atom rather than living in the query cache because the fetch is batched --
 * one request covers many threads, so there is no per-thread query entry for a
 * row or the overview to read.
 *
 * Entries are kept when the list unmounts. The sidebar renders on routes with no
 * mail list (settings, for one), and an empty overview there would tell the
 * assistant the mailbox is empty rather than that it is not looking at it.
 */
export const threadHeadersAtom = atom<Map<string, IThreadHeader>>(new Map());
