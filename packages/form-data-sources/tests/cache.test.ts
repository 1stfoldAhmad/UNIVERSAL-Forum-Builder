import { describe, expect, it } from 'vitest';
import { DataSourceCache, canonicalJson } from '../src/index';

describe('data-source cache canonical keys', () => {
  it('canonicalJson sorts object keys recursively and preserves array order/nulls', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, null, { z: 3, y: 4 }] } }))
      .toBe('{"a":{"c":[1,null,{"y":4,"z":3}],"d":2},"b":1}');
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });

  it('nested reordered params produce the same cache key', () => {
    const cache = new DataSourceCache();
    const a = cache.key('src', { filter: { status: 'active', tags: ['x', 'y'] }, page: 1 });
    const b = cache.key('src', { page: 1, filter: { tags: ['x', 'y'], status: 'active' } });
    expect(a).toBe(b);
  });

  it('changing a nested filter changes the cache key', () => {
    const cache = new DataSourceCache();
    const a = cache.key('src', { filter: { status: 'active', owner: { id: 1 } } });
    const b = cache.key('src', { filter: { status: 'active', owner: { id: 2 } } });
    const c = cache.key('src', { filter: { status: 'archived', owner: { id: 1 } } });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('cache entries expire by TTL', () => {
    const cache = new DataSourceCache();
    const key = cache.key('src', { q: 'a' });
    cache.set(key, { items: [1] }, key, 1000);
    expect(cache.get(key, 500, 1400)).toEqual({ items: [1] });
    expect(cache.get(key, 500, 1600)).toBeUndefined();
  });
});
