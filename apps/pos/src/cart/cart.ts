/**
 * PLACEHOLDER cart for the shell: records commands in the command log *before* the UI changes, applies
 * them with a local reducer and persists the result as a local projection (docs/01 §8.1 group 3).
 *
 * TODO(integration): replace the reducer and totals with the shared domain-core order reducers and
 * `PricingPort.priceOrder()` (S-F3/S-F4). Prices here are variant list prices, not priced results, and
 * there is no tax or discount line.
 */
import type { CommandLog } from '@pos/sync-protocol';
import { money, toDecimalString } from '@pos/domain-core';

import type { PosProduct } from '../catalog/placeholder.js';
import type { ProjectionStore } from '../store/stores.js';

export interface CartLine {
  readonly lineId: string;
  readonly variantId: string;
  readonly name: string;
  /** Minor units, integer string. */
  readonly unitPriceMinor: string;
  /** Decimal string: whole units for "each", kilograms for "weight". */
  readonly quantity: string;
  readonly soldBy: 'each' | 'weight';
}

export interface Cart {
  readonly id: string;
  readonly status: 'open' | 'voided';
  readonly lines: readonly CartLine[];
}

export const EMPTY_CART: Cart = { id: '', status: 'open', lines: [] };

export type CartCommandType = 'cart.line.add' | 'cart.line.remove' | 'cart.void';

export function applyCartCommand(cart: Cart, type: string, payload: Record<string, unknown>): Cart {
  switch (type) {
    case 'cart.line.add': {
      const line = payload.line as CartLine;
      const id = (payload.cartId as string) || cart.id;
      const existing =
        line.soldBy === 'each'
          ? cart.lines.find((l) => l.variantId === line.variantId && l.soldBy === 'each')
          : undefined;
      if (existing)
        return {
          ...cart,
          id,
          lines: cart.lines.map((l) =>
            l.lineId === existing.lineId
              ? { ...l, quantity: String(Number(l.quantity) + Number(line.quantity)) }
              : l,
          ),
        };
      return { ...cart, id, lines: [...cart.lines, line] };
    }
    case 'cart.line.remove':
      return { ...cart, lines: cart.lines.filter((l) => l.lineId !== payload.lineId) };
    case 'cart.void':
      return { ...EMPTY_CART };
    default:
      return cart;
  }
}

/** Line total in minor units: price × quantity, rounded half up to a whole minor unit. */
export function lineTotalMinor(line: CartLine): bigint {
  const [whole = '0', frac = ''] = line.quantity.split('.');
  const scale = 10n ** BigInt(frac.length);
  const qty = BigInt(whole + frac);
  const product = BigInt(line.unitPriceMinor) * qty;
  const q = product / scale;
  const r = product % scale;
  return r * 2n >= scale ? q + 1n : q;
}

export function cartSubtotalMinor(cart: Cart): bigint {
  return cart.lines.reduce((sum, l) => sum + lineTotalMinor(l), 0n);
}

export function itemCount(cart: Cart): number {
  return cart.lines.reduce((n, l) => n + (l.soldBy === 'each' ? Number(l.quantity) : 1), 0);
}

export function formatMinor(minor: bigint | string, currency: string): string {
  return toDecimalString(money(typeof minor === 'string' ? BigInt(minor) : minor, currency));
}

export type AddResult =
  | { readonly ok: true; readonly line: CartLine }
  | { readonly ok: false; readonly reason: 'not_found' | 'needs_weight' };

export class CartService {
  private cart: Cart = EMPTY_CART;
  private readonly listeners = new Set<() => void>();
  private recoveredFlag = false;
  private lastAddedLineId: string | null = null;

  constructor(
    private readonly log: CommandLog,
    private readonly projections: ProjectionStore,
    private readonly newId: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  getCart = (): Cart => this.cart;
  getLastAddedLineId = (): string | null => this.lastAddedLineId;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** True when the open order was reconstructed after a restart ("Recovered" banner). */
  get recovered(): boolean {
    return this.recoveredFlag;
  }
  dismissRecovered(): void {
    this.recoveredFlag = false;
    this.emit();
  }

  /** Reconstruct the open order from its projection after a restart (docs/01 §8.4). */
  async recover(): Promise<void> {
    const carts = await this.projections.list<Cart>('cart');
    const open = carts.find((c) => c.status === 'open' && c.lines.length > 0);
    if (open) {
      this.cart = open;
      this.recoveredFlag = true;
      this.emit();
    }
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  /** Durable command first, then local state, then notify the UI. */
  async dispatch(type: CartCommandType, payload: Record<string, unknown>): Promise<void> {
    const command = await this.log.append(type, payload);
    this.cart = applyCartCommand(this.cart, type, payload);
    const id = this.cart.id || (payload.cartId as string | undefined) || '';
    if (id) await this.projections.put('cart', id, this.cart, command.hlc);
    this.emit();
  }

  async addProduct(product: PosProduct, quantity = '1'): Promise<CartLine> {
    const cartId = this.cart.id || this.newId();
    const line: CartLine = {
      lineId: this.newId(),
      variantId: product.variantId,
      name: product.name,
      unitPriceMinor: product.priceMinor.toString(),
      quantity,
      soldBy: product.soldBy,
    };
    await this.dispatch('cart.line.add', { cartId, line });
    this.lastAddedLineId = line.lineId;
    this.emit();
    return line;
  }

  async removeLine(lineId: string): Promise<void> {
    await this.dispatch('cart.line.remove', { cartId: this.cart.id, lineId });
  }

  async voidCart(): Promise<void> {
    const cartId = this.cart.id;
    await this.dispatch('cart.void', { cartId });
    if (cartId) await this.projections.delete('cart', cartId);
  }
}
