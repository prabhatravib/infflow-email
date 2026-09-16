import type { IOutgoingMessage, ParsedMessage, Label, DeleteAllSpamResponse } from '../../types';
import { ParsedMessageSchema } from '../../types';
import type { CreateDraftData } from '../schemas';
import { z } from 'zod';

export interface IGetThreadResponse {
  messages: ParsedMessage[];
  latest?: ParsedMessage;
  hasUnread: boolean;
  totalReplies: number;
  labels: { id: string; name: string }[];
  isLatestDraft?: boolean;
}

export const IGetThreadResponseSchema = z.object({
  messages: z.array(ParsedMessageSchema),
  latest: ParsedMessageSchema.optional(),
  hasUnread: z.boolean(),
  totalReplies: z.number(),
  labels: z.array(z.object({ id: z.string(), name: z.string() })),
});

/**
 * The subset of a thread the inbox list and the Hexa mailbox overview actually
 * render: sender, subject, date, recipients and label state. No message bodies,
 * no attachments. Gmail serves all of it from `format: 'metadata'`, which is a
 * fraction of the payload of the `format: 'full'` fetch `get` performs -- the
 * list discards every body it currently downloads.
 */
export interface IThreadHeader {
  id: string;
  latest?: {
    id: string;
    threadId: string;
    sender: { name?: string; email: string };
    subject: string;
    receivedOn: string;
    to: { name?: string; email: string }[];
    tags: { id: string; name: string; type: string }[];
    unread: boolean;
  };
  hasUnread: boolean;
  /** The thread holds an unsent draft, so the row shows the draft badge. */
  hasDraft: boolean;
  /** More than one recipient across to/cc/bcc, so the row shows the group avatar. */
  isGroupThread: boolean;
  labels: { id: string; name: string }[];
  totalReplies: number;
}

const PersonSchema = z.object({
  name: z.string().optional(),
  email: z.string(),
});

export const IThreadHeaderSchema = z.object({
  id: z.string(),
  latest: z
    .object({
      id: z.string(),
      threadId: z.string(),
      sender: PersonSchema,
      subject: z.string(),
      receivedOn: z.string(),
      to: z.array(PersonSchema),
      tags: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })),
      unread: z.boolean(),
    })
    .optional(),
  hasUnread: z.boolean(),
  hasDraft: z.boolean(),
  isGroupThread: z.boolean(),
  labels: z.array(z.object({ id: z.string(), name: z.string() })),
  totalReplies: z.number(),
});

export const IThreadHeadersResponseSchema = z.array(IThreadHeaderSchema);

/**
 * Ids per `listThreadHeaders` call. The client chunks a page of the list to this
 * size and the driver batches within it, which keeps one request well inside the
 * Worker's outbound subrequest budget while still collapsing a 100-thread page
 * into a handful of round trips instead of one per row.
 */
export const MAX_THREAD_HEADER_IDS = 25;

export interface ParsedDraft {
  id: string;
  to?: string[];
  subject?: string;
  content?: string;
  rawMessage?: {
    internalDate?: string | null;
  };
  cc?: string[];
  bcc?: string[];
}

export interface IConfig {
  auth?: {
    access_token: string;
    refresh_token: string;
    email: string;
  };
}

export type ManagerConfig = {
  auth: {
    userId: string;
    // accountId: string;
    accessToken: string;
    refreshToken: string;
    email: string;
  };
};

export interface MailManager {
  config: ManagerConfig;
  getMessageAttachments(id: string): Promise<
    {
      filename: string;
      mimeType: string;
      size: number;
      attachmentId: string;
      headers: { name: string; value: string }[];
      body: string;
    }[]
  >;
  get(id: string): Promise<IGetThreadResponse>;
  getThreadHeaders(ids: string[]): Promise<IThreadHeader[]>;
  create(data: IOutgoingMessage): Promise<{ id?: string | null }>;
  sendDraft(id: string, data: IOutgoingMessage): Promise<void>;
  createDraft(
    data: CreateDraftData,
  ): Promise<{ id?: string | null; success?: boolean; error?: string }>;
  getDraft(id: string): Promise<ParsedDraft>;
  listDrafts(params: { q?: string; maxResults?: number; pageToken?: string }): Promise<{
    threads: { id: string; historyId: string | null; $raw: unknown }[];
    nextPageToken: string | null;
  }>;
  delete(id: string): Promise<void>;
  list(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string | number;
  }): Promise<{
    threads: { id: string; historyId: string | null; $raw?: unknown }[];
    nextPageToken: string | null;
  }>;
  count(): Promise<{ count?: number; label?: string }[]>;
  getTokens(
    code: string,
  ): Promise<{ tokens: { access_token?: string; refresh_token?: string; expiry_date?: number } }>;
  getUserInfo(
    tokens?: ManagerConfig['auth'],
  ): Promise<{ address: string; name: string; photo: string }>;
  getScope(): string;
  listHistory<T>(historyId: string): Promise<{ history: T[]; historyId: string }>;
  markAsRead(threadIds: string[]): Promise<void>;
  markAsUnread(threadIds: string[]): Promise<void>;
  normalizeIds(id: string[]): { threadIds: string[] };
  modifyLabels(
    id: string[],
    options: { addLabels: string[]; removeLabels: string[] },
  ): Promise<void>;
  getAttachment(messageId: string, attachmentId: string): Promise<string | undefined>;
  getUserLabels(): Promise<Label[]>;
  getLabel(id: string): Promise<Label>;
  createLabel(label: {
    name: string;
    color?: { backgroundColor: string; textColor: string };
  }): Promise<void>;
  updateLabel(
    id: string,
    label: { name: string; color?: { backgroundColor: string; textColor: string } },
  ): Promise<void>;
  deleteLabel(id: string): Promise<void>;
  getEmailAliases(): Promise<{ email: string; name?: string; primary?: boolean }[]>;
  revokeToken(token: string): Promise<boolean>;
  deleteAllSpam(): Promise<DeleteAllSpamResponse>;
}

export interface IGetThreadsResponse {
  threads: { id: string; historyId: string | null; $raw?: unknown }[];
  nextPageToken: string | null;
}

export const IGetThreadsResponseSchema = z.object({
  threads: z.array(
    z.object({
      id: z.string(),
      historyId: z.string().nullable(),
      $raw: z.unknown().optional(),
    }),
  ),
  nextPageToken: z.string().nullable(),
});
