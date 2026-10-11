// UI localization: the 20 most widely spoken languages + Ukrainian, Belarusian, Polish.
// Dictionaries — src/locales/<code>.json (main reads them too, for the tray and updates). No translation — English, then Russian.
// Flags are our own SVGs: Windows doesn't render emoji flags (shows letters instead).
import ar from '../locales/ar.json'
import be from '../locales/be.json'
import bn from '../locales/bn.json'
import de from '../locales/de.json'
import en from '../locales/en.json'
import es from '../locales/es.json'
import fr from '../locales/fr.json'
import hi from '../locales/hi.json'
import id from '../locales/id.json'
import it from '../locales/it.json'
import ja from '../locales/ja.json'
import ko from '../locales/ko.json'
import mr from '../locales/mr.json'
import pl from '../locales/pl.json'
import pt from '../locales/pt.json'
import ru from '../locales/ru.json'
import ta from '../locales/ta.json'
import te from '../locales/te.json'
import tr from '../locales/tr.json'
import uk from '../locales/uk.json'
import ur from '../locales/ur.json'
import vi from '../locales/vi.json'
import zh from '../locales/zh.json'

type Dict = Record<string, string>
const DICTS: Record<string, Dict> = { ar, be, bn, de, en, es, fr, hi, id, it, ja, ko, mr, pl, pt, ru, ta, te, tr, uk, ur, vi, zh }

export interface Lang { code: string; name: string; flag: string; rtl?: boolean }
/** Ordered by number of speakers, then languages added on request */
export const LANGS: Lang[] = [
  { code: 'en', name: 'English', flag: 'gb' },
  { code: 'zh', name: '中文', flag: 'cn' },
  { code: 'hi', name: 'हिन्दी', flag: 'in' },
  { code: 'es', name: 'Español', flag: 'es' },
  { code: 'fr', name: 'Français', flag: 'fr' },
  { code: 'ar', name: 'العربية', flag: 'sa', rtl: true },
  { code: 'bn', name: 'বাংলা', flag: 'bd' },
  { code: 'pt', name: 'Português', flag: 'br' },
  { code: 'ru', name: 'Русский', flag: 'ru' },
  { code: 'ur', name: 'اردو', flag: 'pk', rtl: true },
  { code: 'id', name: 'Bahasa Indonesia', flag: 'id' },
  { code: 'de', name: 'Deutsch', flag: 'de' },
  { code: 'ja', name: '日本語', flag: 'jp' },
  { code: 'mr', name: 'मराठी', flag: 'in' },
  { code: 'te', name: 'తెలుగు', flag: 'in' },
  { code: 'tr', name: 'Türkçe', flag: 'tr' },
  { code: 'ta', name: 'தமிழ்', flag: 'in' },
  { code: 'vi', name: 'Tiếng Việt', flag: 'vn' },
  { code: 'ko', name: '한국어', flag: 'kr' },
  { code: 'it', name: 'Italiano', flag: 'it' },
  { code: 'uk', name: 'Українська', flag: 'ua' },
  { code: 'be', name: 'Беларуская', flag: 'by' },
  { code: 'pl', name: 'Polski', flag: 'pl' },
]

let cur = 'ru'
export function setLang(code: string): void {
  cur = DICTS[code] ? code : 'en'
  document.documentElement.lang = cur
  document.documentElement.dir = LANGS.find((l) => l.code === cur)?.rtl ? 'rtl' : 'ltr'
}
export function lang(): string { return cur }

export function t(key: string, vars?: Record<string, string | number>): string {
  const s = DICTS[cur]?.[key] ?? en[key as keyof typeof en] ?? ru[key as keyof typeof ru] ?? key
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : s
}

/** Texts in markup: data-i18n (text), data-i18n-html (with markup), data-i18n-title (tooltip) */
export function applyStatic(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((e) => { e.textContent = t(e.dataset.i18n!) })
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((e) => { e.innerHTML = t(e.dataset.i18nHtml!) })
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((e) => { e.title = t(e.dataset.i18nTitle!) })
  root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((e) => { e.placeholder = t(e.dataset.i18nPlaceholder!) })
}

// ---------------------------------------------------------------- flags (simplified, 3:2)

const H = (c: string) => `<rect width="30" height="20" fill="${c}"/>`
const hs = (...c: string[]) => c.map((x, i) => `<rect y="${(20 / c.length) * i}" width="30" height="${20 / c.length + 0.1}" fill="${x}"/>`).join('')
const vs = (...c: string[]) => c.map((x, i) => `<rect x="${(30 / c.length) * i}" width="${30 / c.length + 0.1}" height="20" fill="${x}"/>`).join('')
const star = (cx: number, cy: number, r: number, c: string) => {
  const p: string[] = []
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.4 : r
    p.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`)
  }
  return `<polygon points="${p.join(' ')}" fill="${c}"/>`
}
const FLAGS: Record<string, string> = {
  gb: H('#012169') + '<path d="M0,0 30,20M30,0 0,20" stroke="#fff" stroke-width="4"/><path d="M0,0 30,20M30,0 0,20" stroke="#C8102E" stroke-width="1.6"/>'
    + '<path d="M15,0V20M0,10H30" stroke="#fff" stroke-width="6"/><path d="M15,0V20M0,10H30" stroke="#C8102E" stroke-width="3.6"/>',
  cn: H('#DE2910') + star(6, 6, 4, '#FFDE00') + star(12, 2.5, 1.1, '#FFDE00') + star(14, 5, 1.1, '#FFDE00') + star(14, 8.5, 1.1, '#FFDE00') + star(12, 11, 1.1, '#FFDE00'),
  in: hs('#FF9933', '#fff', '#138808') + '<circle cx="15" cy="10" r="2.6" fill="none" stroke="#000080" stroke-width="0.8"/>',
  es: '<rect width="30" height="20" fill="#AA151B"/><rect y="5" width="30" height="10" fill="#F1BF00"/>',
  fr: vs('#002395', '#fff', '#ED2939'),
  sa: H('#006C35') + '<rect x="7" y="12.5" width="16" height="1.4" fill="#fff"/><path d="M8,9 Q15,5 22,9" stroke="#fff" stroke-width="1.2" fill="none"/>',
  bd: H('#006A4E') + '<circle cx="13.5" cy="10" r="6" fill="#F42A41"/>',
  br: H('#009C3B') + '<polygon points="15,2.5 27,10 15,17.5 3,10" fill="#FFDF00"/><circle cx="15" cy="10" r="4.2" fill="#002776"/>',
  ru: hs('#fff', '#3D6FD1', '#fff'), // white-blue-white — at the user's request
  pk: H('#01411C') + '<rect width="7.5" height="20" fill="#fff"/><circle cx="19" cy="10" r="5" fill="#fff"/><circle cx="20.5" cy="8.8" r="4.3" fill="#01411C"/>' + star(22.5, 7, 1.6, '#fff'),
  id: hs('#CE1126', '#fff'),
  de: hs('#000', '#DD0000', '#FFCE00'),
  jp: H('#fff') + '<circle cx="15" cy="10" r="6" fill="#BC002D"/>',
  tr: H('#E30A17') + '<circle cx="11" cy="10" r="5" fill="#fff"/><circle cx="12.3" cy="10" r="4" fill="#E30A17"/>' + star(18.5, 10, 2.4, '#fff'),
  vn: H('#DA251D') + star(15, 10.5, 6, '#FFFF00'),
  kr: H('#fff') + '<circle cx="15" cy="10" r="5" fill="#0047A0"/><path d="M10,10 a5,5 0 0,1 10,0 a2.5,2.5 0 0,1 -5,0 a2.5,2.5 0 0,0 -5,0" fill="#CD2E3A"/>'
    + '<path d="M4,4 7,6.5M5,3 8,5.5M23,13.5 26,16M22,14.5 25,17M23,6.5 26,4M22,5.5 25,3M4,16 7,13.5M5,17 8,14.5" stroke="#000" stroke-width="0.9"/>',
  it: vs('#009246', '#fff', '#CE2B37'),
  ua: hs('#0057B7', '#FFD700'),
  by: hs('#fff', '#C8312C', '#fff'), // white-red-white — at the user's request
  pl: hs('#fff', '#DC143C'),
}
export function flagSvg(code: string): string {
  return `<svg class="flag" viewBox="0 0 30 20" width="21" height="14" aria-hidden="true">${FLAGS[code] ?? H('#555')}</svg>`
}
