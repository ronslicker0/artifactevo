// ── Preset Configurations ──────────────────────────────────────────────

export interface PresetConfig {
  label: string;
  scorer: Array<{ name: string; command: string; weight: number }>;
}

export const PRESETS: Record<string, PresetConfig> = {
  standard: {
    label: 'Standard (generic build command)',
    scorer: [{ name: 'build', command: 'npm run build', weight: 100 }],
  },
  nextjs: {
    label: 'Next.js (tsc + eslint + next build)',
    scorer: [
      { name: 'typecheck', command: 'npx tsc --noEmit', weight: 30 },
      { name: 'lint', command: 'npm run lint', weight: 20 },
      { name: 'build', command: 'npm run build', weight: 50 },
    ],
  },
  typescript: {
    label: 'TypeScript Library (tsc + vitest)',
    scorer: [
      { name: 'typecheck', command: 'npx tsc --noEmit', weight: 50 },
      { name: 'test', command: 'npm test', weight: 50 },
    ],
  },
  python: {
    label: 'Python (ruff + mypy + pytest)',
    scorer: [
      { name: 'lint', command: 'ruff check .', weight: 30 },
      { name: 'typecheck', command: 'mypy .', weight: 30 },
      { name: 'test', command: 'pytest', weight: 40 },
    ],
  },
  go: {
    label: 'Go (go vet + go test + golangci-lint)',
    scorer: [
      { name: 'vet', command: 'go vet ./...', weight: 30 },
      { name: 'test', command: 'go test ./...', weight: 40 },
      { name: 'lint', command: 'golangci-lint run', weight: 30 },
    ],
  },
  rust: {
    label: 'Rust (cargo check + cargo test + clippy)',
    scorer: [
      { name: 'build', command: 'cargo check', weight: 30 },
      { name: 'test', command: 'cargo test', weight: 40 },
      { name: 'lint', command: 'cargo clippy -- -D warnings', weight: 30 },
    ],
  },
};
