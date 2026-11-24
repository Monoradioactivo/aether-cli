export const DEFAULT_AETHER_SERVER_URL = "https://api.aetherpush.com";

export function resolveServerUrl(storedServerUrl?: string): string {
  return storedServerUrl || DEFAULT_AETHER_SERVER_URL;
}
