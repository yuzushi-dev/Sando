# sandoichi

Cuts what Claude Code and Codex charge you to re-read their own output. Redacts secrets, caps oversized tool results, and, if you turn it on, trims request history before it's sent — all without calling an LLM itself.

This is the core library (`@sando/core` renamed `sandoichi` for npm). For the Claude Code plugin, Codex plugin, and provider proxy, see the [main repo](https://github.com/yuzushi-dev/Sando).

## Install

```sh
npm install sandoichi
```

Requires Node.js `22.22.x`.

## Usage

```js
import { optimizeToolOutput, createProviderProxy } from 'sandoichi';
```

See [index.mjs](./index.mjs) for the full list of exports (tool-output optimization, provider request transforms, semantic compaction, metrics, status line rendering).

## License

MIT
