import { describe, it, expect } from 'vitest';
import { parseGalleryBlock } from './parser';

describe('parseGalleryBlock', () => {
  it('parses a complete gallery block', () => {
    const result = parseGalleryBlock(`
from books
show title, author, rating
image cover
where rating >= 4
sort by rating desc
limit 50
columns 4
    `.trim());

    expect(result.success).toBe(true);
    expect(result.config).toEqual({
      table: 'books',
      columns: ['title', 'author', 'rating'],
      imageField: 'cover',
      gridColumns: 4,
      filter: 'rating >= 4',
      sort: [{ field: 'rating', direction: 'DESC' }],
      limit: 50,
    });
  });

  it('requires from and show', () => {
    const result = parseGalleryBlock('image cover');
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles minimal config (from + show)', () => {
    const result = parseGalleryBlock(`
from books
show title
    `.trim());

    expect(result.success).toBe(true);
    expect(result.config!.table).toBe('books');
    expect(result.config!.columns).toEqual(['title']);
    expect(result.config!.imageField).toBeUndefined();
    expect(result.config!.gridColumns).toBeUndefined();
    expect(result.config!.limit).toBe(200);
  });

  it('defaults sort direction to ASC', () => {
    const result = parseGalleryBlock(`
from books
show title
sort by rating
    `.trim());

    expect(result.success).toBe(true);
    expect(result.config!.sort).toEqual([{ field: 'rating', direction: 'ASC' }]);
  });

  it('rejects invalid columns value', () => {
    const result = parseGalleryBlock(`
from books
show title
columns zero
    `.trim());

    expect(result.success).toBe(true);
    expect(result.config!.gridColumns).toBeUndefined();
    expect(result.errors.some(e => e.includes('columns'))).toBe(true);
  });

  it('ignores comments', () => {
    const result = parseGalleryBlock(`
from books
# this is a comment
show title
    `.trim());

    expect(result.success).toBe(true);
  });
});
