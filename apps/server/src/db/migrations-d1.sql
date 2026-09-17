-- D1 Database Migration for Zero Email
-- This creates all necessary tables for the email application

-- Users table
CREATE TABLE IF NOT EXISTS mail0_user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  default_connection_id TEXT,
  custom_prompt TEXT,
  phone_number TEXT UNIQUE,
  phone_number_verified INTEGER DEFAULT 0
);

-- Sessions table
CREATE TABLE IF NOT EXISTS mail0_session (
  id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  userId TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES mail0_user(id) ON DELETE CASCADE
);

-- Accounts table
CREATE TABLE IF NOT EXISTS mail0_account (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  userId TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (userId) REFERENCES mail0_user(id) ON DELETE CASCADE
);

-- Connections table
CREATE TABLE IF NOT EXISTS mail0_connection (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  email TEXT NOT NULL,
  userId TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  access_token TEXT,
  refresh_token TEXT,
  scope TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (userId) REFERENCES mail0_user(id) ON DELETE CASCADE
);

-- User settings table
CREATE TABLE IF NOT EXISTS mail0_user_settings (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL,
  settings TEXT NOT NULL, -- JSON blob
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (userId) REFERENCES mail0_user(id) ON DELETE CASCADE
);

-- User hotkeys table
CREATE TABLE IF NOT EXISTS mail0_user_hotkeys (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL,
  shortcuts TEXT NOT NULL, -- JSON blob
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (userId) REFERENCES mail0_user(id) ON DELETE CASCADE
);

-- Notes table
CREATE TABLE IF NOT EXISTS mail0_note (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  content TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  is_pinned INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (userId) REFERENCES mail0_user(id) ON DELETE CASCADE
);

-- Writing style matrix table
CREATE TABLE IF NOT EXISTS mail0_writing_style_matrix (
  connection_id TEXT PRIMARY KEY NOT NULL,
  num_messages INTEGER NOT NULL,
  style TEXT NOT NULL, -- JSON blob
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES mail0_connection(id) ON DELETE CASCADE
);

-- Summary table
CREATE TABLE IF NOT EXISTS mail0_summary (
  message_id TEXT PRIMARY KEY NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  saved INTEGER DEFAULT 0,
  tags TEXT,
  suggested_reply TEXT,
  FOREIGN KEY (connection_id) REFERENCES mail0_connection(id) ON DELETE CASCADE
);

-- Verification table
CREATE TABLE IF NOT EXISTS mail0_verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);

-- JWKS table
CREATE TABLE IF NOT EXISTS mail0_jwks (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Early access table
CREATE TABLE IF NOT EXISTS mail0_early_access (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  is_early_access INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- OAuth application table
CREATE TABLE IF NOT EXISTS mail0_oauth_application (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  scopes TEXT NOT NULL,
  disabled INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES mail0_user(id) ON DELETE CASCADE
);

-- OAuth access token table
CREATE TABLE IF NOT EXISTS mail0_oauth_access_token (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  access_token_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES mail0_user(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES mail0_oauth_application(client_id) ON DELETE CASCADE
);

-- OAuth consent table
CREATE TABLE IF NOT EXISTS mail0_oauth_consent (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  consent_given INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES mail0_user(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES mail0_oauth_application(client_id) ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_user_email ON mail0_user(email);
CREATE INDEX IF NOT EXISTS idx_session_user_id ON mail0_session(userId);
CREATE INDEX IF NOT EXISTS idx_session_token ON mail0_session(token);
CREATE INDEX IF NOT EXISTS idx_session_expires_at ON mail0_session(expires_at);
CREATE INDEX IF NOT EXISTS idx_account_user_id ON mail0_account(userId);
CREATE INDEX IF NOT EXISTS idx_account_provider_user_id ON mail0_account(provider_id, userId);
CREATE INDEX IF NOT EXISTS idx_account_expires_at ON mail0_account(access_token_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS connection_user_id_email_unique ON mail0_connection(userId, email);
CREATE INDEX IF NOT EXISTS idx_connection_user_id ON mail0_connection(userId);
CREATE INDEX IF NOT EXISTS idx_connection_email ON mail0_connection(email);
CREATE INDEX IF NOT EXISTS idx_connection_expires_at ON mail0_connection(expires_at);
CREATE INDEX IF NOT EXISTS idx_connection_provider_id ON mail0_connection(provider_id);
CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON mail0_user_settings(userId);
CREATE INDEX IF NOT EXISTS idx_user_hotkeys_user_id ON mail0_user_hotkeys(userId);
CREATE INDEX IF NOT EXISTS idx_note_user_id ON mail0_note(userId);
CREATE INDEX IF NOT EXISTS idx_note_thread_id ON mail0_note(thread_id);
CREATE INDEX IF NOT EXISTS idx_note_user_thread ON mail0_note(userId, thread_id);
CREATE INDEX IF NOT EXISTS idx_note_is_pinned ON mail0_note(is_pinned);
CREATE INDEX IF NOT EXISTS idx_writing_style_matrix_connection_id ON mail0_writing_style_matrix(connection_id);
CREATE INDEX IF NOT EXISTS idx_summary_connection_id ON mail0_summary(connection_id);
CREATE INDEX IF NOT EXISTS idx_summary_saved ON mail0_summary(saved);
CREATE INDEX IF NOT EXISTS idx_verification_identifier ON mail0_verification(identifier);
CREATE INDEX IF NOT EXISTS idx_verification_expires_at ON mail0_verification(expires_at);
CREATE INDEX IF NOT EXISTS idx_jwks_created_at ON mail0_jwks(created_at);
CREATE INDEX IF NOT EXISTS idx_early_access_email ON mail0_early_access(email);
CREATE INDEX IF NOT EXISTS idx_early_access_is_early_access ON mail0_early_access(is_early_access);
CREATE INDEX IF NOT EXISTS idx_oauth_application_user_id ON mail0_oauth_application(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_application_client_id ON mail0_oauth_application(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_application_disabled ON mail0_oauth_application(disabled);
CREATE INDEX IF NOT EXISTS idx_oauth_access_token_user_id ON mail0_oauth_access_token(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_token_client_id ON mail0_oauth_access_token(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_token_expires_at ON mail0_oauth_access_token(access_token_expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_consent_user_id ON mail0_oauth_consent(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_consent_client_id ON mail0_oauth_consent(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_consent_given ON mail0_oauth_consent(consent_given); 