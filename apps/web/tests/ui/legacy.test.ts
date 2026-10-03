import { describe, expect, it } from 'vitest';
import { keptChannelId, MERGED_DMS } from '../../src/features/shell/legacy';

describe('merged DMs', () => {
  it('opens the kept conversation for the two merged ids', () => {
    expect(keptChannelId('01a0e7cc-80f1-74af-9a46-7c4f35e3a49c')).toBe('01a0ae59-ff4c-72da-abf5-d55672599f7c');
    expect(keptChannelId('01A0DEBB-EC36-7C3B-8FC6-7B92DCEC9B60')).toBe('01a0deb4-beae-7156-86b1-88b425605dc2');
  });

  it('leaves every other id alone', () => {
    expect(keptChannelId('11111111-1111-4111-8111-111111111111')).toBe('11111111-1111-4111-8111-111111111111');
    expect(Object.keys(MERGED_DMS)).toHaveLength(2);
  });
});
