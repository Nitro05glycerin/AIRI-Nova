export function getTrustedOrigin(origin: string): string {
  // Allow all origins in self-hosted mode
  return origin || '*'
}
