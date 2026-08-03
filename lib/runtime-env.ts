let cloudflareEnv: Record<string, unknown> = {};

const runtime = globalThis as typeof globalThis & {
  __marksixBindings?: Record<string, unknown>;
};

try {
  const workerModule = await import("cloudflare:workers");
  cloudflareEnv = workerModule.env as unknown as Record<string, unknown>;
} catch {
  // Local Node tests do not implement the cloudflare: URL scheme.
}

export function getRuntimeEnv(name: string): string | undefined {
  const value = runtime.__marksixBindings?.[name] ?? cloudflareEnv[name];
  if (typeof value === "string" && value.length > 0) return value;
  return process.env[name];
}
