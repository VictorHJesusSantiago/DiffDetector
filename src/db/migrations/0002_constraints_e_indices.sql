-- Constraints de domínio e índices ajustados.
--
-- Estas CHECK não existiam em bancos criados pelo schema.sql original: `CREATE TABLE IF NOT
-- EXISTS` ignora silenciosamente qualquer alteração quando a tabela já existe, então elas
-- valiam apenas para instalações novas. Aqui são aplicadas também aos bancos já existentes.
--
-- `NOT VALID` faz o Postgres passar a exigir a constraint em novas linhas sem varrer a tabela
-- inteira (que exigiria ACCESS EXCLUSIVE por toda a varredura); o VALIDATE seguinte confere as
-- linhas antigas com um lock bem mais fraco. Em tabela vazia ou pequena a diferença é nula, mas
-- o padrão é o correto para quando o histórico crescer.

ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_status_valido;
ALTER TABLE findings ADD CONSTRAINT findings_status_valido
  CHECK (status IN ('aberto', 'resolvido')) NOT VALID;
ALTER TABLE findings VALIDATE CONSTRAINT findings_status_valido;

ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_severidade_valida;
ALTER TABLE findings ADD CONSTRAINT findings_severidade_valida
  CHECK (severity IN ('alta', 'media', 'baixa')) NOT VALID;
ALTER TABLE findings VALIDATE CONSTRAINT findings_severidade_valida;

-- Consulta quente da reconciliação: "achados abertos do scan anterior".
CREATE INDEX IF NOT EXISTS idx_findings_scan_status ON findings(scan_id, status);
-- Rastreia desde quando um drift está aberto e sustenta o ON DELETE CASCADE dessa FK.
CREATE INDEX IF NOT EXISTS idx_findings_first_seen_scan ON findings(first_seen_scan_id);

-- Substituídos pelo composto (scan_id, status), que os cobre como prefixo.
DROP INDEX IF EXISTS idx_findings_scan_id;
DROP INDEX IF EXISTS idx_findings_status;
