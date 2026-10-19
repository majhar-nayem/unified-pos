import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';

import {
  toCategory,
  toProduct,
  type PosCategory,
  type PosProduct,
} from '../catalog/placeholder.js';
import { formatMinor } from '../cart/cart.js';
import { useServices } from '../app/services.js';
import type { ScanOutcome } from '../cart/scan.js';
import { Button } from '../ui/primitives.js';

export function useCatalog(): { products: PosProduct[]; categories: PosCategory[] } {
  const { store, sync } = useServices();
  const status = useSyncExternalStore(sync.subscribe, sync.getStatus);
  const [data, setData] = useState<{ products: PosProduct[]; categories: PosCategory[] }>({
    products: [],
    categories: [],
  });
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      store.replicas.list('catalog', 'variant'),
      store.replicas.list('catalog', 'category'),
    ]).then(([variants, cats]) => {
      if (cancelled) return;
      setData({
        products: variants.map(toProduct).filter((p): p is PosProduct => p !== null),
        categories: cats.map(toCategory).filter((c): c is PosCategory => c !== null),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [store, status.replica, status.lastSyncAt]);
  return data;
}

/** Search (scan target), category tabs and the placeholder product grid (docs/04 §4.1 right pane). */
export function ProductPane({
  onResult,
  searchRef,
}: {
  onResult: (outcome: ScanOutcome) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
}) {
  const { scan, currency } = useServices();
  const { products, categories } = useCatalog();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const localRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter(
      (p) =>
        (category === null || p.categoryId === category) &&
        (q === '' || p.name.toLowerCase().includes(q)),
    );
  }, [products, category, query]);

  async function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || query.trim() === '') return;
    const outcome = await scan.handleScan(query);
    if (outcome.ok || outcome.reason === 'needs_weight') {
      onResult(outcome);
      setQuery('');
    } else if (visible.length === 1 && visible[0]) {
      onResult(await scan.add(visible[0]));
      setQuery('');
    } else onResult(outcome);
  }

  return (
    <section className="action-pane" aria-label="Products">
      <div>
        <label htmlFor="product-search" className="sr-only">
          Scan or search products
        </label>
        <input
          id="product-search"
          ref={(el) => {
            (localRef as { current: HTMLInputElement | null }).current = el;
            (searchRef as { current: HTMLInputElement | null }).current = el;
          }}
          data-scan-target
          type="search"
          placeholder="🔍 Scan or search products…  [F2]"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => void onKeyDown(e)}
        />
      </div>

      <div className="categories" role="group" aria-label="Categories">
        <Button aria-pressed={category === null} onClick={() => setCategory(null)}>
          All
        </Button>
        {categories.map((c) => (
          <Button key={c.id} aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
            {c.name}
          </Button>
        ))}
      </div>

      <div className="product-grid" role="list" aria-label="Product grid">
        {visible.length === 0 ? <p className="muted">No products match.</p> : null}
        {visible.map((p) => (
          <div role="listitem" key={p.variantId} style={{ display: 'contents' }}>
            <Button className="tile" onClick={() => void scan.add(p).then(onResult)}>
              <span>{p.name}</span>
              <span className="price">
                {p.soldBy === 'weight'
                  ? `${formatMinor(p.priceMinor, currency)} /kg`
                  : formatMinor(p.priceMinor, currency)}
              </span>
            </Button>
          </div>
        ))}
      </div>

      <div className="action-strip" role="group" aria-label="Order actions">
        {['Qty', 'Discount', 'Price ▲', 'Note', 'Customer', 'Returns', 'Gift card', 'Lookup'].map(
          (label) => (
            <Button
              key={label}
              disabled
              title="Arrives with the checkout slice (F6b) and the price engine (F3)"
            >
              {label}
            </Button>
          ),
        )}
      </div>
    </section>
  );
}
