# Guide Mark II

TypeScript port of mlx-chronos benchmark suite for measuring LLM inference performance against any OpenAI-compatible server on Apple Silicon.

## Features

- Measures throughput (tok/s), TTFT (cold + cached), RAM usage, and thermal state
- Background monitoring during benchmark runs
- Two profiles: baseline (fast) and sustained (throttling detection)
- JSON and Markdown result reports with styled terminal output
- HTTP retry with exponential backoff

## Installation

```bash
npm install -g guide-mark-ii
```

## Usage

Run a benchmark against a local inference server:

```bash
guide-mark-ii run --url http://localhost:8000/v1 --model Qwen3.5-4B
```

### Required Options

| Option | Description |
|--------|-------------|
| `--url <url>` | URL of a running OpenAI-compatible server (e.g. `http://192.168.1.50:8000/v1`) |
| `--model <model>` | Model name exactly as shown in the engine (e.g. `Qwen3.5-4B-OptiQ-4bit`) |

### Benchmark Options

| Option | Default | Description |
|--------|---------|-------------|
| `--trials <n>` | 5 (baseline) / 1 (sustained) | Number of trials per metric. Max: 30 |
| `--profile <p>` | `baseline` | `baseline` for quick runs, `sustained` for throttling detection |
| `--max-tokens <n>` | 100 (baseline) / 1000 (sustained) | Max tokens per throughput trial |
| `--min-tokens <n>` | — | Min tokens per throughput trial (engines that support it) |

### Monitoring Options

| Option | Default | Description |
|--------|---------|-------------|
| `--ram-sample-interval <s>` | 0.05 | Seconds between RAM samples |
| `--cooldown-seconds <s>` | 0 | Wait this long since last run before starting |

### Output Options

| Option | Default | Description |
|--------|---------|-------------|
| `--format <f>` | `json` | `json`, `markdown`, or `all` |
| `--output-dir <dir>` | `./results/local` | Directory for result files |

### Metadata Options

| Option | Default | Description |
|--------|---------|-------------|
| `--engine <name>` | `generic` | Engine label stored in results (no functional effect) |

### Examples

Basic benchmark:
```bash
guide-mark-ii run --url http://localhost:8000/v1 --model my-model
```

Sustained profile with Markdown output:
```bash
guide-mark-ii run \
  --url http://localhost:8000/v1 \
  --model my-model \
  --profile sustained \
  --format all
```

Custom trials and cooldown:
```bash
guide-mark-ii run \
  --url http://localhost:8000/v1 \
  --model my-model \
  --trials 10 \
  --cooldown-seconds 300
```

### Output

Results are saved to `--output-dir` (default: `./results/local/`). JSON files contain full benchmark data including raw trial values, hardware info, thermal monitoring, and phase timings.

When using `--format markdown` or `--format all`, the results are also rendered to the terminal with styled formatting.

## Development

```bash
bun install         # Install dependencies
bun run dev         # Watch mode
bun run build       # Build for production
bun test            # Run tests
bun run typecheck   # Type checking
bun run lint        # Lint code
```

## Project Structure

```
src/
├── cli.ts            # CLI entry point (commander)
├── benchmark.ts      # Core benchmark orchestration
├── engines.ts        # OpenAI-compatible HTTP client
├── constants.ts      # Prompt pools, protocol builders, config
├── schema.ts         # Zod schemas for result validation
├── stats.ts          # Statistical computation (mean, stddev, p95)
├── detect.ts         # Hardware detection (Apple Silicon)
├── trackers.ts       # Background RAM/thermal monitoring
├── httpRetry.ts      # HTTP retry with exponential backoff
├── reporters.ts      # JSON and Markdown report generation
└── index.ts          # Public API exports
```
