// Old Dek links (docs/migration/LEGACY-URLS.md) arrive with their fragment intact:
// bookmarks, home screen shortcuts, notifications already on phones. Ids were kept
// by the migration, with two exceptions: two DM conversations were merged into an
// older one of the same pair, and their old ids open the kept channel. (Old
// #/m/<channel>/<seq> links are resolved by the server: api.resolveLegacyMessage.)

export const MERGED_DMS: Readonly<Record<string, string>> = {
  '01a0e7cc-80f1-74af-9a46-7c4f35e3a49c': '01a0ae59-ff4c-72da-abf5-d55672599f7c',
  '01a0debb-ec36-7c3b-8fc6-7b92dcec9b60': '01a0deb4-beae-7156-86b1-88b425605dc2',
};

export function keptChannelId(id: string): string {
  return MERGED_DMS[id.toLowerCase()] ?? id;
}
