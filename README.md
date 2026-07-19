# Guide Mark II

Mostly a TypeScript port of mlx-chronos benchmark suite for measuring LLM inference performance against any OpenAI-compatible server regardless of installation method.

## Features

- Multiple engine support (OpenAI, vLLM, Ollama, etc.)
- Comprehensive performance metrics
- Detailed result reporting
- Background monitoring
- Configurable benchmark parameters

## Setup

```bash
bun install
```

## Usage




## Development

```bash
bun run dev          # Watch mode
bun run build        # Build for production
bun test             # Run tests
bun run typecheck    # Type checking
bun run lint         # Lint code
```

## Project Structure

```
src/
├── constants.ts      # Benchmark constants and prompt pools
├── stats.ts          # Statistical computation functions
├── httpRetry.ts      # HTTP retry logic with exponential backoff
├── schema.ts         # Zod schemas for result validation
├── engines/          # Engine implementations
├── reporters/        # Output formatters
├── trackers.ts       # Background monitoring
├── benchmark.ts      # Core benchmark orchestration
└── cli.ts            # Command-line interface
```

## Porting Status

Ported from Python mlx-chronos:
- [x] constants.py → constants.ts
- [x] stats.py → stats.ts
- [x] http_retry.py → httpRetry.ts
- [x] schema.py → schema.ts (Zod)
- [x] detect.py → detect.ts
- [x] engines.py → engines.ts
- [x] trackers.py → trackers.ts
- [x] benchmark.py → benchmark.ts
- [x] reporters.py → reporters.ts
- [x] cli.py → cli.ts (commander)
