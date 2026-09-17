// Facade for the transport layer, preserving the package's `./transport`
// export. The hosting itself lives in `transport/stdio.ts` (pinned-instance
// stdio serving) and `transport/http.ts` (per-request HTTP hosting);
// `transport/shared.ts` holds the pieces both legs gate on.
export { startServer } from './transport/stdio.ts';
export { startHttpServer } from './transport/http.ts';
