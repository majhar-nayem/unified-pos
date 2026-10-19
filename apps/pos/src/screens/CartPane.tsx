import { useEffect, useState, useSyncExternalStore } from 'react';

import { cartSubtotalMinor, formatMinor, itemCount, lineTotalMinor } from '../cart/cart.js';
import { useServices } from '../app/services.js';
import { Button } from '../ui/primitives.js';

/** Cart pane: lines, inline line actions, placeholder totals. Pricing and tax arrive with F3/F4 (stubbed). */
export function CartPane({
  collapsible,
  collapsed,
  onToggle,
}: {
  collapsible: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { cart: service, currency } = useServices();
  const cart = useSyncExternalStore(service.subscribe, service.getCart);
  const lastAdded = useSyncExternalStore(service.subscribe, service.getLastAddedLineId);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const count = itemCount(cart);
  const subtotal = cartSubtotalMinor(cart);

  useEffect(() => {
    if (!lastAdded) return undefined;
    setHighlight(lastAdded);
    const t = setTimeout(() => setHighlight(null), 1500); // last-added line stays highlighted 1.5 s
    return () => clearTimeout(t);
  }, [lastAdded, cart.lines.length]);

  useEffect(() => {
    if (!confirmVoid) return undefined;
    const t = setTimeout(() => setConfirmVoid(false), 3000);
    return () => clearTimeout(t);
  }, [confirmVoid]);

  return (
    <section className="cart-pane" aria-labelledby="cart-title">
      <div className="cart-head">
        <h2 id="cart-title">
          Cart ({count} {count === 1 ? 'item' : 'items'})
        </h2>
        <div className="row">
          {collapsible ? (
            <Button
              className="cart-toggle"
              aria-expanded={!collapsed}
              aria-controls="cart-body"
              onClick={onToggle}
            >
              {collapsed ? 'Show cart' : 'Hide cart'}
            </Button>
          ) : null}
          <Button
            variant={confirmVoid ? 'danger' : 'default'}
            data-destructive
            disabled={cart.lines.length === 0}
            onClick={() => {
              if (!confirmVoid) return setConfirmVoid(true);
              setConfirmVoid(false);
              setSelected(null);
              void service.voidCart();
            }}
          >
            {confirmVoid ? 'Tap again to void' : 'Void order'}
          </Button>
        </div>
      </div>

      <div
        id="cart-body"
        hidden={collapsible && collapsed}
        style={{ overflow: 'auto', minHeight: 0 }}
      >
        {cart.lines.length === 0 ? (
          <p className="cart-empty">Scan an item or tap a product to start the sale.</p>
        ) : (
          <ul className="cart-lines" aria-label="Order lines">
            {cart.lines.map((line) => (
              <li
                key={line.lineId}
                className={`cart-line ${highlight === line.lineId ? 'is-new' : ''}`}
              >
                <button
                  type="button"
                  aria-expanded={selected === line.lineId}
                  onClick={() => setSelected((s) => (s === line.lineId ? null : line.lineId))}
                >
                  <span>{line.name}</span>
                  <span className="num">{formatMinor(lineTotalMinor(line), currency)}</span>
                  <span className="meta">
                    {line.soldBy === 'weight'
                      ? `${line.quantity} kg @ ${formatMinor(line.unitPriceMinor, currency)}/kg`
                      : `${line.quantity} × ${formatMinor(line.unitPriceMinor, currency)}`}
                  </span>
                </button>
                {selected === line.lineId ? (
                  <div
                    className="line-actions"
                    role="group"
                    aria-label={`Actions for ${line.name}`}
                  >
                    <Button disabled title="Quantity edit arrives with checkout (F6b)">
                      Qty
                    </Button>
                    <Button disabled title="Discounts arrive with the price engine (F3)">
                      Discount
                    </Button>
                    <Button
                      variant="danger"
                      data-destructive
                      onClick={() => {
                        setSelected(null);
                        void service.removeLine(line.lineId);
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="totals" aria-label="Order totals">
        <div className="line">
          <span>Subtotal</span>
          <span>{formatMinor(subtotal, currency)}</span>
        </div>
        <div className="line muted">
          <span>Discounts</span>
          <span>—</span>
        </div>
        <div className="line muted">
          <span>Tax</span>
          <span>—</span>
        </div>
        <div className="line grand">
          <span>TOTAL</span>
          <span>{formatMinor(subtotal, currency)}</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Placeholder: list prices only. The price engine is not connected yet.
        </p>
      </div>
    </section>
  );
}
