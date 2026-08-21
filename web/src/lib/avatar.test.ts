import { describe, it, expect } from 'vitest';
import { localAvatarUrl } from './avatar.ts';

describe('localAvatarUrl', () => {
  it('maps the API path onto this origin, keeping the cache-busting digest', () => {
    expect(localAvatarUrl('/api/v1/profiles/santiago/avatar?v=abc123def456')).toBe('/avatars/santiago?v=abc123def456');
  });

  it('accepts the handles the database allows', () => {
    for (const handle of ['ab', 'a-b_c', 'user123', '0abc', 'a'.repeat(31)]) {
      expect(localAvatarUrl(`/api/v1/profiles/${handle}/avatar?v=aa`), handle).toBe(`/avatars/${handle}?v=aa`);
    }
  });

  it('returns null for anything that is not one of ours', () => {
    // Each of these is a URL an `<img src>` must never be built from. The
    // component falls back to the identicon it was also given, so a null here
    // is a face, not a hole.
    for (const hostile of [
      'https://tracker.example/pixel.png',
      '//tracker.example/pixel.png',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      '/api/v1/profiles/santiago/avatar?v=abc&next=https://tracker.example',
      '/api/v1/profiles/../../admin/users/avatar?v=aa',
      '/api/v1/profiles/santiago/avatar',
      '/api/v1/profiles/SANTIAGO/avatar?v=aa',
      '/avatars/santiago?v=aa',
      '',
    ]) {
      expect(localAvatarUrl(hostile), hostile).toBeNull();
    }
  });

  it('returns null rather than throwing for a missing or non-string value', () => {
    expect(localAvatarUrl(null)).toBeNull();
    expect(localAvatarUrl(undefined)).toBeNull();
    expect(localAvatarUrl(42 as unknown as string)).toBeNull();
  });

  it('refuses a digest that is not hex, or longer than a sha256', () => {
    expect(localAvatarUrl('/api/v1/profiles/santiago/avatar?v=zz')).toBeNull();
    expect(localAvatarUrl(`/api/v1/profiles/santiago/avatar?v=${'a'.repeat(65)}`)).toBeNull();
  });
});
