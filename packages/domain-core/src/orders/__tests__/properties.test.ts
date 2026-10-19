import { describe, expect, it } from 'vitest';

import { mergeChecks, shareLine, splitCheckByLines, splitCheckBySeat } from '../checks.js';
import { addCharge, applyDiscount, removeCharge, removeDiscount } from '../discounts.js';
import { addLine, removeLine, updateLine, voidLine } from '../lines.js';
import { place, resume, suspend, voidOrder } from '../lifecycle.js';
import { applyPayment, applyRefund, markPaid } from '../payments.js';
import { assertConsistent } from '../status.js';
import { OrderRuleError, type OrderState, type ReducerResult } from '../types.js';
import { assertDbInvariants, draft, makeCtx, snapshot } from './helpers.js';

/** xorshift32: deterministic, so a failing seed reproduces. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}

type Rng = ReturnType<typeof rng>;

const QUANTITIES = ['1', '2', '3', '0.5', '1.25', '0.3333', '7'];

/** One random command; returns the reducer result or undefined when the draw had no valid target. */
function randomCommand(
  o: OrderState,
  r: Rng,
  ctx: ReturnType<typeof makeCtx>,
  fixedChargesOnly: boolean,
): { name: string; result: ReducerResult } | undefined {
  const lines = o.lines.filter((l) => l.status === 'active');
  const checks = o.checks.filter((c) => c.status === 'open');
  const pickLine = () => (lines.length ? r.pick(lines) : undefined);
  const pickCheck = () => (checks.length ? r.pick(checks) : undefined);
  const choice = r.int(0, 17);
  switch (choice) {
    case 0:
    case 1:
    case 2:
      return {
        name: 'addLine',
        result: addLine(
          o,
          {
            snapshot: snapshot(
              `Item ${r.int(1, 9)}`,
              BigInt(r.int(0, 6000)),
              r.chance(0.2) ? { taxClassCode: 'gst_free' } : {},
            ),
            quantity: r.pick(QUANTITIES),
            seatNumber: r.chance(0.6) ? r.int(1, 3) : null,
            modifiers: r.chance(0.2)
              ? [{ name: 'Extra', priceDeltaMinor: BigInt(r.int(0, 300)) }]
              : [],
          },
          ctx,
        ),
      };
    case 3: {
      const l = pickLine();
      return (
        l && {
          name: 'updateLine',
          result: updateLine(o, l.id, { quantity: r.pick(QUANTITIES) }, ctx),
        }
      );
    }
    case 4: {
      const l = pickLine();
      if (!l) return undefined;
      return o.status === 'draft'
        ? { name: 'removeLine', result: removeLine(o, l.id, ctx) }
        : { name: 'voidLine', result: voidLine(o, l.id, { reason: 'test', voidedBy: 'u' }, ctx) };
    }
    case 5:
      return {
        name: 'applyDiscount',
        result: applyDiscount(
          o,
          {
            lineId: r.chance(0.5) ? (pickLine()?.id ?? null) : null,
            ...(r.chance(0.5)
              ? { percent: String(r.int(1, 100)) }
              : { amountMinor: BigInt(r.int(1, 4000)) }),
            description: 'd',
            appliedBy: 'u',
          },
          ctx,
        ),
      };
    case 6:
      return o.discounts.length
        ? { name: 'removeDiscount', result: removeDiscount(o, r.pick(o.discounts).id, ctx) }
        : undefined;
    case 7:
      return {
        name: 'addCharge',
        result: addCharge(
          o,
          fixedChargesOnly || r.chance(0.5)
            ? {
                kind: 'surcharge',
                description: 'fee',
                amountMinor: BigInt(r.int(0, 500)),
                taxable: r.chance(0.7),
              }
            : {
                kind: 'service_charge',
                description: 'svc',
                percent: String(r.int(1, 15)),
                taxable: false,
              },
          ctx,
        ),
      };
    case 8:
      return o.charges.length
        ? { name: 'removeCharge', result: removeCharge(o, r.pick(o.charges).id, ctx) }
        : undefined;
    case 9: {
      const c = pickCheck();
      const ls = lines.filter((l) => l.checkId === c?.id);
      return c && ls.length
        ? {
            name: 'splitByLines',
            result: splitCheckByLines(o, { fromCheckId: c.id, lineIds: [r.pick(ls).id] }, ctx),
          }
        : undefined;
    }
    case 10: {
      const c = pickCheck();
      return (
        c && {
          name: 'splitBySeat',
          result: splitCheckBySeat(o, { fromCheckId: c.id, seatNumbers: [r.int(1, 3)] }, ctx),
        }
      );
    }
    case 11:
      return checks.length >= 2
        ? {
            name: 'merge',
            result: mergeChecks(
              o,
              { sourceCheckId: checks[0]!.id, targetCheckId: checks[1]!.id },
              ctx,
            ),
          }
        : undefined;
    case 12: {
      const l = pickLine();
      return (
        l && { name: 'share', result: shareLine(o, { lineId: l.id, parts: r.int(2, 4) }, ctx) }
      );
    }
    case 13:
      return o.status === 'draft'
        ? { name: 'place', result: place(o, { orderNumber: r.int(1, 999) }, ctx) }
        : undefined;
    case 14:
      return o.status === 'open'
        ? { name: 'suspend', result: suspend(o, {}, ctx) }
        : o.status === 'suspended'
          ? { name: 'resume', result: resume(o, ctx) }
          : undefined;
    case 15: {
      const c = pickCheck();
      if (!c || o.status !== 'open' || c.totalMinor - c.paidMinor <= 0n) return undefined;
      const due = c.totalMinor - c.paidMinor;
      const amount = r.chance(0.5) ? due : BigInt(Math.max(1, Math.floor(Number(due) * r.next())));
      return {
        name: 'applyPayment',
        result: applyPayment(
          o,
          { checkId: c.id, amountMinor: amount, paymentRef: `p-${ctx.newId()}` },
          ctx,
        ),
      };
    }
    case 16:
      return o.status === 'open' ? { name: 'markPaid', result: markPaid(o, ctx) } : undefined;
    default:
      if (o.status === 'completed' && o.paidMinor > o.refundedMinor)
        return {
          name: 'applyRefund',
          result: applyRefund(
            o,
            {
              checkId: o.checks.find((c) => c.paidMinor > c.refundedMinor)!.id,
              amountMinor: 1n,
              paymentRef: `r-${ctx.newId()}`,
            },
            ctx,
          ),
        };
      return r.chance(0.05)
        ? { name: 'voidOrder', result: voidOrder(o, { reason: 'test', voidedBy: 'u' }, ctx) }
        : undefined;
  }
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe('order aggregate properties (300 random command sequences)', () => {
  it('every reachable state keeps the database invariants, valid statuses and one version step per command', () => {
    let applied = 0;
    let rejected = 0;
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      const r = rng(seed);
      const ctx = makeCtx();
      let o = draft(ctx, {
        kind: r.pick(['dine_in', 'retail_sale', 'takeaway'] as const),
        pricingMode: r.pick(['tax_inclusive', 'tax_exclusive'] as const),
      });
      for (let step = 0; step < 40; step++) {
        let cmd;
        try {
          cmd = randomCommand(o, r, ctx, false);
        } catch (e) {
          // a rule refused the draw: that is a legal outcome, anything else is a bug
          if (!(e instanceof OrderRuleError))
            throw new Error(`seed ${seed} step ${step}: ${String(e)}`);
          rejected++;
          continue;
        }
        if (!cmd) continue;
        try {
          assertDbInvariants(cmd.result.state);
          assertConsistent(cmd.result.state);
          expect(cmd.result.state.version, `seed ${seed} ${cmd.name}`).toBe(o.version + 1);
          for (const l of cmd.result.state.lines) {
            if (l.status !== 'active') continue;
            // a discount never exceeds the line's gross, so a billed line is never negative
            expect(l.totalMinor, `seed ${seed} ${cmd.name} line ${l.seq}`).toBeGreaterThanOrEqual(
              0n,
            );
            expect(l.discountMinor).toBeGreaterThanOrEqual(0n);
          }
          expect(
            cmd.result.state.paidMinor <= cmd.result.state.totalMinor ||
              cmd.result.state.totalMinor < 0n,
          ).toBe(true);
        } catch (e) {
          throw new Error(`seed ${seed} step ${step} after ${cmd.name}: ${String(e)}`);
        }
        seen.add(cmd.name);
        applied++;
        o = cmd.result.state;
      }
    }
    // the generator really exercised the whole command set
    expect(applied).toBeGreaterThan(2000);
    expect(rejected).toBeGreaterThan(50);
    expect([...seen].sort()).toEqual(
      expect.arrayContaining([
        'addLine',
        'applyDiscount',
        'markPaid',
        'merge',
        'place',
        'share',
        'splitByLines',
        'splitBySeat',
        'updateLine',
        'applyPayment',
      ]),
    );
  });

  it('moving lines between checks (split, merge) never changes any order-level amount', () => {
    let moves = 0;
    for (const seed of SEEDS) {
      const r = rng(seed * 7919);
      const ctx = makeCtx();
      let o = draft(ctx, {
        kind: 'dine_in',
        pricingMode: r.pick(['tax_inclusive', 'tax_exclusive'] as const),
      });
      // build a bill with fixed charges only (percent charges are per check and may move a cent)
      for (let i = 0; i < r.int(2, 8); i++) {
        o = addLine(
          o,
          {
            snapshot: snapshot(`Item ${i}`, BigInt(r.int(1, 5000))),
            quantity: r.pick(QUANTITIES),
            seatNumber: r.int(1, 3),
          },
          ctx,
        ).state;
      }
      if (r.chance(0.6))
        o = applyDiscount(
          o,
          { percent: String(r.int(1, 50)), description: 'd', appliedBy: 'u' },
          ctx,
        ).state;
      if (r.chance(0.5))
        o = addCharge(
          o,
          { kind: 'surcharge', description: 'fee', amountMinor: BigInt(r.int(1, 500)) },
          ctx,
        ).state;
      for (let i = 0; i < 12; i++) {
        const before = o;
        const open = o.checks.filter((c) => c.status === 'open');
        let res: ReducerResult | undefined;
        try {
          if (r.chance(0.4) && open.length >= 2)
            res = mergeChecks(o, { sourceCheckId: open[0]!.id, targetCheckId: open[1]!.id }, ctx);
          else if (r.chance(0.5))
            res = splitCheckBySeat(
              o,
              { fromCheckId: r.pick(open).id, seatNumbers: [r.int(1, 3)] },
              ctx,
            );
          else {
            const c = r.pick(open);
            const ls = o.lines.filter((l) => l.checkId === c.id && l.status === 'active');
            if (ls.length)
              res = splitCheckByLines(o, { fromCheckId: c.id, lineIds: [r.pick(ls).id] }, ctx);
          }
        } catch (e) {
          if (!(e instanceof OrderRuleError)) throw e;
          continue;
        }
        if (!res) continue;
        o = res.state;
        moves++;
        for (const k of [
          'subtotalMinor',
          'discountMinor',
          'taxMinor',
          'chargesMinor',
          'totalMinor',
        ] as const)
          expect(o[k], `seed ${seed} ${k}`).toBe(before[k]);
        assertDbInvariants(o);
      }
    }
    expect(moves).toBeGreaterThan(1000);
  });

  it('sharing a line keeps the subtotal and discount exactly, and the total exactly for inclusive pricing', () => {
    let shared = 0;
    for (const seed of SEEDS) {
      const r = rng(seed * 104729);
      const ctx = makeCtx();
      const mode = r.pick(['tax_inclusive', 'tax_exclusive'] as const);
      let o = draft(ctx, { kind: 'dine_in', pricingMode: mode });
      for (let i = 0; i < r.int(1, 4); i++)
        o = addLine(
          o,
          { snapshot: snapshot(`Item ${i}`, BigInt(r.int(1, 9999))), quantity: r.pick(QUANTITIES) },
          ctx,
        ).state;
      if (r.chance(0.5))
        o = applyDiscount(
          o,
          {
            lineId: r.pick(o.lines).id,
            percent: String(r.int(1, 90)),
            description: 'd',
            appliedBy: 'u',
          },
          ctx,
        ).state;
      if (r.chance(0.4))
        o = applyDiscount(
          o,
          { amountMinor: BigInt(r.int(1, 3000)), description: 'order', appliedBy: 'u' },
          ctx,
        ).state;
      const line = r.pick(o.lines.filter((l) => l.status === 'active'));
      const parts = r.int(2, 5);
      let res: ReducerResult;
      try {
        res = shareLine(o, { lineId: line.id, parts }, ctx);
      } catch (e) {
        if (e instanceof OrderRuleError) continue; // e.g. a quantity too small to split four ways
        throw e;
      }
      shared++;
      const after = res.state;
      expect(after.subtotalMinor, `seed ${seed}`).toBe(o.subtotalMinor);
      expect(after.discountMinor, `seed ${seed}`).toBe(o.discountMinor);
      if (mode === 'tax_inclusive') expect(after.totalMinor, `seed ${seed}`).toBe(o.totalMinor);
      else
        expect(
          Math.abs(Number(after.totalMinor - o.totalMinor)),
          `seed ${seed}`,
        ).toBeLessThanOrEqual(parts - 1);
      const portions = after.lines.filter(
        (l) => l.metadata['sharedFromLineId'] === line.id || l.id === line.id,
      );
      expect(portions.reduce((a, l) => a + Number(l.quantity), 0)).toBeCloseTo(
        Number(line.quantity),
        4,
      );
      assertDbInvariants(after);
    }
    expect(shared).toBeGreaterThan(200);
  });

  it('an order discount allocates exactly: the line shares add up to the discount', () => {
    for (const seed of SEEDS) {
      const r = rng(seed * 31337);
      const ctx = makeCtx();
      let o = draft(ctx);
      const n = r.int(1, 7);
      for (let i = 0; i < n; i++)
        o = addLine(
          o,
          { snapshot: snapshot(`Item ${i}`, BigInt(r.int(1, 9999))), quantity: r.pick(QUANTITIES) },
          ctx,
        ).state;
      const gross = o.subtotalMinor;
      const res = applyDiscount(
        o,
        r.chance(0.5)
          ? { percent: String(r.int(1, 100)), description: 'p', appliedBy: 'u' }
          : { amountMinor: BigInt(r.int(1, Number(gross) * 2)), description: 'a', appliedBy: 'u' },
        ctx,
      ).state;
      const shares = res.lines.reduce((a, l) => a + l.discountMinor, 0n);
      expect(shares, `seed ${seed}`).toBe(res.discounts[0]!.amountMinor);
      expect(res.discountMinor).toBe(shares);
      expect(shares <= gross).toBe(true);
      expect(res.totalMinor).toBe(gross - shares);
    }
  });

  it('a paid-up order always completes and a completed order refunds to exactly what it took', () => {
    for (const seed of SEEDS) {
      const r = rng(seed * 15485863);
      const ctx = makeCtx();
      let o = draft(ctx, { kind: 'dine_in' });
      for (let i = 0; i < r.int(1, 5); i++)
        o = addLine(
          o,
          {
            snapshot: snapshot(`Item ${i}`, BigInt(r.int(1, 8000))),
            quantity: r.pick(QUANTITIES),
            seatNumber: r.int(1, 3),
          },
          ctx,
        ).state;
      if (r.chance(0.5))
        o = splitCheckBySeat(
          o,
          { fromCheckId: o.checks[0]!.id, seatNumbers: [r.pick(o.lines).seatNumber!] },
          ctx,
        ).state;
      o = place(o, { orderNumber: seed }, ctx).state;
      for (const c of o.checks.filter((k) => k.status === 'open' && k.totalMinor > 0n)) {
        const half = c.totalMinor / 2n;
        if (half > 0n)
          o = applyPayment(
            o,
            { checkId: c.id, amountMinor: half, paymentRef: `a-${c.id}` },
            ctx,
          ).state;
        o = applyPayment(
          o,
          { checkId: c.id, amountMinor: c.totalMinor - half, paymentRef: `b-${c.id}` },
          ctx,
        ).state;
      }
      o = markPaid(o, ctx).state;
      expect(o.paymentStatus).toBe('paid');
      expect(o.paidMinor).toBe(o.totalMinor);
      for (const c of o.checks.filter((k) => k.paidMinor > 0n))
        o = applyRefund(
          o,
          { checkId: c.id, amountMinor: c.paidMinor, paymentRef: `r-${c.id}` },
          ctx,
        ).state;
      expect(o.paymentStatus).toBe('refunded');
      expect(o.refundedMinor).toBe(o.paidMinor);
      assertDbInvariants(o);
    }
  });
});
