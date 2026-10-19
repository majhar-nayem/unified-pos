import type { orders } from '@pos/domain-core';

/** The frozen receipt model is stored next to the renders so any paper width can be laid out later; bigint survives the round trip. */
export function serializeModel(model: orders.ReceiptModel): string {
  return JSON.stringify(model, (_k, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));
}

export function parseModel(text: string): orders.ReceiptModel {
  return JSON.parse(text, (_k, v) =>
    v && typeof v === 'object' && typeof (v as { $bigint?: unknown }).$bigint === 'string'
      ? BigInt((v as { $bigint: string }).$bigint)
      : v,
  ) as orders.ReceiptModel;
}
