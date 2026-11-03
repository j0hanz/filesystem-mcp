# Privacy policy

Filesystem MCP runs on your own computer. It has no account, no telemetry, and
no analytics, and it does not send your files or any data about you to the
maintainer or to anyone else.

## What it touches

- **Your files.** The server reads and writes files only in the folders you
  allow. What it reads goes to the AI client you connected it to, and from
  there to whichever AI provider that client uses. That provider's privacy
  policy covers what happens next.
- **The network.** Over stdio the server starts no network connections of its
  own. In HTTP mode it listens for the clients you point at it and starts no
  outbound connections of its own. On Windows, `SECURITY.md` names the paths
  that make the OS contact a host.
- **Installing.** `npx`, Docker, and the MCPB bundle download the package from
  npm, GitHub Container Registry, or GitHub Releases. Those services see the
  download request, under their own privacy policies.

## Contact

Questions go to
[GitHub Issues](https://github.com/j0hanz/filesystem-mcp/issues). Report
security problems privately as described in [SECURITY.md](SECURITY.md).
