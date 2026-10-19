import { useEffect, useState } from 'react';

import { formatMinor } from '../cart/cart.js';
import { openCfdChannel, type CfdMessage, type CfdTransport } from '../cfd/channel.js';

/** Customer-facing display: read-only mirror of the register's cart (docs/04 §4.6). Works offline. */
export function CfdView({ transport }: { transport?: CfdTransport | null }) {
  const [message, setMessage] = useState<CfdMessage>({ type: 'idle' });
  useEffect(() => {
    const channel =
      transport ?? (typeof BroadcastChannel === 'undefined' ? null : openCfdChannel());
    if (!channel) return undefined;
    channel.onmessage = (event) => setMessage(event.data);
    return () => {
      channel.onmessage = null;
      if (!transport) channel.close();
    };
  }, [transport]);

  return (
    <main className="cfd" aria-label="Customer display">
      <h1 style={{ fontSize: 40 }}>{message.type === 'cart' ? 'Your order' : 'Welcome'}</h1>
      {message.type === 'cart' ? (
        <ul className="cfd-lines" aria-label="Items">
          {message.lines.map((l, i) => (
            <li key={`${l.name}-${i}`}>
              <span>
                {l.name} <span className="muted">× {l.quantity}</span>
              </span>
              <span>{formatMinor(l.totalMinor, message.currency)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted" style={{ fontSize: 28 }}>
          Your items will appear here as they are scanned.
        </p>
      )}
      <div aria-live="polite">
        {message.type === 'cart' ? (
          <p className="cfd-total" aria-label="Total">
            {formatMinor(message.totalMinor, message.currency)}
          </p>
        ) : null}
      </div>
    </main>
  );
}
