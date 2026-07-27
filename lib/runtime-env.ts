let cloudflareEnv: Record<string, unknown> = {};

try {
  const workerModule = await import("cloudflare:workers");
  cloudflareEnv = workerModule.env as unknown as Record<string, unknown>;
} catch {
  // Local Node tests do not implement the cloudflare: URL scheme.
}

export function getRuntimeEnv(name: string): string | undefined {
  const value = cloudflareEnv[name];
  if (typeof value === "string" && value.length > 0) return value;
  return process.env[name];
}
