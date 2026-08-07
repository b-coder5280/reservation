export const DISTINCT_COLORS = [
  '#FFD1DC',
  '#FFDFD3',
  '#FFFFD1',
  '#D1FFD6',
  '#D1F5FF',
  '#E0D1FF',
  '#FFD1F5',
  '#D1FFF3',
  '#FFE5D1',
  '#E2E2E2',
  '#C4F5E1',
  '#DAE8FC',
  '#FFABAB',
  '#FFC3A0',
  '#D5AAFF',
  '#85E3FF',
  '#B9FBC0',
  '#FBE7C6',
  '#FF9CEE',
  '#A0C4FF',
];

export function normalizeReservationName(name) {
  return String(name || '').trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function hashString(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export function getReservationColorIndex(name) {
  const normalizedName = normalizeReservationName(name);
  if (!normalizedName) return 0;

  return hashString(normalizedName) % DISTINCT_COLORS.length;
}

export function getWebsiteColorForName(name) {
  if (!normalizeReservationName(name)) return '#F7FAFC';
  return DISTINCT_COLORS[getReservationColorIndex(name)];
}
