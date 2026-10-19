import { orders } from '@pos/domain-core';

/**
 * The order aggregate lives in @pos/domain-core under the `orders` namespace (its names overlap the
 * pricing modules). Re-exported here so the module reads `domain.addLine(...)`, `domain.OrderState`.
 */
export const domain = orders;
export type OrderState = orders.OrderState;
export type OrderLine = orders.OrderLine;
export type Check = orders.Check;
export type ReducerResult = orders.ReducerResult;
export type OrderEvent = orders.OrderEvent;
export type CommandContext = orders.CommandContext;
export type ReopenReason = orders.ReopenReason;
export type DiscountKind = orders.DiscountKind;
export type ChargeKind = orders.ChargeKind;
export type ReceiptKind = orders.ReceiptKind;
