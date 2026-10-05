// Durable Object RPC only preserves an Error's message, so the HTTP status rides inside it.
const SEP = "\u001f";

export function fail(status: number, message: string): never {
  throw new Error(`${status}${SEP}${message}`);
}

export function parseError(err: unknown): { status: number; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const i = msg.indexOf(SEP);
  if (i > 0 && i <= 3) {
    const status = Number(msg.slice(0, i));
    if (status >= 400 && status < 600) return { status, message: msg.slice(i + 1) };
  }
  return { status: 500, message: msg };
}
