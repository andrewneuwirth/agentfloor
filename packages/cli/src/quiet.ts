/**
 * Imported FIRST by the CLI entry so it runs before any dependency loads.
 * Silences exactly one piece of noise: the punycode deprecation (DEP0040)
 * that a transitive dependency triggers on every command. Every other
 * warning still prints — we only mute what we can't fix and users can't
 * act on.
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const code = typeof args[0] === "object" && args[0] !== null ? (args[0] as { code?: string }).code : (args[1] as string | undefined);
  if (code === "DEP0040") return;
  if (typeof warning !== "string" && (warning as { code?: string }).code === "DEP0040") return;
  original(warning as string, ...(args as [never]));
}) as typeof process.emitWarning;

export {};
