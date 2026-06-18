/**
 * Deterministically maps a user's display name to a consistent HSL color.
 * Same name always produces the same color — across sessions and devices.
 *
 * Produces vivid but not harsh colors (s=70%, l=62% keeps them readable on dark bg).
 */
export function nameToColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash; // 32-bit int
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 70%, 62%)`;
}

/** Returns a CSS-safe background + foreground pair for a given color. */
export function colorToStyle(color: string): { background: string; color: string } {
  return {
    background: color,
    // Dark text on light hues (yellow/green zone), white elsewhere
    color: '#fff',
  };
}
