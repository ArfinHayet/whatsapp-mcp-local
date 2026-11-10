CREATE TABLE chats (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  last_message_time INTEGER NOT NULL
);
CREATE TABLE contacts (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  push_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE messages (
  id TEXT NOT NULL,
  chat_jid TEXT NOT NULL REFERENCES chats(jid),
  sender TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  timestamp INTEGER NOT NULL,
  is_from_me INTEGER NOT NULL CHECK (is_from_me IN (0, 1)),
  media_type TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  direct_path TEXT NOT NULL DEFAULT '',
  media_key BLOB,
  file_sha256 BLOB,
  file_enc_sha256 BLOB,
  file_length INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, chat_jid)
);
CREATE INDEX messages_chat_time ON messages(chat_jid, timestamp DESC, id DESC);
CREATE INDEX messages_time ON messages(timestamp DESC, id DESC);
CREATE INDEX messages_sender ON messages(sender, timestamp DESC);
CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('send','send_file','send_audio','download')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','unknown','expired')),
  result_json TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER
);
CREATE INDEX commands_pending ON commands(created_at_ms, id) WHERE status = 'pending';
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('upload','whatsapp')),
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 20971520),
  created_at_ms INTEGER NOT NULL
);
