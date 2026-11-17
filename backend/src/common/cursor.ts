import { BadRequestException } from '@nestjs/common';

/**
 * Opaque keyset-pagination cursor over (transaction_date DESC, id DESC).
 * Keyset pagination stays O(page size) at any depth, unlike OFFSET, which
 * must scan and discard every earlier row — essential at millions of rows.
 */
export interface TransactionCursor {
  date: Date;
  id: string;
}

export function encodeCursor(cursor: TransactionCursor): string {
  return Buffer.from(
    `${cursor.date.toISOString()}|${cursor.id}`,
    'utf8',
  ).toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(raw: string): TransactionCursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const [iso, id] = decoded.split('|');
  const date = new Date(iso ?? '');
  if (!iso || Number.isNaN(date.getTime()) || !id || !UUID.test(id)) {
    throw new BadRequestException('Invalid pagination cursor');
  }
  return { date, id };
}
