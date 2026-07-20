export function generatePreCommitHook(codeDir: string, docsDir: string): string {
  return `#!/bin/sh
# Gerado por doc-drift-detector (drift init-hook).
# Bloqueia o commit se houver drift entre código e documentação.
npx drift scan --code "${codeDir}" --docs "${docsDir}" --no-save --fail-on-drift
exit $?
`;
}
