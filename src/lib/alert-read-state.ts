export function alertSeenStorageKey(userId: string): string {
  return `cafetrack:alerts-seen:${userId}`;
}
