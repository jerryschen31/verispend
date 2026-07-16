// Minimal ambient types for Node builtins used by the CLI scripts, which run
// under plain Node but typecheck against workers types (no @types/node).
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}
