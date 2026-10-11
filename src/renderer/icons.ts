// UI icon set: hand-drawn 24×24 stroke icons (Lucide/Feather style), colored with currentColor so they follow
// the theme and hover states. No emoji anywhere in the UI — emoji render differently on every OS (and poorly on Windows).
// Static HTML uses placeholders `<i data-icon="name"></i>` that applyIcons() fills in.

const P: Record<string, string> = {
  // ---- audio / lanes
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  speaker: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
  headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  waves: '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5s2.4 2 5 2 2.5-2 5-2c1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2s2.4 2 5 2 2.5-2 5-2c1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2s2.4 2 5 2 2.5-2 5-2c1.3 0 1.9.5 2.5 1"/>',
  radio: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="m8 8 9-5"/><circle cx="15.5" cy="14" r="2.5"/><path d="M6.5 12h3M6.5 16h3"/>',
  cassette: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><circle cx="16" cy="11" r="2"/><path d="M10 11h4"/><path d="m6 19 2-4h8l2 4"/>',
  wind: '<path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/>',

  // ---- voices and characters
  mars: '<circle cx="10" cy="14" r="6"/><path d="M14.3 9.7 21 3"/><path d="M15 3h6v6"/>',
  venus: '<circle cx="12" cy="9" r="6"/><path d="M12 15v7"/><path d="M9 19h6"/>',
  baby: '<path d="M9 12h.01M15 12h.01"/><path d="M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5"/><path d="M19 6.3a9 9 0 0 1 1.8 3.9 2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1"/>',
  mountain: '<path d="m8 3 4 8 5-5 5 15H2z"/>',
  acorn: '<path d="M4 10c0-3.3 3.6-6 8-6s8 2.7 8 6z"/><path d="M12 4V2"/><path d="M6 10c0 5 3 9 6 11 3-2 6-6 6-11"/>',
  demon: '<circle cx="12" cy="14" r="7"/><path d="M6.6 9.6 4.5 3l4.7 4.2"/><path d="M17.4 9.6 19.5 3l-4.7 4.2"/><path d="m9 13 1.6 1M15 13l-1.6 1"/><path d="M10 17.5h4"/>',
  halo: '<ellipse cx="12" cy="4.5" rx="6.5" ry="2"/><circle cx="12" cy="13.5" r="4"/><path d="M12 20v2M4 13.5H2.5M21.5 13.5H20M6.3 19.2l-1.1 1.1M17.7 19.2l1.1 1.1M6.3 7.8 5.2 6.7M17.7 7.8l1.1-1.1"/>',
  tts: '<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.4A8.5 8.5 0 1 1 21 11.5z"/><path d="M8.5 10v3M12 8v7M15.5 10v3"/>',
  ghost: '<path d="M9 10h.01M15 10h.01"/><path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/>',
  bot: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
  skull: '<path d="M12 2a8 8 0 0 0-8 8c0 2.6 1.2 4.5 3 5.7V19a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3.3c1.8-1.2 3-3.1 3-5.7a8 8 0 0 0-8-8z"/><circle cx="9" cy="11" r="1.5"/><circle cx="15" cy="11" r="1.5"/><path d="M10 20v-2M14 20v-2"/>',
  alien: '<path d="M12 2.5c-4.6 0-8 3.3-8 7.6 0 4.6 3.7 9.3 8 11.4 4.3-2.1 8-6.8 8-11.4 0-4.3-3.4-7.6-8-7.6z"/><path d="M7.3 10.2c2 0 3.6 1.3 3.8 3.4-2 .2-3.8-1-3.8-3.4zM16.7 10.2c-2 0-3.6 1.3-3.8 3.4 2 .2 3.8-1 3.8-3.4z"/>',
  balloon: '<path d="M12 2a6 6 0 0 0-6 6c0 4 2.8 7.2 6 8.2 3.2-1 6-4.2 6-8.2a6 6 0 0 0-6-6z"/><path d="m10.8 16.2-.8 1.8h4l-.8-1.8"/><path d="M12 18c0 1.8-2 2.2-2 4"/>',
  clapper: '<path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="m6.2 5.3 3.1 3.9M12.4 3.4l3.1 4"/>',
  zombie: '<circle cx="12" cy="12" r="9"/><path d="m7.5 8.5 3 3M10.5 8.5l-3 3"/><circle cx="15.5" cy="10" r="1.2"/><path d="M8 16h8M10 14.8v2.4M14 14.8v2.4"/>',
  cane: '<path d="M7 8a4 4 0 0 1 8 0v13"/><path d="M7 8v2"/><path d="M13 21h4"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>',

  // ---- atmospheres
  orbit: '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-30 12 12)"/>',
  sparkles: '<path d="M11 3c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7z"/><path d="M19 15v6M16 18h6"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4.1 2-6 .5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  snowflake: '<path d="M12 2v20M14.6 2.8 12 5.5 9.4 2.8M3.3 7l17.4 10M5.3 5.1l1.1 3.7-3.7.9M3.3 17 20.7 7M2.7 14.3l3.7.9-1.1 3.7M9.4 21.2l2.6-2.7 2.6 2.7M18.7 18.9l-1.1-3.6 3.7-1M21.3 9.7l-3.7-.9 1.1-3.7"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  stadium: '<ellipse cx="12" cy="9" rx="10" ry="4"/><ellipse cx="12" cy="9" rx="5" ry="1.6"/><path d="M2 9v6c0 2.2 4.5 4 10 4s10-1.8 10-4V9"/>',
  bubbles: '<circle cx="8.5" cy="15.5" r="4.5"/><circle cx="16.5" cy="7.5" r="3"/><circle cx="17.5" cy="17" r="1.6"/><circle cx="7" cy="5" r="1.6"/>',
  cave: '<path d="M3 20v-8a9 9 0 0 1 18 0v8"/><path d="M8 20v-5a4 4 0 0 1 8 0v5"/><path d="M2 20h20"/>',

  // ---- custom-effect extras
  star: '<path d="m12 2.5 2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z"/>',
  crown: '<path d="M3.5 18 2 7l5.5 4.5L12 5l4.5 6.5L22 7l-1.5 11z"/><path d="M5 21h14"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.1-6C9.5 14.5 12 13 13 12"/>',
  gem: '<path d="M6 3h12l4 6-10 13L2 9z"/><path d="M2 9h20"/><path d="m11 3-3 6 4 13 4-13-3-6"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1z"/><path d="m12 15-3-3a22 22 0 0 1 2-4A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2z"/><path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0"/><path d="M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',

  // ---- window and controls
  settings: '<path d="M19.4 10.4l2.5.3v2.6l-2.5.3-1 2.5 1.5 2-1.8 1.8-2-1.5-2.5 1-.3 2.5h-2.6l-.3-2.5-2.5-1-2 1.5-1.8-1.8 1.5-2-1-2.5-2.5-.3v-2.6l2.5-.3 1-2.5-1.5-2 1.8-1.8 2 1.5 2.5-1 .3-2.5h2.6l.3 2.5 2.5 1 2-1.5 1.8 1.8-1.5 2z"/><circle cx="12" cy="12" r="3"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12.5h.01M18 12.5h.01M10 12.5h4M7 16h10"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2v.8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  widget: '<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1"/>',
  shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.8 9.8 0 0 0-6.7 2.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.8 9.8 0 0 0 6.7-2.7L21 16"/><path d="M16 16h5v5"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
  glasses: '<circle cx="6" cy="15" r="4"/><circle cx="18" cy="15" r="4"/><path d="M14 15a2 2 0 0 0-4 0"/><path d="M2.5 13 5 7c.7-1.3 1.4-2 3-2M21.5 13 19 7c-.7-1.3-1.5-2-3-2"/>',
  cube: '<path d="M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
}

export type IconName = keyof typeof P

/** SVG markup of an icon; size in px (the stroke scales with it, 1.75 at 24 px) */
export function icon(name: string, size = 18, cls = ''): string {
  const body = P[name] ?? P.star
  return `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}

/** An element holding just the icon (for building DOM without innerHTML on user text) */
export function iconEl(name: string, size = 18, cls = ''): HTMLElement {
  const s = document.createElement('span')
  s.className = `ico-wrap${cls ? ` ${cls}` : ''}`
  s.innerHTML = icon(name, size)
  return s
}

/** Fills static placeholders: `<i data-icon="pin" data-size="16"></i>` */
export function applyIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((e) => {
    e.innerHTML = icon(e.dataset.icon!, Number(e.dataset.size) || 16)
  })
}

/** Icons offered for a custom effect */
export const CUSTOM_ICONS = [
  'star', 'heart', 'flame', 'zap', 'sparkles', 'crown', 'skull', 'ghost', 'demon', 'bot', 'smile', 'eye',
  'moon', 'sun', 'cloud', 'waves', 'leaf', 'gem', 'rocket', 'music', 'headphones', 'mic',
] as const
export const DEFAULT_CUSTOM_ICON = 'star'

/** Custom effects saved by older versions carry an emoji — map the ones the old picker offered, anything else gets the default */
const LEGACY: Record<string, string> = {
  '⭐': 'star', '🔥': 'flame', '🎭': 'smile', '🦊': 'leaf', '🐉': 'flame', '👽': 'eye', '🎃': 'smile', '🤖': 'bot',
  '🧙': 'sparkles', '💀': 'skull', '🌊': 'waves', '⚡': 'zap', '🍄': 'leaf', '🎸': 'music', '👑': 'crown', '🫧': 'cloud',
}
export function customIcon(v: string | undefined): string {
  if (v && v in P) return v
  const bare = (v ?? '').replace(/️/g, '')
  return LEGACY[bare] ?? DEFAULT_CUSTOM_ICON
}
