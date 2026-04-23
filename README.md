<img src="https://raw.githubusercontent.com/M0H4M3D-D3V/agwatch-cli/main/images/cover.png" alt="agwatch cover" width="1200" />

<img src="https://raw.githubusercontent.com/M0H4M3D-D3V/agwatch-cli/main/images/screenshot.png" alt="agwatch dashboard" width="1200" />

`agwatch` is a terminal analytics CLI for AI coding workflows. It reads local usage data from supported agents, normalizes it into a shared event model, and renders that data as an interactive dashboard or structured summary output.

It is built to answer practical questions such as:

- How much did each agent, model, project, or activity cost?
- Which tools and shell commands were used most?
- How many input, output, cached, and written tokens were consumed?
- Which provider usage windows are close to their limits?

## What It Shows

`agwatch` organizes usage into panels so you can inspect both totals and breakdowns quickly.

### Agent Analytics

Across enabled agents, the dashboard and summary can show:

- Total cost
- Total calls
- Session count
- Cache hit rate
- Input, output, cached, and written token counts
- Daily activity trends
- Usage by project
- Usage by activity type
- Usage by model
- Tool call frequency
- Shell command frequency
- MCP server usage

### Agent Organization

Data is grouped in two ways:

- `All Agents` aggregates usage from every enabled agent
- Per-agent tabs show isolated usage for each configured agent

The default config currently supports:

- `OpenCode` via SQLite or JSON-based local data
- `Claude Code` via local JSONL project logs

### Provider Panel

The dashboard also includes a provider usage panel for configured providers.

For each provider, `agwatch` shows:

- Provider name
- Data source: `api` or `browser-fallback`
- Scrape time
- Current `5h` usage percentage
- `5h` reset time/date
- Current weekly usage percentage
- Weekly reset time/date
- Current monthly usage percentage (when available)
- Monthly reset time/date (when available)
- Provider-specific error state when usage could not be fetched

Supported providers currently include:

- `OpenAI`
- `Anthropic`
- `Z.AI`
- `OpenCode Go`

## Installation

### Requirements

- Node.js `18+`
- Access to local agent data files

### Global Install

```bash
npm install -g agwatch-cli
```

### Run Without Installing Globally

```bash
npx agwatch-cli dashboard
```

## Quick Start

```bash
agwatch
agwatch dashboard
agwatch summary
agwatch summary --range today --json
```

## Commands

### `dashboard`

Launch the interactive terminal dashboard.

```bash
agwatch
agwatch dashboard
agwatch dashboard --range today
agwatch dashboard --range 30d
agwatch dashboard --watch
```

`agwatch` and `agwatch dashboard` do the same thing. If no subcommand is provided, the CLI starts the interactive dashboard by default.

### `summary`

Print a non-interactive usage report.

```bash
agwatch summary
agwatch summary --range 7d
agwatch summary --from 2026-04-01 --to 2026-04-20
agwatch summary --json
```

## CLI Flags

### Shared Time Range Flags

| Flag | Values | Description |
|---|---|---|
| `--range` | `today`, `7d`, `30d`, `month` | Preset reporting range |
| `--from` | `YYYY-MM-DD` | Custom start date for `summary` |
| `--to` | `YYYY-MM-DD` | Custom end date for `summary` |

### Summary Flags

| Flag | Description |
|---|---|
| `--json` | Emit structured JSON instead of text |

### Dashboard Flags

| Flag | Description |
|---|---|
| `--watch` | Auto-refresh usage data every 3 seconds |
| `--provider-debug` | Enable provider debug logging in non-interactive contexts |
| `--provider-startup-timeout-ms <ms>` | Timeout for background provider loading during startup |
| `--provider-manual-timeout-ms <ms>` | Timeout for manual provider refresh actions |
| `--provider-fallback <mode>` | Browser fallback policy: `never`, `on_auth_error`, `on_any_error` |

### Provider Runtime Defaults

| Option | Default |
|---|---|
| `provider debug` | `false` |
| `startup timeout` | `25000` ms |
| `manual timeout` | `35000` ms |
| `fallback mode` | `on_auth_error` |

## Dashboard Keybindings

| Key | Action |
|---|---|
| `q` | Quit |
| `1-4` | Switch time period |
| `↑` `↓` | Cycle periods |
| `←` `→` | Switch agent tabs |
| `u` | Refresh usage data |
| `r` | Refresh pricing data |
| `v` | Refresh provider usage |
| `a` | Refresh all data |
| `p` | Open provider setup menu |

## Dashboard Panels

| Panel | What it shows |
|---|---|
| `Overview` | Total cost, calls, sessions, cache hit rate, and token totals |
| `Providers` | Provider usage percentages, reset windows (5h, weekly, monthly when available), scrape source, and provider errors |
| `By Project` | Cost, tokens, and sessions grouped by project |
| `By Model` | Cost, tokens, and calls grouped by model |
| `By Activity` | Cost and calls grouped by inferred workflow type such as coding, debugging, or testing |
| `Daily Activity` | Per-day cost, tokens, and calls |
| `Core Tools` | Tool usage frequency |
| `Shell Commands` | Shell command frequency |
| `MCP Servers` | MCP server usage frequency |

Progress bars are relative to the highest row in each panel.

<img src="https://raw.githubusercontent.com/M0H4M3D-D3V/agwatch-cli/main/images/preview.png" alt="agwatch dashboard preview" width="1200" />

## Configuration

Configuration is stored in:

```text
~/.config/agwatch/config.json
```

On first run, `agwatch` creates this file automatically.

### Example Config

```json
{
  "agents": [
    {
      "id": "opencode",
      "label": "OpenCode",
      "enabled": true,
      "type": "sqlite",
      "paths": [
        "~/.local/share/opencode/opencode.db",
        "~/.opencode/opencode.db",
        "~/.config/opencode/opencode.db"
      ]
    },
    {
      "id": "claude",
      "label": "Claude Code",
      "enabled": true,
      "type": "jsonl",
      "paths": [
        "~/.claude/projects"
      ]
    }
  ],
  "providers": []
}
```

### Agent Fields

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Stable internal identifier |
| `label` | `string` | Display name used in tabs and UI |
| `enabled` | `boolean` | Whether the agent is included in aggregation |
| `type` | `sqlite` \| `json` \| `jsonl` | Local storage format |
| `paths` | `string[]` | Candidate paths to search for agent data |

### Provider Fields

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Provider identifier |
| `label` | `string` | Display name |
| `enabled` | `boolean` | Whether provider scraping is enabled |

## Provider Setup

Provider configuration is handled from inside the dashboard.

1. Open the dashboard.
2. Press `p` to open the provider menu.
3. Choose a supported provider.
4. Authenticate in the browser flow.
5. Return to the dashboard to view provider usage.

If browser automation dependencies are missing, `agwatch` prompts to install them during setup.

## Provider Session Security

When you authenticate a provider, `agwatch` captures the browser session cookies needed to fetch your usage data and stores them locally so you are not prompted to log in on every run.

### What is stored

Only authentication-relevant cookies are saved — session tokens, auth tokens, and `httpOnly` server-set cookies. Analytics, tracking, and other non-auth cookies are discarded before the file is written.

### Encryption

Stored cookies are encrypted at rest using **AES-256-GCM**.

The encryption key is derived per-provider using **HKDF-SHA256** keyed from a stable machine-bound identifier:

| Platform | Machine identifier |
|---|---|
| Windows | `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` |
| macOS | `IOPlatformSerialNumber` via `ioreg` |
| Linux | `/etc/machine-id` or `/var/lib/dbus/machine-id` |

This means a cookie file copied off your machine cannot be decrypted without the source machine's identifier.

### File permissions

Cookie files are written with owner-only access:

| Platform | Enforcement |
|---|---|
| macOS / Linux | `chmod 0600` at write time |
| Windows | `icacls` removes inherited ACLs and grants full control only to the current user |

### Storage location

```text
~/.config/agwatch/provider-cookies/<provider-id>.json
```

### Expiry

Cookies with past expiry timestamps are filtered out automatically on every load. If all stored cookies for a provider have expired, the file is deleted and you are prompted to re-authenticate.

### Linux note

On Linux, `agwatch` will display a security notice if `libsecret` is not installed. `libsecret` is required for OS-keychain-backed key storage via `keytar`. Without it, the machine-ID derivation described above is used as a fallback.

Install `libsecret` for your distribution:

| Distribution | Command |
|---|---|
| Debian / Ubuntu | `sudo apt-get install libsecret-1-dev` |
| Red Hat / Fedora / CentOS | `sudo yum install libsecret-devel` |
| Arch Linux | `sudo pacman -S libsecret` |
| Alpine Linux | `sudo apk add libsecret-dev` |

## Pricing

Model pricing is fetched from the LiteLLM pricing database and cached locally.

- Source: `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
- Cache file: `~/.config/agwatch/pricing-cache.json`
- Cache TTL: `24 hours`

Behavior:

1. `agwatch` uses cached prices when the cache is still fresh.
2. It fetches fresh prices when the cache is stale.
3. If fetching fails, it falls back to the last cached pricing.
4. If no pricing is available, unknown costs resolve to `$0`.
5. If a source record already contains a non-zero cost, that stored cost is used.

## Summary Output

<img src="https://raw.githubusercontent.com/M0H4M3D-D3V/agwatch-cli/main/images/usage.png" alt="agwatch usage summary preview" width="1200" />

### Text Output

The text summary includes:

- Summary totals
- Top models
- Top projects
- Daily activity
- Activity breakdown

### JSON Output

`agwatch summary --json` returns:

- `metadata`
- `summary`
- `panels.dailyActivity`
- `panels.byProject`
- `panels.byActivity`
- `panels.byModel`
- `panels.tools`
- `panels.shellCommands`
- `panels.mcpServers`

## Data Sources

`agwatch` reads local agent data and converts it into a shared usage event model.

### OpenCode

Reads session, message, and tool-call data from local OpenCode storage.

- SQLite is preferred when available
- Fallback SQLite reading is supported
- JSON-based fallback reading is supported

### Claude Code

Reads local JSONL project logs from the Claude Code projects directory.

## Architecture

```text
Data Layer -> Domain Layer -> Aggregation Layer -> Presentation Layer
```

```text
src/
  cli/          command dispatch and argument parsing
  adapters/     agent-specific readers for OpenCode and Claude Code
  domain/       shared types and normalization
  services/     loading, aggregation, pricing, and provider services
  tui/          Ink-based dashboard UI
  output/       text and JSON summary renderers
  config/       config loading and time ranges
  utils/        formatting, grouping, dates, and error handling
```

## Tech Stack

- TypeScript
- Node.js
- Ink
- React
- Commander
- better-sqlite3
- sql.js
- dayjs
- zod

## Development

### Install Dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

### Watch Mode

```bash
npm run dev
```

### Type Check

```bash
npm run typecheck
```

You can also run:

```bash
npm run lint
```

### Run Locally

```bash
npm start
node dist/cli/index.js dashboard --range today
node dist/cli/index.js summary --range 7d
```

## Notes

- No test runner is configured yet.
- The package exposes the `agwatch` binary from `dist/cli/index.js`.
- Required Node.js version is `18+`.

## License

ISC
