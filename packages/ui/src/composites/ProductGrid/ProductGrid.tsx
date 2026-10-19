import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

import { cx } from '../../foundation/cx.js';
import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import { Button } from '../../primitives/Button/Button.js';
import { ProductTile, type ProductTileProps } from '../ProductTile/ProductTile.js';

export interface ProductGridItem extends Omit<
  ProductTileProps,
  'id' | 'productId' | 'onSelect' | 'selected' | 'ref' | 'tabIndex'
> {
  /** Product id; passed to `onSelect`. */
  readonly id: string;
}

export interface ProductGridProps {
  readonly products: readonly ProductGridItem[];
  /** Tiles per page. Omit to show everything on one page (no pager). */
  readonly pageSize?: number;
  /** 1-based current page (controlled). */
  readonly page?: number;
  readonly defaultPage?: number;
  readonly onPageChange?: (page: number) => void;
  /**
   * Fixed column count. Omit for the responsive default set in CSS: 3 columns, 4 from 480 px, 5 from 800 px,
   * 6 from 1366 px, 8 from 1920 px (tokens/core.json breakpoints).
   */
  readonly columns?: number;
  readonly selectedId?: string | null;
  readonly onSelect?: (productId: string) => void;
  /** Group name; defaults to "Products". */
  readonly label?: string;
  /** Replaces the default empty-state text. */
  readonly emptyState?: ReactNode;
  readonly className?: string;
  readonly ref?: Ref<HTMLDivElement>;
}

function measureColumns(tiles: HTMLElement | null, count: number): number {
  if (!tiles) return 1;
  const tracks = getComputedStyle(tiles).gridTemplateColumns.trim();
  if (/^[\d.]+px(\s+[\d.]+px)*$/.test(tracks)) return tracks.split(/\s+/).length;
  // Fallback when computed tracks are unavailable: count tiles on the first row.
  const items = Array.from(tiles.children) as HTMLElement[];
  const first = items[0];
  if (!first) return 1;
  const sameRow = items.filter((el) => el.offsetTop === first.offsetTop).length;
  return Math.max(1, Math.min(sameRow, count));
}

/**
 * Paged product grid with a roving-tabindex: one Tab stop, arrow keys move between tiles, Home/End jump to
 * the first/last tile, PageUp/PageDown change pages. Arrow Left/Right continue onto the neighbouring page.
 */
export function ProductGrid({
  products,
  pageSize,
  page: pageProp,
  defaultPage = 1,
  onPageChange,
  columns,
  selectedId,
  onSelect,
  label,
  emptyState,
  className,
  ref,
}: ProductGridProps) {
  const { t, format } = useUi();
  const [internalPage, setInternalPage] = useState(defaultPage);
  const [activeIndex, setActiveIndex] = useState(0);
  const tilesRef = useRef<HTMLDivElement>(null);
  const pendingTileFocus = useRef<number | null>(null);
  const pendingPagerFocus = useRef<'prev' | 'next' | null>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const size = pageSize && pageSize > 0 ? Math.floor(pageSize) : Math.max(1, products.length);
  const pageCount = Math.max(1, Math.ceil(products.length / size));
  const requested = pageProp ?? internalPage;
  const page = Math.min(pageCount, Math.max(1, requested));
  const start = (page - 1) * size;
  const visible = products.slice(start, start + size);
  const active = Math.min(activeIndex, Math.max(0, visible.length - 1));

  const goToPage = (next: number) => {
    const clamped = Math.min(pageCount, Math.max(1, next));
    if (clamped === page) return;
    if (pageProp === undefined) setInternalPage(clamped);
    setActiveIndex(0);
    onPageChange?.(clamped);
  };

  useEffect(() => {
    if (pendingTileFocus.current !== null) {
      const index = pendingTileFocus.current;
      pendingTileFocus.current = null;
      tilesRef.current?.querySelector<HTMLElement>(`[data-product-index="${index}"]`)?.focus();
    }
    if (pendingPagerFocus.current) {
      const target = pendingPagerFocus.current === 'prev' ? prevRef.current : nextRef.current;
      pendingPagerFocus.current = null;
      target?.focus();
    }
  }, [page]);

  const focusTile = (index: number) => {
    setActiveIndex(index);
    tilesRef.current?.querySelector<HTMLElement>(`[data-product-index="${index}"]`)?.focus();
  };

  const onTileKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = visible.length - 1;
    const cols = columns ?? measureColumns(tilesRef.current, visible.length);
    let handled = true;
    switch (event.key) {
      case 'ArrowRight':
        if (index < last) focusTile(index + 1);
        else if (page < pageCount) {
          pendingTileFocus.current = 0;
          goToPage(page + 1);
        }
        break;
      case 'ArrowLeft':
        if (index > 0) focusTile(index - 1);
        else if (page > 1) {
          pendingTileFocus.current = size - 1;
          goToPage(page - 1);
        }
        break;
      case 'ArrowDown':
        if (index + cols <= last) focusTile(index + cols);
        break;
      case 'ArrowUp':
        if (index - cols >= 0) focusTile(index - cols);
        break;
      case 'Home':
        focusTile(0);
        break;
      case 'End':
        focusTile(last);
        break;
      case 'PageDown':
        if (page < pageCount) {
          pendingTileFocus.current = 0;
          goToPage(page + 1);
        }
        break;
      case 'PageUp':
        if (page > 1) {
          pendingTileFocus.current = 0;
          goToPage(page - 1);
        }
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  const tileStyle = columns
    ? ({ '--pos-product-grid-columns': String(Math.max(1, Math.floor(columns))) } as CSSProperties)
    : undefined;

  if (products.length === 0) {
    return (
      <div ref={ref} className={cx('pos-product-grid', className)}>
        <p className="pos-product-grid__empty">{emptyState ?? t('productGrid.empty')}</p>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label ?? t('productGrid.label')}
      className={cx('pos-product-grid', className)}
    >
      <div ref={tilesRef} className="pos-product-grid__tiles" style={tileStyle}>
        {visible.map(({ id, ...tile }, index) => (
          <ProductTile
            key={id}
            {...tile}
            productId={id}
            selected={selectedId === id}
            tabIndex={index === active ? 0 : -1}
            data-product-index={index}
            onFocus={() => setActiveIndex(index)}
            onKeyDown={(event) => onTileKeyDown(event, index)}
            {...(onSelect ? { onSelect } : {})}
          />
        ))}
      </div>
      {pageCount > 1 ? (
        <nav className="pos-product-grid__pager" aria-label={t('productGrid.pager')}>
          <Button
            ref={prevRef}
            variant="secondary"
            aria-label={t('productGrid.previousPage')}
            disabled={page <= 1}
            onClick={() => {
              if (page - 1 <= 1) pendingPagerFocus.current = 'next';
              goToPage(page - 1);
            }}
            iconStart={<Icon name="chevron-left" />}
          >
            <span className="pos-sr-only">{t('productGrid.previousPage')}</span>
          </Button>
          <span role="status" className="pos-product-grid__indicator pos-num">
            {t('productGrid.pageIndicator', {
              page: format.number(page),
              pages: format.number(pageCount),
            })}
          </span>
          <Button
            ref={nextRef}
            variant="secondary"
            aria-label={t('productGrid.nextPage')}
            disabled={page >= pageCount}
            onClick={() => {
              if (page + 1 >= pageCount) pendingPagerFocus.current = 'prev';
              goToPage(page + 1);
            }}
            iconStart={<Icon name="chevron-right" />}
          >
            <span className="pos-sr-only">{t('productGrid.nextPage')}</span>
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
