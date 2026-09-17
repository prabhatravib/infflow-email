import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { env } from 'cloudflare:workers';
import {
  account,
  connection,
  note,
  session,
  user,
  userHotkeys,
  userSettings,
  writingStyleMatrix,
} from '../db/schema-d1';
import { createDb } from '../db';
import { eq, and, desc, asc, inArray } from 'drizzle-orm';
import { EProviders } from '../types';
import { defaultUserSettings } from '../lib/schemas';

/**
 * The D1 tables are declared with snake_case columns (`src/db/migrations-d1.sql`)
 * while every caller reads the camelCase field names from `schema-d1.ts`. A raw
 * `SELECT *` hands the column names back verbatim, so rows have to be mapped on
 * the way out — the same translation `ZeroDriver.setupAuth` does by hand.
 */
const toCamelCase = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const toSnakeCase = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const mapRow = <T>(row: Record<string, unknown> | null | undefined): T | undefined => {
  if (!row) return undefined;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [toCamelCase(key), value]),
  ) as T;
};

/**
 * `D1PreparedStatement.all()` resolves to a `D1Result` wrapper — `{ results, success,
 * meta }` — never to a bare array. Returning it unwrapped is what made
 * `connections.filter is not a function` reach the inbox.
 */
const mapRows = <T>(result: D1Result<Record<string, unknown>>): T[] =>
  (result.results ?? []).map((row) => mapRow<T>(row) as T);

/** D1 cannot bind a `Date`; `createConnection` already stores timestamps as ISO strings. */
const toBindable = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

export class ZeroDB extends DurableObject<Env> {
  private db: D1Database | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    
    // Initialize D1 database if available
    if (env.DB) {
      this.db = env.DB;
      console.log('[ZeroDB] D1 database initialized');
    } else {
      console.log('[ZeroDB] D1 database not available, using fallback storage');
    }
  }

  async setMetaData(userId: string) {
    return new DbRpcDO(this, userId);
  }

  // private async createTables() {
  //   if (!this.db) return;
    
  //   try {
  //     // Create tables if they don't exist
  //     await this.db.prepare(`
  //       CREATE TABLE IF NOT EXISTS users (
  //         id TEXT PRIMARY KEY,
  //         email TEXT UNIQUE NOT NULL,
  //         name TEXT,
  //         image TEXT,
  //         createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  //         updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  //       )
  //     `).run();

  //     await this.db.prepare(`
  //       CREATE TABLE IF NOT EXISTS connections (
  //         id TEXT PRIMARY KEY,
  //         userId TEXT NOT NULL,
  //         providerId TEXT NOT NULL,
  //         email TEXT NOT NULL,
  //         accessToken TEXT,
  //         refreshToken TEXT,
  //         expiresAt DATETIME,
  //         scope TEXT,
  //         createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  //         updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  //         FOREIGN KEY (userId) REFERENCES users(id)
  //       )
  //     `).run();

  //     await this.db.prepare(`
  //       CREATE TABLE IF NOT EXISTS threads (
  //         id TEXT PRIMARY KEY,
  //         connectionId TEXT NOT NULL,
  //         threadId TEXT NOT NULL,
  //         data TEXT NOT NULL,
  //         createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  //         updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  //       )
  //     `).run();

  //     await this.db.prepare(`
  //       CREATE TABLE IF NOT EXISTS sessions (
  //         id TEXT PRIMARY KEY,
  //         userId TEXT NOT NULL,
  //         data TEXT NOT NULL,
  //         createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  //         FOREIGN KEY (userId) REFERENCES users(id)
  //       )
  //     `).run();

  //     console.log('[ZeroDB] Tables created successfully');
  //   } catch (error) {
  //     console.error('[ZeroDB] Error creating tables:', error);
  //   }
  // }

  private async sql(query: string, params: any[] = []) {
    if (!this.db) {
      throw new Error('D1 database not available');
    }
    
    const stmt = this.db.prepare(query);
    return stmt.bind(...params);
  }

  async findUser(userId: string) {
    if (!this.db) {
      // Fallback to Hyperdrive
      const { db } = createDb(env.HYPERDRIVE.connectionString);
      return await db.query.user.findFirst({
        where: eq(user.id, userId),
      });
    }

    const result = await this.sql('SELECT * FROM mail0_user WHERE id = ?', [userId]);
    const userData = await result.first();
    return mapRow<typeof user.$inferSelect>(userData);
  }

  async findUserSettings(userId: string) {
    if (!this.db) {
      // Fallback to Hyperdrive
      const { db } = createDb(env.HYPERDRIVE.connectionString);
      return await db.query.userSettings.findFirst({
        where: eq(userSettings.userId, userId),
      });
    }

    const result = await this.sql('SELECT * FROM mail0_user_settings WHERE user_id = ?', [userId]);
    const settingsData = await result.first();
    return mapRow<typeof userSettings.$inferSelect>(settingsData);
  }

  async insertUserSettings(userId: string, settings: any) {
    if (!this.db) {
      // Fallback to Hyperdrive
      const { db } = createDb(env.HYPERDRIVE.connectionString);
      return await db.insert(userSettings).values({
        id: crypto.randomUUID(),
        userId,
        settings,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    await this.sql(
      'INSERT INTO mail0_user_settings (id, user_id, settings, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [crypto.randomUUID(), userId, JSON.stringify(settings)]
    );
  }

  async updateUserSettings(userId: string, settings: any) {
    if (!this.db) {
      // Fallback to Hyperdrive
      const { db } = createDb(env.HYPERDRIVE.connectionString);
      return await db
        .insert(userSettings)
        .values({
          id: crypto.randomUUID(),
          userId,
          settings,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: {
            settings,
            updatedAt: new Date(),
          },
        });
    }

    await this.sql(
      'INSERT OR REPLACE INTO mail0_user_settings (id, user_id, settings, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [crypto.randomUUID(), userId, JSON.stringify(settings)]
    );
  }

  async findUserConnection(userId: string, connectionId: string) {
    if (!this.db) {
      // Fallback to Hyperdrive
      const { db } = createDb(env.HYPERDRIVE.connectionString);
      return await db.query.connection.findFirst({
        where: and(eq(connection.id, connectionId), eq(connection.userId, userId)),
      });
    }

    const result = await this.sql(
      'SELECT * FROM mail0_connection WHERE id = ? AND user_id = ?',
      [connectionId, userId]
    );
    const connectionData = await result.first();
    return mapRow<typeof connection.$inferSelect>(connectionData);
  }

  async updateUser(userId: string, data: Partial<typeof user.$inferInsert>) {
    if (!this.db) {
      // Fallback to Hyperdrive
      const { db } = createDb(env.HYPERDRIVE.connectionString);
      return await db
        .update(user)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(user.id, userId));
    }

    // Keys and values have to be taken from the same entries: filtering them
    // separately shifts every value one column left as soon as one is undefined.
    const entries = Object.entries(data).filter(
      ([key, value]) => key !== 'id' && value !== undefined,
    );

    if (entries.length === 0) return;

    const setClause = entries.map(([field]) => `${toSnakeCase(field)} = ?`).join(', ');
    const query = `UPDATE mail0_user SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;

    await this.sql(query, [...entries.map(([, value]) => toBindable(value)), userId]);
  }

  async deleteConnection(connectionId: string, userId: string) {
    if (!this.db) {
      // Fallback to Hyperdrive
      const { db } = createDb(env.HYPERDRIVE.connectionString);
      return await db
        .delete(connection)
        .where(and(eq(connection.id, connectionId), eq(connection.userId, userId)));
    }

    await this.sql(
      'DELETE FROM mail0_connection WHERE id = ? AND user_id = ?',
      [connectionId, userId]
    );
  }

  async findFirstConnection(userId: string) {
    if (!this.db) {
      // Fallback to Hyperdrive
      const { db } = createDb(env.HYPERDRIVE.connectionString);
      return await db.query.connection.findFirst({
        where: eq(connection.userId, userId),
      });
    }

    const result = await this.sql(
      'SELECT * FROM mail0_connection WHERE user_id = ? ORDER BY created_at ASC LIMIT 1',
      [userId]
    );
    const connectionData = await result.first();
    return mapRow<typeof connection.$inferSelect>(connectionData);
  }

  async findManyConnections(userId: string) {
    if (!this.db) {
      // Fallback to Hyperdrive
      const { db } = createDb(env.HYPERDRIVE.connectionString);
      return await db.query.connection.findMany({
        where: eq(connection.userId, userId),
      });
    }

    const result = await this.sql(
      'SELECT * FROM mail0_connection WHERE user_id = ? ORDER BY created_at ASC',
      [userId]
    );
    return mapRows<typeof connection.$inferSelect>(await result.all());
  }

  async createConnection(
    providerId: EProviders,
    email: string,
    userId: string,
    updatingInfo: {
      expiresAt: Date;
      scope: string;
      accessToken: string;
      refreshToken: string;
      name?: string;
      picture?: string;
    },
  ) {
    // Handle potential RPC serialization issues by ensuring all values are properly typed
    // Also handle base64 encoded tokens
    let accessToken = String(updatingInfo.accessToken || '');
    let refreshToken = String(updatingInfo.refreshToken || '');
    
    // Check if tokens are base64 encoded and decode them
    try {
      if (accessToken && !accessToken.startsWith('ya29.') && !accessToken.startsWith('1//')) {
        // Try to decode as base64
        const decodedAccessToken = atob(accessToken);
        if (decodedAccessToken && decodedAccessToken.length > 10) {
          accessToken = decodedAccessToken;
          console.log('Decoded base64 access token successfully');
        }
      }
      
      if (refreshToken && !refreshToken.startsWith('1//')) {
        // Try to decode as base64
        const decodedRefreshToken = atob(refreshToken);
        if (decodedRefreshToken && decodedRefreshToken.length > 10) {
          refreshToken = decodedRefreshToken;
          console.log('Decoded base64 refresh token successfully');
        }
      }
    } catch (decodeError) {
      console.log('Token decoding failed, using original tokens:', decodeError);
    }
    
    const sanitizedUpdatingInfo = {
      accessToken: accessToken,
      refreshToken: refreshToken,
      scope: String(updatingInfo.scope || ''),
      expiresAt: updatingInfo.expiresAt instanceof Date ? updatingInfo.expiresAt : new Date(updatingInfo.expiresAt || Date.now() + 3600000),
      name: String(updatingInfo.name || ''),
      picture: String(updatingInfo.picture || ''),
    };
    // Debug: Log what we received from the RPC call
    console.log('ZeroDB received parameters:', {
      providerId,
      email,
      userId,
      updatingInfo: {
        accessToken: sanitizedUpdatingInfo.accessToken ? `${sanitizedUpdatingInfo.accessToken.substring(0, 10)}...` : 'NULL',
        refreshToken: sanitizedUpdatingInfo.refreshToken ? `${sanitizedUpdatingInfo.refreshToken.substring(0, 10)}...` : 'NULL',
        scope: sanitizedUpdatingInfo.scope,
        expiresAt: sanitizedUpdatingInfo.expiresAt,
        name: sanitizedUpdatingInfo.name,
        picture: sanitizedUpdatingInfo.picture,
      }
    });
    
    // Additional debugging for RPC serialization issues
    console.log('RPC parameter types:', {
      providerIdType: typeof providerId,
      emailType: typeof email,
      userIdType: typeof userId,
      updatingInfoType: typeof updatingInfo,
      accessTokenType: typeof sanitizedUpdatingInfo.accessToken,
      refreshTokenType: typeof sanitizedUpdatingInfo.refreshToken,
      scopeType: typeof sanitizedUpdatingInfo.scope,
      expiresAtType: typeof sanitizedUpdatingInfo.expiresAt,
    });
    
    // Additional debugging for token values
    console.log('Token debugging:', {
      accessTokenType: typeof sanitizedUpdatingInfo.accessToken,
      accessTokenIsUndefined: sanitizedUpdatingInfo.accessToken === undefined,
      accessTokenIsNull: sanitizedUpdatingInfo.accessToken === null,
      accessTokenLength: sanitizedUpdatingInfo.accessToken?.length,
      refreshTokenType: typeof sanitizedUpdatingInfo.refreshToken,
      refreshTokenIsUndefined: sanitizedUpdatingInfo.refreshToken === undefined,
      refreshTokenIsNull: sanitizedUpdatingInfo.refreshToken === null,
      refreshTokenLength: sanitizedUpdatingInfo.refreshToken?.length,
    });
    if (!this.db) {
      // Fallback to Hyperdrive
      const { db } = createDb(env.HYPERDRIVE.connectionString);
      return await db
        .insert(connection)
        .values({
          providerId,
          id: crypto.randomUUID(),
          email,
          userId,
          accessToken: sanitizedUpdatingInfo.accessToken,
          refreshToken: sanitizedUpdatingInfo.refreshToken,
          expiresAt: sanitizedUpdatingInfo.expiresAt,
          scope: sanitizedUpdatingInfo.scope,
          name: sanitizedUpdatingInfo.name,
          picture: sanitizedUpdatingInfo.picture,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [connection.email, connection.userId],
          set: {
            accessToken: sanitizedUpdatingInfo.accessToken,
            refreshToken: sanitizedUpdatingInfo.refreshToken,
            expiresAt: sanitizedUpdatingInfo.expiresAt,
            scope: sanitizedUpdatingInfo.scope,
            name: sanitizedUpdatingInfo.name,
            picture: sanitizedUpdatingInfo.picture,
            updatedAt: new Date(),
          },
        });
    }

    // Ensure expiresAt is a proper Date object (RPC serialization might convert it to string)
    const expiresAt = sanitizedUpdatingInfo.expiresAt instanceof Date 
      ? sanitizedUpdatingInfo.expiresAt 
      : new Date(sanitizedUpdatingInfo.expiresAt || Date.now() + 3600000);

    const connectionId = crypto.randomUUID();
    
    // Debug: Log the values being inserted
    console.log('Database insert debug:', {
      connectionId,
      userId,
      providerId,
      email,
      accessToken: sanitizedUpdatingInfo.accessToken || null,
      refreshToken: sanitizedUpdatingInfo.refreshToken || null,
      expiresAt: expiresAt.toISOString(),
      scope: sanitizedUpdatingInfo.scope,
      name: sanitizedUpdatingInfo.name || null,
      picture: sanitizedUpdatingInfo.picture || null,
    });
    
    // Additional debug for scope field
    console.log('Scope field debug:', {
      scopeValue: sanitizedUpdatingInfo.scope,
      scopeType: typeof sanitizedUpdatingInfo.scope,
      scopeIsUndefined: sanitizedUpdatingInfo.scope === undefined,
      scopeIsNull: sanitizedUpdatingInfo.scope === null,
      scopeLength: sanitizedUpdatingInfo.scope?.length,
    });
    
    // First, let's check what tables exist
    try {
      const allTables = await this.sql('SELECT name FROM sqlite_master WHERE type="table"');
      const tables = (await allTables.all()).results;
      console.log('All tables in database:', tables);
      
      const tableCheck = await this.sql('SELECT name FROM sqlite_master WHERE type="table" AND name="mail0_connection"');
      const tableExists = await tableCheck.first();
      console.log('Table exists check:', tableExists);
      
      if (!tableExists) {
        console.error('Table mail0_connection does not exist!');
        throw new Error('Table mail0_connection does not exist');
      }
    } catch (error) {
      console.error('Error checking table existence:', error);
      throw error;
    }
    
    // Ensure scope is not undefined
    const scopeValue = sanitizedUpdatingInfo.scope || '';
    
    // Validate tokens before insertion
    if (!sanitizedUpdatingInfo.accessToken || sanitizedUpdatingInfo.accessToken === '') {
      console.error('Access token is empty, cannot create connection');
      console.error('Token debugging details:', {
        accessToken: sanitizedUpdatingInfo.accessToken,
        accessTokenType: typeof sanitizedUpdatingInfo.accessToken,
        accessTokenLength: sanitizedUpdatingInfo.accessToken?.length,
        refreshToken: sanitizedUpdatingInfo.refreshToken,
        refreshTokenType: typeof sanitizedUpdatingInfo.refreshToken,
        refreshTokenLength: sanitizedUpdatingInfo.refreshToken?.length,
      });
      throw new Error('Access token is required for connection creation');
    }
    
    if (!sanitizedUpdatingInfo.refreshToken || sanitizedUpdatingInfo.refreshToken === '') {
      console.error('Refresh token is empty, cannot create connection');
      console.error('Token debugging details:', {
        accessToken: sanitizedUpdatingInfo.accessToken,
        accessTokenType: typeof sanitizedUpdatingInfo.accessToken,
        accessTokenLength: sanitizedUpdatingInfo.accessToken?.length,
        refreshToken: sanitizedUpdatingInfo.refreshToken,
        refreshTokenType: typeof sanitizedUpdatingInfo.refreshToken,
        refreshTokenLength: sanitizedUpdatingInfo.refreshToken?.length,
      });
      throw new Error('Refresh token is required for connection creation');
    }
    
    // `INSERT OR REPLACE` only de-duplicates on a unique constraint, and the id
    // is a fresh UUID every call, so a re-login used to append another row for
    // the same mailbox. Reuse the existing row when we already hold one.
    const existingRow = await (
      await this.sql(
        'SELECT id FROM mail0_connection WHERE user_id = ? AND email = ? LIMIT 1',
        [userId, email],
      )
    ).first<{ id: string }>();

    if (existingRow?.id) {
      console.log('Refreshing existing connection instead of inserting a duplicate:', existingRow.id);
      // `sql()` only binds the statement - a write has to be run explicitly.
      await (
        await this.sql(
          `UPDATE mail0_connection
           SET provider_id = ?, access_token = ?, refresh_token = ?, expires_at = ?, scope = ?, name = ?, picture = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            providerId,
            sanitizedUpdatingInfo.accessToken,
            sanitizedUpdatingInfo.refreshToken,
            expiresAt.toISOString(),
            scopeValue,
            sanitizedUpdatingInfo.name || null,
            sanitizedUpdatingInfo.picture || null,
            existingRow.id,
          ],
        )
      ).run();
      return [{ id: existingRow.id }];
    }

    console.log('Inserting connection with tokens:', {
      connectionId,
      accessToken: sanitizedUpdatingInfo.accessToken ? 'SET' : 'NULL',
      refreshToken: sanitizedUpdatingInfo.refreshToken ? 'SET' : 'NULL',
      scope: scopeValue,
    });

    await this.sql(
      `INSERT OR REPLACE INTO mail0_connection
       (id, user_id, provider_id, email, access_token, refresh_token, expires_at, scope, name, picture, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        connectionId,
        userId,
        providerId,
        email,
        sanitizedUpdatingInfo.accessToken,
        sanitizedUpdatingInfo.refreshToken,
        expiresAt.toISOString(),
        scopeValue,
        sanitizedUpdatingInfo.name || null,
        sanitizedUpdatingInfo.picture || null,
      ]
    );

    return [{ id: connectionId }];
  }

  async updateConnection(
    connectionId: string,
    updatingInfo: Partial<typeof connection.$inferInsert>,
  ) {
    if (!this.db) {
      // Fallback to Hyperdrive
      const { db } = createDb(env.HYPERDRIVE.connectionString);
      return await db
        .update(connection)
        .set(updatingInfo)
        .where(eq(connection.id, connectionId));
    }

    const entries = Object.entries(updatingInfo).filter(
      ([key, value]) => key !== 'id' && value !== undefined,
    );

    if (entries.length === 0) return;

    const setClause = entries.map(([field]) => `${toSnakeCase(field)} = ?`).join(', ');
    const query = `UPDATE mail0_connection SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;

    await this.sql(query, [...entries.map(([, value]) => toBindable(value)), connectionId]);
  }

  // Thread operations
  async storeThread(connectionId: string, threadId: string, data: any) {
    if (!this.db) {
      // Fallback to storage
      await this.state.storage.put(`thread:${connectionId}:${threadId}`, data);
      return;
    }

    await this.sql(
      `INSERT OR REPLACE INTO threads (id, connection_id, thread_id, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [crypto.randomUUID(), connectionId, threadId, JSON.stringify(data)]
    );
  }

  async getThread(connectionId: string, threadId: string) {
    if (!this.db) {
      // Fallback to storage
      return await this.state.storage.get(`thread:${connectionId}:${threadId}`);
    }

    const result = await this.sql(
      'SELECT data FROM threads WHERE connection_id = ? AND thread_id = ?',
      [connectionId, threadId]
    );
    const threadData = await result.first();
    return threadData ? JSON.parse(threadData.data) : null;
  }

  async getThreads(connectionId: string, limit = 50, offset = 0) {
    if (!this.db) {
      // Fallback to storage
      const keys = await this.state.storage.list({ prefix: `thread:${connectionId}:` });
      const threads = [];
      for (const [key, value] of keys.entries()) {
        threads.push(value);
      }
      return threads.slice(offset, offset + limit);
    }

    const result = await this.sql(
      'SELECT data FROM threads WHERE connection_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      [connectionId, limit, offset]
    );
    const threads = (await result.all<{ data: string }>()).results;
    return threads.map(thread => JSON.parse(thread.data));
  }

  async deleteThread(connectionId: string, threadId: string) {
    if (!this.db) {
      // Fallback to storage
      await this.state.storage.delete(`thread:${connectionId}:${threadId}`);
      return;
    }

    await this.sql(
      'DELETE FROM threads WHERE connection_id = ? AND thread_id = ?',
      [connectionId, threadId]
    );
  }

  async getThreadCount(connectionId: string) {
    if (!this.db) {
      // Fallback to storage
      const keys = await this.state.storage.list({ prefix: `thread:${connectionId}:` });
      return keys.size;
    }

    const result = await this.sql(
      'SELECT COUNT(*) as count FROM threads WHERE connection_id = ?',
      [connectionId]
    );
    const countData = await result.first();
    return countData ? countData.count : 0;
  }

  async getFolderThreadCount(connectionId: string, folder: string) {
    if (!this.db) {
      // Fallback to storage
      const keys = await this.state.storage.list({ prefix: `thread:${connectionId}:` });
      let count = 0;
      for (const [key, value] of keys.entries()) {
        const thread = value;
        if (thread.folder === folder) {
          count++;
        }
      }
      return count;
    }

    const result = await this.sql(
      'SELECT COUNT(*) as count FROM threads WHERE connection_id = ? AND json_extract(data, "$.folder") = ?',
      [connectionId, folder]
    );
    const countData = await result.first();
    return countData ? countData.count : 0;
  }
}

export class DbRpcDO extends RpcTarget {
  constructor(
    private mainDo: ZeroDB,
    private userId: string,
  ) {
    super();
  }

  async findUser(): Promise<typeof user.$inferSelect | undefined> {
    return await this.mainDo.findUser(this.userId);
  }

  async findUserSettings(): Promise<typeof userSettings.$inferSelect | undefined> {
    return await this.mainDo.findUserSettings(this.userId);
  }

  async insertUserSettings(settings: any) {
    return await this.mainDo.insertUserSettings(this.userId, settings);
  }

  async updateUserSettings(settings: any) {
    return await this.mainDo.updateUserSettings(this.userId, settings);
  }

  async findUserConnection(
    connectionId: string,
  ): Promise<typeof connection.$inferSelect | undefined> {
    return await this.mainDo.findUserConnection(this.userId, connectionId);
  }

  async updateUser(data: Partial<typeof user.$inferInsert>) {
    return await this.mainDo.updateUser(this.userId, data);
  }

  async deleteConnection(connectionId: string) {
    return await this.mainDo.deleteConnection(connectionId, this.userId);
  }

  async findFirstConnection(): Promise<typeof connection.$inferSelect | undefined> {
    return await this.mainDo.findFirstConnection(this.userId);
  }

  async findManyConnections(): Promise<(typeof connection.$inferSelect)[]> {
    return await this.mainDo.findManyConnections(this.userId);
  }

  async createConnection(
    providerId: EProviders,
    email: string,
    updatingInfo: {
      expiresAt: Date;
      scope: string;
      accessToken: string;
      refreshToken: string;
      name?: string;
      picture?: string;
    },
  ): Promise<{ id: string }[]> {
    return await this.mainDo.createConnection(providerId, email, this.userId, updatingInfo);
  }

  async updateConnection(
    connectionId: string,
    updatingInfo: Partial<typeof connection.$inferInsert>,
  ) {
    return await this.mainDo.updateConnection(connectionId, updatingInfo);
  }

  // Thread operations
  async storeThread(connectionId: string, threadId: string, data: any) {
    return await this.mainDo.storeThread(connectionId, threadId, data);
  }

  async getThread(connectionId: string, threadId: string) {
    return await this.mainDo.getThread(connectionId, threadId);
  }

  async getThreads(connectionId: string, limit = 50, offset = 0) {
    return await this.mainDo.getThreads(connectionId, limit, offset);
  }

  async deleteThread(connectionId: string, threadId: string) {
    return await this.mainDo.deleteThread(connectionId, threadId);
  }

  async getThreadCount(connectionId: string) {
    return await this.mainDo.getThreadCount(connectionId);
  }

  async getFolderThreadCount(connectionId: string, folder: string) {
    return await this.mainDo.getFolderThreadCount(connectionId, folder);
  }
} 