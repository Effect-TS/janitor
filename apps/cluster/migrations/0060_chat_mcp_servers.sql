-- The MCP servers chat turns can use, configured on the dashboard (EFF-3443).
-- No secret is stored here: bearer tokens and OAuth state stay in each
-- server's credential Durable Object, named by the server's id.
CREATE TABLE chat_mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9_]{1,32}$'),
  url TEXT NOT NULL CHECK (url LIKE 'https://%'),
  auth TEXT NOT NULL CHECK (auth IN ('none', 'bearer', 'oauth')),
  private BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);
