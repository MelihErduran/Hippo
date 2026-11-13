// node:sqlite prints an ExperimentalWarning on load. It is harmless, and it
// would land in every terminal greeting, so filter just that one warning.
// This module must be imported before anything that opens the database.
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (/SQLite is an experimental feature/i.test(msg)) return;
  return (original as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
