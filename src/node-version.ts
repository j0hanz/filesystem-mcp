// `engines` asks for Node.js 24, and CI tests only that line. Node.js 22 loads
// the server and a smoke run passes, but nothing tests it. Anything older fails
// while the modules link (`node:fs/promises` has no `glob` before 22), with an
// error that names neither the server nor the fix.
const SUPPORTED_MAJOR = 24;
const LOADABLE_MAJOR = 22;

interface NodeVersionVerdict {
  /** Why the server cannot start on this version; the entry exits with it. */
  readonly fatal?: string;
  /** Printed to stderr before the server starts anyway. */
  readonly warning?: string;
}

/** Judge `process.version` (for example `v20.20.0`) before any server module loads. */
export function checkNodeVersion(version: string): NodeVersionVerdict {
  const major = Number.parseInt(version.replace(/^v/u, ''), 10);
  // An unparseable version is not a reason to refuse a server that may run.
  if (Number.isNaN(major) || major >= SUPPORTED_MAJOR) return {};
  const supported = `Node.js ${String(SUPPORTED_MAJOR)} or later`;
  if (major < LOADABLE_MAJOR) {
    return {
      fatal: `filesystem-mcp needs ${supported}; this is Node.js ${version}. Install ${supported}, then start the server again.`,
    };
  }
  return {
    warning: `filesystem-mcp supports ${supported}; this is Node.js ${version}, which is not tested. If a tool fails, upgrade Node.js first.`,
  };
}
