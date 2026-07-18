/**
 * Bloqueia scripts que enviam ordem real sem --live explícito.
 * Exit 2 = recusa de segurança (não é falha de rede/API).
 */

export function hasLiveFlag(argv = process.argv) {
  return argv.slice(2).includes('--live');
}

/**
 * @param {string} command Nome do npm script / CLI (para mensagem)
 * @param {{ argv?: string[], hint?: string }} [opts]
 */
export function requireLiveFlag(command, opts = {}) {
  const argv = opts.argv ?? process.argv;
  if (hasLiveFlag(argv)) return;
  const hint = opts.hint ?? `npm run ${command} -- --live`;
  console.error(
    `[${command}] Recusa: este comando envia ordem real. Passe --live explicitamente.\n` +
      `  Exemplo: ${hint}\n` +
      `  Sem --live o default é dry-run / não operar.`,
  );
  process.exit(2);
}
