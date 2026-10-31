# Private Strava MCP connection to ChatGPT

Connect ChatGPT to the existing Strava MCP gateway route through an outbound OpenAI Secure MCP Tunnel. The host Mac must be logged in, awake, and online. Use the `private-chatgpt-mcp` skill for the reusable setup procedure and templates, and consult the current [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Host setup

1. Run `npm ci`, `npm run check`, and `npm test` before publishing server changes. The supported built entrypoint is `node dist/server.js`.
2. Verify the existing gateway's Strava route with MCP `tools/list`. The current server exposes 16 tools. Keep the gateway's launcher and environment intact; the server loads the package's `.env` itself.
3. Create a dedicated Strava tunnel associated with the intended personal Platform organization and ChatGPT workspace. Never reuse another server's tunnel ID.
4. Install the current official `tunnel-client` in a private Strava-specific directory after verifying the release archive's SHA-256. Preserve other servers' binaries and services.
5. Configure `mcp.server_urls` with one `main` channel pointing at the host's loopback gateway Strava MCP URL. Do not add a stdio command or launch a second Strava server.
6. Reference an authorized runtime key using `control_plane.api_key: file:<absolute-key-file>`. Keep keys out of profiles, plists, command arguments, logs, and Git. A shared runtime key is suitable only if it has access to this new tunnel.
7. Run `tunnel-client doctor --profile-dir <private-directory> --profile <profile> --explain`. Install a distinct user LaunchAgent with RunAtLoad, KeepAlive, private logs, and the required PATH. Start only that new agent; a transport-only setup does not require a gateway restart.
8. Confirm the agent is running and the client is healthy, ready, and polling successfully. Use `tunnel-client health --url-file <health-url-file> --require-control-plane-poll --json`. Health alone does not prove ChatGPT tool execution.

Keep directories at mode `0700` and private configuration and record files at `0600`. Inspect diagnostics selectively; full profiles, environments, and `launchctl` output may contain secrets.

## ChatGPT installation and acceptance

In [ChatGPT Plugins](https://chatgpt.com/plugins), add a custom MCP server named **Strava MCP**, choose **Tunnel**, and select the dedicated Strava tunnel. Use **No authentication** for this private MCP connection; Strava OAuth remains local to the host. Complete both creation and Connect/install.

Verify **Installed** and **Connected**, then compare the discovered tool names with the gateway's inventory. There should be 16 tools: 14 annotated as reads, plus `strava_sync_activities` and `strava_export_activities`, which write local cache/export data. No tool writes to the Strava API. Transport setup adds no artifact, workflow, or checker tools.

Before every verification prompt, explicitly select **Medium** thinking effort and verify the selection. In a fresh chat with Strava MCP selected, call `strava_rate_limit_status` or `strava_athlete_profile` through the plugin itself. A local MCP call is a separate test path. Do not report the installation complete until this direct plugin call succeeds.

## Credentials, records, and maintenance

The gateway retains the host's existing Strava credentials. Rotating tokens normally live in `STRAVA_DATA_DIR/auth.json`, with `STRAVA_DATA_DIR` defaulting to `~/.config/strava-mcp`; `STRAVA_TOKEN_FILE` overrides the credential cache path. Preserve these settings and never copy token files between machines for tunnel setup. Token-refresh locking coordinates processes sharing one token file on one host; it does not coordinate independent token files across Macs.

Keep installation IDs, machine-specific paths, credential references, release checksums, screenshots, and verification history under the host's private `STRAVA_DATA_DIR/artifacts/installation/`, outside Git. Never store literal keys or Strava tokens in the record. Calls through ChatGPT use the tunnel host's Strava identity and local data.

After server interface changes, run the required checks, rebuild, and update only the affected gateway child through the gateway's supported lifecycle controls. Check for active work before any gateway restart. Refresh ChatGPT's discovered tools and repeat the direct plugin test. Documentation or optional skill-package changes do not require a gateway restart.

The `strava-segment-advisor` skill and branding are optional, separate plugin-package updates. Uploaded skills are snapshots and must be uploaded again after source changes.

To stop the tunnel, boot out only its LaunchAgent. Keep its profile and private record for recovery; removing the ChatGPT plugin or deleting the Platform tunnel is a separate action.
