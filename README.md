# pi-pact

Pact improves Pi by retaining recent messages when compacting.

## Install

Install from npm:

```sh
pi install npm:pi-pact
```

Run temporarily without installing:

```sh
pi -e npm:pi-pact
```

## Configuration

Pact reads configuration in this order, with later values overriding earlier ones:

1. Built-in defaults
2. Global config: `~/.pi/agent/pact.json`
3. Trusted project config: `.pi/pact.json`
4. Environment variables
5. Session-local `/pact` commands

Example `pact.json`:

```json
{
  "enabled": true,
  "fraction": 0.8,
  "threshold": "160000",
  "debug": false,
  "debugFile": null
}
```

Settings:

- `enabled` — enable automatic Pact compaction, default `true`
- `fraction` — fraction of tool results to compact, default `0.8`
- `threshold` — token count or percentage like `60%`, default `160000`
- `debug` — enable context order notifications, default `false`
- `debugFile` — append debug records to the given JSONL file, default `null`

Environment variable overrides:

- `PACT_ENABLED=1|0|true|false`
- `PACT_FRACTION=0.8`
- `PACT_THRESHOLD=160000` or `PACT_THRESHOLD=60%`
- `PACT_DEBUG=1|0|true|false`
- `PACT_DEBUG_FILE=/tmp/pact.jsonl`

Slash command:

```text
/pact [on|off|toggle|status|stats|debug [on|off]|verify|now|fraction N|threshold N]
```

## Development

```sh
npm test
npm run check
npm pack --dry-run
```
