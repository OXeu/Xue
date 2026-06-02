<h1 align="center">Xue</h1>
<p align="center"><b>A QQ group and private chat agent with context memory and image understanding</b><br>Listens through OneBot, maintains conversation context, and decides whether to reply based on prompts, session config, and probability rules.</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun">
  <img src="https://img.shields.io/badge/language-TypeScript-blue?logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/protocol-OneBot-green" alt="OneBot">
  <img src="https://img.shields.io/badge/status-private-lightgrey" alt="Private">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#features">Features</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#development">Development</a>
</p>

---

> A useful group chat agent needs more than a reply button. It has to know when to stay quiet, when to gather more context, and when an image needs to be inspected before the next message. Xue keeps message collection, context building, reply decisions, and model calls separate so each step can be simulated, replayed, and tested.

## Install

### Requirements

- Bun
- A OneBot forward WebSocket gateway
- An OpenAI-compatible text model API
- An OpenAI-compatible vision model API for image understanding

### From Source

```bash
bun install
cp .env.example .env
```

Edit `.env` with your OneBot connection, bot identity, and model settings.

## Quickstart

### Collect Context

Start the listener first so Xue can record group/private messages and cache images asynchronously.

```bash
bun run listen
```

Runtime data is written to:

- `data/prod/raw/`: message JSONL files
- `data/prod/images/`: cached images

### Evaluate Prompts

After editing prompts, use simulation first. It does not call the LLM.

```bash
bun run simulate
```

To inspect real model output, replay recent history through the LLM.

```bash
LLM_API_KEY=sk-xxx bun run replay
```

### Run Agent

Run in the foreground for debugging:

```bash
bun run agent
```

Run in the background:

```bash
bun run start-agent
bun run status-agent
```

By default, `DRY_RUN=true`. Sessions that are not explicitly enabled in `config/session-config.json` only log dry-run replies. Once behavior is stable, set `reply: true` per session or set `DRY_RUN=false` globally.

## Features

### Context-Aware Replying

Xue extracts session-level conversation signals from recent history and injects lightweight style guidance into the prompt, including group tone, message length, filler words, and question ratio. The goal is to answer in context instead of producing detached summaries.

### Reply Decision Policy

Outside direct mentions, Xue uses probability gates to reduce unwanted interruptions and noisy replies.

| Scenario | Default probability | Behavior |
|----------|---------------------|----------|
| Mentioned directly / @all | `1.0` | Always reply |
| Bot name mentioned | `0.7` | Usually reply |
| Image-only / emoji-only message | `0.1` | Low probability |
| Bystander case (@someone else) | `0.05` | Very low probability |
| Other messages | `0.3` | Controlled by `REPLY_CHANCE` or session config |

### Vision Loop

When a message includes an image, the agent can call `describe_image` with the image pHash and a specific question instead of relying on a fixed "describe this image in one sentence" prompt.

```json
{ "id": "abcdef1234567890", "question": "How many people are in this image?" }
```

The system validates the image ID, calls the vision model, and appends the answer back into the model context. The agent can ask follow-up vision questions or send a final reply.

- Up to 5 vision Q&A turns per agent turn
- Failed vision calls inject a failure placeholder
- Replay can reuse cached image descriptions to avoid repeated cost

### Image Cache

Image download and caching are shared by `src/image-download.ts` and `src/image-cache.ts`. `src/phash.ts` uses dHash for near-duplicate image detection across different resolutions, with a default threshold of `3`.

### Prompt Surface

Reply constraints live in `prompts/reply.md` and are injected as a system prompt for each reply. The main constraints are:

- Keep replies short and infrequent
- Avoid repeating the user's wording
- Avoid summaries or guesses that drift away from context
- Stay conservative when context is unclear
- Use vision before replying to image messages when needed

## Configuration

### Environment

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_API_KEY` | LLM API key | - |
| `LLM_BASE_URL` | Text model API base URL | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | Text model | `deepseek-v4-flash` |
| `VISION_MODEL` | Vision model | `gemma4:26b` |
| `VISION_BASE_URL` | Vision model API base URL | `http://127.0.0.1:11444/v1` |
| `ONEBOT_WS_URL` | OneBot forward WebSocket gateway | `ws://localhost:6700` |
| `ONEBOT_ACCESS_TOKEN` | OneBot access token | - |
| `BOT_NAME` | Bot display name | `Rin` |
| `BOT_QQ` | Bot QQ number | `3042160393` |
| `DRY_RUN` | Simulate without sending messages | `true` |

### Session Config

`config/session-config.json` controls reply behavior per session. The file is ignored by Git and is intended for local private settings.

```json
{
  "probabilities": {
    "mentioned": 0.7,
    "media": 0.1,
    "bystander": 0.05
  },
  "group_A": {
    "reply": true,
    "probabilities": {
      "mentioned": 0.5,
      "media": 0.05,
      "bystander": 0.02
    },
    "replyChance": 0.2
  },
  "group_B": {
    "reply": false
  }
}
```

Precedence:

```text
Sessions with probabilities -> session probabilities, omitted fields use code defaults
Sessions without probabilities -> global probabilities -> code defaults (0.7 / 0.1 / 0.05)
Session replyChance -> REPLY_CHANCE -> 0.3
DRY_RUN=false       -> all sessions send real replies
DRY_RUN=true        -> only sessions with reply=true send real replies
```

Fields:

| Path | Type | Description |
|------|------|-------------|
| `probabilities` | `object` | Global default reply probabilities |
| `probabilities.mentioned` | `number` | Reply probability when the bot name is mentioned |
| `probabilities.media` | `number` | Reply probability for image-only or emoji-only messages |
| `probabilities.bystander` | `number` | Reply probability when the message mentions someone else |
| `{session_id}.reply` | `boolean` | Per-session real reply switch |
| `{session_id}.probabilities` | `object` | Per-session probability override |
| `{session_id}.replyChance` | `number` | Per-session probability for the random branch |

## Commands

| Command | Description |
|---------|-------------|
| `bun run listen` | Run the listener in the foreground |
| `bun run agent` | Run the agent in the foreground |
| `bun run simulate` | Replay without calling the LLM |
| `bun run replay` | Replay history and call the LLM |
| `bun run start` | Start the listener in the background |
| `bun run stop` | Stop the listener |
| `bun run status` | Check listener status |
| `bun run start-agent` | Start the agent in the background |
| `bun run stop-agent` | Stop the agent |
| `bun run status-agent` | Check agent status |
| `bun test` | Run tests |
| `bun run typecheck` | Run TypeScript type checking |

## Development

### Project Layout

```text
Xue/
├── config/
│   └── session-config.json
├── prompts/
│   ├── reply.md
│   ├── silence.md
│   ├── system.md
│   └── vision.md
├── scripts/
│   ├── start-agent.sh
│   ├── start-listen.sh
│   ├── status-agent.sh
│   ├── status-listen.sh
│   ├── stop-agent.sh
│   └── stop-listen.sh
├── src/
│   ├── agent/          # Context, decisions, OneBot sending, vision loop
│   ├── listen/         # OneBot listener and async image caching
│   ├── shared/         # Shared events and types
│   ├── chat-utils.ts   # Shared replay/agent helpers
│   ├── image-cache.ts  # Image cache
│   ├── image-download.ts
│   ├── phash.ts
│   ├── replay.ts
│   └── simulate.ts
├── tests/
├── .env.example
├── package.json
└── tsconfig.json
```

### Test

```bash
bun test
bun run typecheck
```
