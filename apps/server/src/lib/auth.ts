import {
  AIWritingAssistantEmail,
  AutoLabelingEmail,
  CategoriesEmail,
  Mail0ProEmail,
  ShortcutsEmail,
  SuperSearchEmail,
  WelcomeEmail,
} from './react-emails/email-sequences';
import { createAuthMiddleware, jwt, bearer, mcp } from 'better-auth/plugins';
import { type Account, betterAuth, type BetterAuthOptions } from 'better-auth';
import { getBrowserTimezone, isValidTimezone } from './timezones';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getSocialProviders } from './auth-providers';
import { redis, resend } from './services';
import { getContext } from 'hono/context-storage';

import { defaultUserSettings } from './schemas';
import { disableBrainFunction, enableBrainFunction } from './brain';
import { APIError } from 'better-auth/api';
import { getZeroDB } from './server-utils';
import { type EProviders } from '../types';
import type { HonoContext } from '../ctx';
import { env } from 'cloudflare:workers';
import { createDriver } from './driver';
import { createDb, type DB } from '../db';
import * as schema from '../db/schema-d1';
import { Effect } from 'effect';


const scheduleCampaign = (userInfo: { address: string; name: string }) =>
  Effect.gen(function* () {
    const name = userInfo.name || 'there';
    const resendService = resend();

    const sendEmail = (subject: string, react: unknown, scheduledAt?: string) =>
      Effect.promise(() =>
        resendService.emails
          .send({
            from: '0.email <onboarding@0.email>',
            to: userInfo.address,
            subject,
            react: react as any,
            ...(scheduledAt && { scheduledAt }),
          })
          .then(() => void 0),
      );

    const emails = [
      {
        subject: 'Welcome to 0.email',
        react: WelcomeEmail({ name }),
        scheduledAt: undefined,
      },
      {
        subject: 'Mail0 Pro is here 🚀💼',
        react: Mail0ProEmail({ name }),
        scheduledAt: 'in 1 day',
      },
      {
        subject: 'Auto-labeling is here 🎉📥',
        react: AutoLabelingEmail({ name }),
        scheduledAt: 'in 2 days',
      },
      {
        subject: 'AI Writing Assistant is here 🤖💬',
        react: AIWritingAssistantEmail({ name }),
        scheduledAt: 'in 3 days',
      },
      {
        subject: 'Shortcuts are here 🔧🚀',
        react: ShortcutsEmail({ name }),
        scheduledAt: 'in 4 days',
      },
      {
        subject: 'Categories are here 📂🔍',
        react: CategoriesEmail({ name }),
        scheduledAt: 'in 5 days',
      },
      {
        subject: 'Super Search is here 🔍🚀',
        react: SuperSearchEmail({ name }),
        scheduledAt: 'in 6 days',
      },
    ];

    yield* Effect.all(
      emails.map((email) => sendEmail(email.subject, email.react, email.scheduledAt)),
      { concurrency: 'unbounded' },
    );
  });

export const connectionHandlerHook = async (account: Account) => {
  console.log('Connection handler hook called with account:', {
    providerId: account.providerId,
    userId: account.userId,
    hasAccessToken: !!account.accessToken,
    hasRefreshToken: !!account.refreshToken,
    accessTokenExpiresAt: account.accessTokenExpiresAt,
    scope: account.scope,
  });
  
  console.log('Starting connection creation process...');
  
  if (!account.accessToken || !account.refreshToken) {
    console.error('Missing Access/Refresh Tokens', { 
      account: {
        providerId: account.providerId,
        userId: account.userId,
        hasAccessToken: !!account.accessToken,
        hasRefreshToken: !!account.refreshToken,
        accessTokenExpiresAt: account.accessTokenExpiresAt,
        scope: account.scope,
      }
    });
    throw new APIError('EXPECTATION_FAILED', { message: 'Missing Access/Refresh Tokens' });
  }

  console.log('Creating driver for provider:', account.providerId);
  const driver = createDriver(account.providerId, {
    auth: {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      userId: account.userId,
      email: '',
    },
  });
  
  console.log('Driver created successfully:', {
    providerId: account.providerId,
    driverType: driver.constructor.name,
    hasGetScope: typeof driver.getScope === 'function'
  });

  console.log('Getting user info from driver...');
  const userInfo = await driver.getUserInfo().catch((error) => {
    console.error('Failed to get user info:', error);
    throw new APIError('UNAUTHORIZED', { message: 'Failed to get user info' });
  });
  
  console.log('User info received:', { address: userInfo?.address, name: userInfo?.name });

  if (!userInfo?.address) {
    console.error('Missing email in user info:', { userInfo });
    throw new APIError('BAD_REQUEST', { message: 'Missing "email" in user info' });
  }

  // Ensure expiresAt is a proper Date object
  const expiresAt = account.accessTokenExpiresAt 
    ? (account.accessTokenExpiresAt instanceof Date 
        ? account.accessTokenExpiresAt 
        : new Date(account.accessTokenExpiresAt))
    : new Date(Date.now() + 3600000);

  console.log('ExpiresAt debug:', {
    original: account.accessTokenExpiresAt,
    type: typeof account.accessTokenExpiresAt,
    isDate: account.accessTokenExpiresAt instanceof Date,
    final: expiresAt,
    finalType: typeof expiresAt,
    finalIsDate: expiresAt instanceof Date
  });

  // Get scope from driver or fallback to account scope
  let scope = '';
  try {
    scope = driver.getScope() || account.scope || '';
  } catch (error) {
    console.error('Error getting scope from driver:', error);
    scope = account.scope || '';
  }
  
  // If still no scope, use a default scope for Google
  if (!scope && account.providerId === 'google') {
    scope = 'https://mail.google.com/ https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';
  }
  
  console.log('Scope debug:', {
    driverScope: driver.getScope(),
    accountScope: account.scope,
    finalScope: scope
  });

  const updatingInfo = {
    name: userInfo.name || 'Unknown',
    picture: userInfo.photo || '',
    accessToken: account.accessToken || '',
    refreshToken: account.refreshToken || '',
    scope: scope,
    expiresAt: expiresAt,
  };
  
  // Ensure all values are strings to avoid RPC serialization issues
  const sanitizedUpdatingInfo = {
    name: String(updatingInfo.name || ''),
    picture: String(updatingInfo.picture || ''),
    accessToken: String(updatingInfo.accessToken || ''),
    refreshToken: String(updatingInfo.refreshToken || ''),
    scope: String(updatingInfo.scope || ''),
    expiresAt: updatingInfo.expiresAt,
  };
  
  // Validate that tokens are not empty
  if (!sanitizedUpdatingInfo.accessToken || sanitizedUpdatingInfo.accessToken === '') {
    console.error('Access token is empty in sanitizedUpdatingInfo');
    throw new APIError('BAD_REQUEST', { message: 'Access token is required for connection creation' });
  }
  
  if (!sanitizedUpdatingInfo.refreshToken || sanitizedUpdatingInfo.refreshToken === '') {
    console.error('Refresh token is empty in sanitizedUpdatingInfo');
    throw new APIError('BAD_REQUEST', { message: 'Refresh token is required for connection creation' });
  }
  
  // Debug: Log the actual token values being passed
  console.log('Token validation passed:', {
    accessTokenLength: sanitizedUpdatingInfo.accessToken.length,
    refreshTokenLength: sanitizedUpdatingInfo.refreshToken.length,
    accessTokenFirstChars: sanitizedUpdatingInfo.accessToken.substring(0, 10) + '...',
    refreshTokenFirstChars: sanitizedUpdatingInfo.refreshToken.substring(0, 10) + '...',
  });

  console.log('Getting ZeroDB instance for user:', account.userId);
  const db = await getZeroDB(account.userId);
  
  // Check if database is properly initialized
  console.log('Database initialization check:', {
    hasDb: !!db,
    dbType: db?.constructor?.name
  });
  
  // Validate that all required fields are present
  if (!sanitizedUpdatingInfo.scope) {
    console.error('Scope is missing from sanitizedUpdatingInfo:', sanitizedUpdatingInfo);
    throw new APIError('BAD_REQUEST', { message: 'Scope is required for connection creation' });
  }
  
  if (!sanitizedUpdatingInfo.expiresAt) {
    console.error('ExpiresAt is missing from sanitizedUpdatingInfo:', sanitizedUpdatingInfo);
    throw new APIError('BAD_REQUEST', { message: 'ExpiresAt is required for connection creation' });
  }
  
  console.log('Creating connection in database...');
  console.log('Connection data:', {
    providerId: account.providerId,
    email: userInfo.address,
    userId: account.userId,
    sanitizedUpdatingInfo: {
      ...sanitizedUpdatingInfo,
      accessToken: sanitizedUpdatingInfo.accessToken ? 'SET' : 'NOT_SET',
      refreshToken: sanitizedUpdatingInfo.refreshToken ? 'SET' : 'NOT_SET',
    }
  });
  
  try {
    // Debug: Log exactly what we're passing to the RPC call
    console.log('RPC call parameters:', {
      providerId: account.providerId,
      email: userInfo.address,
      userId: account.userId,
      updatingInfo: {
        accessToken: sanitizedUpdatingInfo.accessToken ? `${sanitizedUpdatingInfo.accessToken.substring(0, 10)}...` : 'NULL',
        refreshToken: sanitizedUpdatingInfo.refreshToken ? `${sanitizedUpdatingInfo.refreshToken.substring(0, 10)}...` : 'NULL',
        scope: sanitizedUpdatingInfo.scope,
        expiresAt: sanitizedUpdatingInfo.expiresAt,
        name: sanitizedUpdatingInfo.name,
        picture: sanitizedUpdatingInfo.picture,
      }
    });
    
    // Ensure tokens are explicitly set to avoid RPC serialization issues
    const connectionData = {
      expiresAt: sanitizedUpdatingInfo.expiresAt,
      scope: sanitizedUpdatingInfo.scope,
      accessToken: sanitizedUpdatingInfo.accessToken,
      refreshToken: sanitizedUpdatingInfo.refreshToken,
      name: sanitizedUpdatingInfo.name,
      picture: sanitizedUpdatingInfo.picture,
    };
    
    console.log('Final connection data being sent:', {
      ...connectionData,
      accessToken: connectionData.accessToken ? `${connectionData.accessToken.substring(0, 10)}...` : 'NULL',
      refreshToken: connectionData.refreshToken ? `${connectionData.refreshToken.substring(0, 10)}...` : 'NULL',
    });
    
    // Try a simpler approach - use the original RPC call but ensure tokens are properly passed
    console.log('Using RPC call with proper token handling');
    
    // Ensure all values are explicitly set to avoid RPC serialization issues
    const rpcConnectionData = {
      accessToken: connectionData.accessToken || '',
      refreshToken: connectionData.refreshToken || '',
      scope: connectionData.scope || '',
      expiresAt: connectionData.expiresAt,
      name: connectionData.name || '',
      picture: connectionData.picture || '',
    };
    
    // Validate tokens before RPC call
    if (!rpcConnectionData.accessToken) {
      console.error('Access token is empty before RPC call');
      throw new APIError('BAD_REQUEST', { message: 'Access token is required for connection creation' });
    }
    
    if (!rpcConnectionData.refreshToken) {
      console.error('Refresh token is empty before RPC call');
      throw new APIError('BAD_REQUEST', { message: 'Refresh token is required for connection creation' });
    }
    
    console.log('RPC call data validation:', {
      accessTokenLength: rpcConnectionData.accessToken.length,
      refreshTokenLength: rpcConnectionData.refreshToken.length,
      scopeLength: rpcConnectionData.scope.length,
      hasExpiresAt: !!rpcConnectionData.expiresAt,
    });
    
    // Try to serialize and deserialize to test RPC compatibility
    try {
      const serialized = JSON.stringify(rpcConnectionData);
      const deserialized = JSON.parse(serialized);
      console.log('RPC serialization test:', {
        originalAccessTokenLength: rpcConnectionData.accessToken.length,
        deserializedAccessTokenLength: deserialized.accessToken.length,
        originalRefreshTokenLength: rpcConnectionData.refreshToken.length,
        deserializedRefreshTokenLength: deserialized.refreshToken.length,
      });
    } catch (error) {
      console.error('RPC serialization test failed:', error);
    }
    
    // COMPLETELY BYPASS RPC - Use direct database access
    console.log('COMPLETELY BYPASSING RPC - Using direct database access...');
    
    try {
      // Import database directly to avoid RPC entirely
      const { createDb } = await import('../db');
      // Always the D1 branch here (no Hyperdrive connection string), so narrow
      // away the Postgres half of createDb's return union.
      const db = createDb().db as DB;
      const { connection } = await import('../db/schema-d1');
      const { and, eq } = await import('drizzle-orm');

      console.log('Direct database approach - creating connection with tokens:', {
        accessTokenLength: rpcConnectionData.accessToken.length,
        refreshTokenLength: rpcConnectionData.refreshToken.length,
        scopeLength: rpcConnectionData.scope.length,
      });

      // A re-login for an account we already hold must refresh that connection,
      // not add a second one - otherwise the account switcher grows a new entry
      // on every sign in and the app keeps reading the oldest (stale) tokens.
      const existingConnection = await db.query.connection.findFirst({
        where: and(
          eq(connection.userId, account.userId),
          eq(connection.email, userInfo.address),
        ),
        columns: { id: true },
      });

      const connectionId = existingConnection?.id ?? crypto.randomUUID();
      const credentials = {
        providerId: account.providerId as EProviders,
        accessToken: rpcConnectionData.accessToken,
        refreshToken: rpcConnectionData.refreshToken,
        scope: rpcConnectionData.scope,
        expiresAt: rpcConnectionData.expiresAt,
        name: rpcConnectionData.name,
        picture: rpcConnectionData.picture,
        updatedAt: new Date(),
      };

      if (existingConnection) {
        await db.update(connection).set(credentials).where(eq(connection.id, connectionId));
        console.log('DIRECT DATABASE CONNECTION REFRESHED SUCCESSFULLY:', connectionId);
      } else {
        await db.insert(connection).values({
          id: connectionId,
          userId: account.userId,
          email: userInfo.address,
          createdAt: new Date(),
          ...credentials,
        });
        console.log('DIRECT DATABASE CONNECTION CREATED SUCCESSFULLY:', connectionId);
      }

      const result = { id: connectionId };
      
      if (env.NODE_ENV === 'production') {
        await Effect.runPromise(
          scheduleCampaign({ address: userInfo.address, name: userInfo.name || 'there' }),
        );
      }

      if (env.GOOGLE_S_ACCOUNT && env.GOOGLE_S_ACCOUNT !== '{}') {
        // Direct processing instead of queue (for free plan)
        await enableBrainFunction({
          id: result.id,
          providerId: account.providerId as EProviders,
        });
      }
      
      return result;
    } catch (directDbError) {
      console.error('Direct database approach failed:', directDbError);
      
      // If direct database fails, we're in trouble - RPC definitely won't work
      console.error('CRITICAL ERROR: Both direct database and RPC approaches failed');
      console.error('This indicates a fundamental issue with the system');
      
      // Try one last RPC attempt as absolute fallback
      console.log('Trying RPC as absolute last resort...');
      
      const [result] = await db.createConnection(
        account.providerId as EProviders,
        userInfo.address,
        account.userId,
        {
          accessToken: rpcConnectionData.accessToken,
          refreshToken: rpcConnectionData.refreshToken,
          scope: rpcConnectionData.scope,
          expiresAt: rpcConnectionData.expiresAt,
          name: rpcConnectionData.name,
          picture: rpcConnectionData.picture,
        }
      );
      
      console.log('RPC last resort connection created successfully:', result.id);
      
      if (env.NODE_ENV === 'production') {
        await Effect.runPromise(
          scheduleCampaign({ address: userInfo.address, name: userInfo.name || 'there' }),
        );
      }

      if (env.GOOGLE_S_ACCOUNT && env.GOOGLE_S_ACCOUNT !== '{}') {
        // Direct processing instead of queue (for free plan)
        await enableBrainFunction({
          id: result.id,
          providerId: account.providerId as EProviders,
        });
      }
      
      return result;
    }
  } catch (error) {
    console.error('Error creating connection:', error);
    console.error('Error details:', {
      message: (error as Error).message,
      stack: (error as Error).stack,
      sanitizedUpdatingInfo: {
        ...sanitizedUpdatingInfo,
        accessToken: sanitizedUpdatingInfo.accessToken ? 'SET' : 'NOT_SET',
        refreshToken: sanitizedUpdatingInfo.refreshToken ? 'SET' : 'NOT_SET',
        scope: sanitizedUpdatingInfo.scope || 'EMPTY',
        expiresAt: sanitizedUpdatingInfo.expiresAt,
      }
    });
    throw error;
    }
};

export const createAuth = () => {
  console.log('Creating auth configuration...');
  console.log('Environnment variables:', {
    NODE_ENV: env.NODE_ENV,
    VITE_PUBLIC_BACKEND_URL: env.VITE_PUBLIC_BACKEND_URL,
    COOKIE_DOMAIN: env.COOKIE_DOMAIN,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET ? 'SET' : 'NOT_SET',
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ? 'SET' : 'NOT_SET',
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ? 'SET' : 'NOT_SET',
  });
  
  // Initialize plugins without Dub analytics for now
  const plugins = [
    mcp({
      loginPage: env.VITE_PUBLIC_APP_URL + '/login',
    }),
    jwt(),
    bearer(),
  ];



  console.log('Creating better-auth instance...');
  return betterAuth({
    plugins,
    user: {
      deleteUser: {
        enabled: true,
        async sendDeleteAccountVerification(data) {
          const verificationUrl = data.url;

          await resend().emails.send({
            from: '0.email <no-reply@0.email>',
            to: data.user.email,
            subject: 'Delete your 0.email account',
            html: `
            <h2>Delete Your 0.email Account</h2>
            <p>Click the link below to delete your account:</p>
            <a href="${verificationUrl}">${verificationUrl}</a>
          `,
          });
        },
        beforeDelete: async (user, request) => {
          if (!request) throw new APIError('BAD_REQUEST', { message: 'Request object is missing' });
          const db = await getZeroDB(user.id);
          const connections = await db.findManyConnections();
          const context = getContext<HonoContext>();
          try {
            await context.var.autumn.customers.delete(user.id);
          } catch (error) {
            console.error('Failed to delete Autumn customer:', error);
            // Continue with deletion process despite Autumn failure
          }

          const revokedAccounts = (
            await Promise.allSettled(
              connections.map(async (connection) => {
                if (!connection.accessToken || !connection.refreshToken) return false;
                await disableBrainFunction({
                  id: connection.id,
                  providerId: connection.providerId as EProviders,
                });
                const driver = createDriver(connection.providerId, {
                  auth: {
                    accessToken: connection.accessToken,
                    refreshToken: connection.refreshToken,
                    userId: user.id,
                    email: connection.email,
                  },
                });
                const token = connection.refreshToken;
                return await driver.revokeToken(token || '');
              }),
            )
          ).map((result) => {
            if (result.status === 'fulfilled') {
              return result.value;
            }
            return false;
          });

          if (revokedAccounts.every((value) => !!value)) {
            console.log('Failed to revoke some accounts');
          }

          await db.deleteUser();
        },
      },
    },
    databaseHooks: {
      account: {
        create: {
          after: async (account: Account) => {
            console.log('Database hook: account create after triggered', { accountId: account.id, providerId: account.providerId });
            try {
              await connectionHandlerHook(account);
            } catch (error) {
              console.error('Error in connectionHandlerHook:', error);
              throw error;
            }
          },
        },
        update: {
          after: async (account: Account) => {
            console.log('Database hook: account update after triggered', { accountId: account.id, providerId: account.providerId });
            try {
              await connectionHandlerHook(account);
            } catch (error) {
              console.error('Error in connectionHandlerHook:', error);
              throw error;
            }
          },
        },
      },
    },
    emailAndPassword: {
      enabled: false,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        await resend().emails.send({
          from: '0.email <onboarding@0.email>',
          to: user.email,
          subject: 'Reset your password',
          html: `
            <h2>Reset Your Password</h2>
            <p>Click the link below to reset your password:</p>
            <a href="${url}">${url}</a>
            <p>If you didn't request this, you can safely ignore this email.</p>
          `,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: false,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, token }) => {
        const verificationUrl = `${env.VITE_PUBLIC_APP_URL}/api/auth/verify-email?token=${token}&callbackURL=/settings/connections`;

        await resend().emails.send({
          from: '0.email <onboarding@0.email>',
          to: user.email,
          subject: 'Verify your 0.email account',
          html: `
            <h2>Verify Your 0.email Account</h2>
            <p>Click the link below to verify your email:</p>
            <a href="${verificationUrl}">${verificationUrl}</a>
          `,
        });
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        // all hooks that run on sign-up routes
        if (ctx.path.startsWith('/sign-up')) {
          // only true if this request is from a new user
          const newSession = ctx.context.newSession;
          if (newSession) {
            // Check if user already has settings
            const db = await getZeroDB(newSession.user.id);
            const existingSettings = await db.findUserSettings();

            if (!existingSettings) {
              // get timezone from vercel's header
              const headerTimezone = ctx.headers?.get('x-vercel-ip-timezone');
              // validate timezone from header or fallback to browser timezone
              const timezone =
                headerTimezone && isValidTimezone(headerTimezone)
                  ? headerTimezone
                  : getBrowserTimezone();
              // write default settings against the user
              await db.insertUserSettings({
                ...defaultUserSettings,
                timezone,
              });
            }
          }
        }
      }),
      signIn: async (user: any, account: any) => {
        console.log('Sign-in hook triggered', { userId: user.id, accountId: account?.id, providerId: account?.providerId });
        
        // If this is an OAuth sign-in and we have an account, ensure connection exists
        if (account && account.providerId && account.accessToken && account.refreshToken) {
          try {
            console.log('Attempting to create connection for existing user via sign-in hook');
            await connectionHandlerHook(account);
          } catch (error) {
            console.error('Error creating connection via sign-in hook:', error);
            // Don't throw error to avoid breaking the sign-in process
          }
        }
      },
      beforeSignIn: async (user: any, account: any) => {
        console.log('Before sign-in hook triggered', { userId: user?.id, accountId: account?.id, providerId: account?.providerId });
      },
      afterSignIn: async (user: any, account: any) => {
        console.log('After sign-in hook triggered', { userId: user?.id, accountId: account?.id, providerId: account?.providerId });
      },
    },
    ...createAuthConfig(),
  });
};

const createAuthConfig = () => {
  console.log('Creating auth config...');
  const cache = redis();
  // Use D1 database instead of Hyperdrive for better-auth
  let db;
  try {
    console.log('Creating database connection...');
    const dbResult = createDb();
    db = dbResult.db;
    console.log('Database connection created successfully');
  } catch (error) {
    console.error('Error creating database connection:', error);
    throw new Error('Failed to initialize database connection');
  }
  
  // Clean the baseURL to remove any spaces
  const cleanBaseURL = env.VITE_PUBLIC_BACKEND_URL?.replace(/\s/g, '') || '';
  
  // Validate required environment variables
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error('BETTER_AUTH_SECRET is required');
  }
  
  if (!env.VITE_PUBLIC_BACKEND_URL) {
    throw new Error('VITE_PUBLIC_BACKEND_URL is required');
  }
  
  if (!env.COOKIE_DOMAIN) {
    throw new Error('COOKIE_DOMAIN is required');
  }
  
  return {
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    secondaryStorage: {
      get: async (key: string) => {
        const value = await cache.get(key);
        return typeof value === 'string' ? value : value ? JSON.stringify(value) : null;
      },
      set: async (key: string, value: string, ttl?: number) => {
        if (ttl) await cache.set(key, value, { ex: ttl });
        else await cache.set(key, value);
      },
      delete: async (key: string) => {
        await cache.del(key);
      },
    },
    advanced: {
      ipAddress: {
        disableIpTracking: true,
      },
      cookiePrefix: env.NODE_ENV === 'development' ? 'better-auth-dev' : 'better-auth',
      crossSubDomainCookies: {
        enabled: true,
        domain: env.COOKIE_DOMAIN,
      },
    },
    baseURL: cleanBaseURL,
    trustedOrigins: [
      'https://app.0.email',
      'https://sapi.0.email',
      'https://staging.0.email',
      'https://0.email',
      'https://zero.prabhatravib.workers.dev',
      'https://infflow.prabhatravib.workers.dev',
      'https://infflow-api-production.prabhatravib.workers.dev',
      'http://localhost:3000',
    ],
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60 * 60 * 24 * 30, // 30 days
      },
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24 * 3, // 1 day (every 1 day the session expiration is updated)
    },
    socialProviders: (() => {
      try {
        console.log('Configuring social providers...');
        const providers = getSocialProviders(env as unknown as Record<string, string>);
        console.log('Social providers configured:', Object.keys(providers));
        return providers;
      } catch (error) {
        console.error('Error configuring social providers:', error);
        throw error;
      }
    })(),
    account: {
      accountLinking: {
        enabled: true,
        allowDifferentEmails: true,
        trustedProviders: ['google', 'microsoft'],
      },
    },
    onAPIError: {
      onError: (error) => {
        console.error('API Error', error);
      },
      errorURL: `${env.VITE_PUBLIC_APP_URL}/login`,
      throw: true,
    },
  } satisfies BetterAuthOptions;
};

export const createSimpleAuth = () => {
  return betterAuth(createAuthConfig());
};

export type Auth = ReturnType<typeof createAuth>;
export type SimpleAuth = ReturnType<typeof createSimpleAuth>;
