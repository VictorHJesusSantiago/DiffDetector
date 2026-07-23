-- Estado inicial do schema, equivalente ao antigo src/db/schema.sql.
-- Bancos criados antes das migrações versionadas recebem esta versão como baseline (marcada
-- como aplicada sem reexecução), porque as tabelas já existem neles.

CREATE TABLE IF NOT EXISTS scans (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  code_dir TEXT NOT NULL,
  docs_dir TEXT NOT NULL,
  total_code_endpoints INT NOT NULL DEFAULT 0,
  total_doc_endpoints INT NOT NULL DEFAULT 0,
  total_code_env_vars INT NOT NULL DEFAULT 0,
  total_doc_env_vars INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS findings (
  id BIGSERIAL PRIMARY KEY,
  scan_id BIGINT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  doc_refs JSONB NOT NULL DEFAULT '[]',
  code_refs JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'aberto', -- aberto | resolvido
  first_seen_scan_id BIGINT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_findings_scan_id ON findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_subject ON findings(subject, type);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
