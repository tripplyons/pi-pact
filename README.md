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
5. Persisted session-local setting commands such as `/pact:on` and `/pact:fraction`

Example `pact.json`:

```json
{
  "enabled": true,
  "fraction": "80%",
  "threshold": "60%",
  "debug": false,
  "debugFile": null
}
```

Settings:

- `enabled` — enable automatic Pact compaction, default `true`
- `fraction` — fraction or percentage of eligible tool results to remove from live context by summarizing, default `80%`
- `threshold` — token count or percentage like `60%`, default `60%`
- `debug` — enable context order notifications, default `false`
- `debugFile` — append debug records to the given JSONL file, default `null`

Environment variable overrides:

- `PACT_ENABLED=1|0|true|false`
- `PACT_FRACTION=80%` or `PACT_FRACTION=0.8`
- `PACT_THRESHOLD=60%` or `PACT_THRESHOLD=160000`
- `PACT_DEBUG=1|0|true|false`
- `PACT_DEBUG_FILE=/tmp/pact.jsonl`

Slash commands persist their session-local settings when you close and resume the same saved Pi session.

Slash commands:

```text
/pact                  manually trigger compaction
/pact:on               enable automatic Pact compaction
/pact:off              disable automatic Pact compaction
/pact:toggle           toggle automatic Pact compaction
/pact:status           show current Pact settings
/pact:stats            show Pact compaction stats
/pact:debug [on|off]   toggle or set context-order debug notifications
/pact:verify           verify compaction summary ordering
/pact:fraction N       set the fraction of eligible tool results to remove from live context
/pact:threshold N      set the token count or percent threshold
```

## Development

```sh
npm test
npm run check
npm pack --dry-run
```
