import { createRequire } from 'node:module';

import { expect, test, type Page } from '@playwright/test';
import { touch } from '@pos/ui';

import { enrol, enrolAndSignIn, scan, seed } from './helpers.js';

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[]; failureSummary?: string }[];
}

async function axe(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: axePath });
  return page.evaluate(async () => {
    const result = await (
      window as unknown as {
        axe: { run: (c: Document, o: object) => Promise<{ violations: AxeViolation[] }> };
      }
    ).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    });
    return result.violations;
  });
}

const describeViolations = (v: AxeViolation[]) =>
  v
    .map(
      (x) =>
        `${x.id} (${x.impact}): ${x.help}\n  ${x.nodes.map((n) => n.target.join(' ')).join('\n  ')}`,
    )
    .join('\n');

interface SizeProblem {
  element: string;
  width: number;
  height: number;
  need: string;
}

/**
 * Design-token touch targets (docs/04 §3.1): every interactive control is at least `touch.min`
 * (48) in both directions; tender buttons are `touch.tender` (72) high; keypad keys are `touch.key`
 * (64) square; destructive controls keep `touch.destructiveGap` (16) from their neighbours.
 */
async function touchTargetProblems(page: Page): Promise<SizeProblem[]> {
  return page.evaluate(
    ({ min, tender, key, gap }) => {
      const problems: { element: string; width: number; height: number; need: string }[] = [];
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          style.visibility !== 'hidden' &&
          !el.closest('[hidden]') &&
          !el.closest('[inert]')
        );
      };
      const name = (el: Element) =>
        `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`;
      const interactive = [
        ...document.querySelectorAll(
          'button, [role="button"], input:not([type="hidden"]), select, textarea, a[href], summary',
        ),
      ].filter(visible);
      const EPS = 0.5;
      for (const el of interactive) {
        const r = el.getBoundingClientRect();
        let needW = min;
        let needH = min;
        if (el.classList.contains('btn-tender')) needH = tender;
        if (el.classList.contains('btn-key')) {
          needW = key;
          needH = key;
        }
        if (r.width + EPS < needW || r.height + EPS < needH)
          problems.push({
            element: name(el),
            width: Math.round(r.width),
            height: Math.round(r.height),
            need: `${needW}x${needH}`,
          });
      }
      for (const el of interactive.filter((e) => e.hasAttribute('data-destructive'))) {
        const a = el.getBoundingClientRect();
        for (const other of interactive) {
          if (other === el) continue;
          const b = other.getBoundingClientRect();
          const dx = Math.max(b.left - a.right, a.left - b.right, 0);
          const dy = Math.max(b.top - a.bottom, a.top - b.bottom, 0);
          const distance = Math.hypot(dx, dy);
          if (distance + EPS < gap)
            problems.push({
              element: `${name(el)} too close to ${name(other)}`,
              width: Math.round(distance),
              height: 0,
              need: `gap ${gap}`,
            });
        }
      }
      return problems;
    },
    {
      min: touch.min as number,
      tender: touch.tender as number,
      key: touch.key as number,
      gap: touch.destructiveGap as number,
    },
  );
}

async function expectAccessible(page: Page) {
  const violations = await axe(page);
  expect(violations, describeViolations(violations)).toEqual([]);
  const problems = await touchTargetProblems(page);
  expect(problems, JSON.stringify(problems, null, 2)).toEqual([]);
}

const viewports = [
  { name: 'terminal 1920x1080', width: 1920, height: 1080 },
  { name: 'tablet landscape 1280x800', width: 1280, height: 800 },
  { name: 'tablet portrait 800x1280', width: 800, height: 1280 },
  { name: 'handheld 390x844', width: 390, height: 844 },
];

for (const vp of viewports) {
  test.describe(`accessibility and touch targets: ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('enrolment and PIN screens', async ({ page, request }) => {
      const s = await seed(request);
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Enrol this register' })).toBeVisible();
      await expectAccessible(page);
      await enrol(page, s);
      await expectAccessible(page);
    });

    test('shell with a cart, an open line action strip and the menu', async ({ page, request }) => {
      await enrolAndSignIn(page, request);
      await scan(page, '9300675024235');
      await scan(page, '9300675024273');
      await expect(page.getByRole('heading', { name: 'Cart (2 items)' })).toBeVisible();
      await expectAccessible(page);
      const hideCart = page.getByRole('button', { name: 'Hide cart' });
      if (await hideCart.isVisible()) {
        await hideCart.click();
        await expectAccessible(page);
        await page.getByRole('button', { name: 'Show cart' }).click();
      }
      await page
        .getByRole('button', { name: /^Oat Milk 1L/ })
        .first()
        .click();
      await expectAccessible(page);
      await page.getByRole('button', { name: '☰ Menu' }).click();
      await expectAccessible(page);
    });

    test('diagnostics', async ({ page, request }) => {
      await enrolAndSignIn(page, request);
      await page.getByRole('button', { name: '☰ Menu' }).click();
      await page.getByRole('button', { name: 'Diagnostics' }).click();
      await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
      await expectAccessible(page);
    });
  });
}

test.describe('layout variants', () => {
  test('terminal is two-pane with the cart on the left at 38 %', async ({ page, request }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await enrolAndSignIn(page, request);
    const cart = await page.locator('.cart-pane').boundingBox();
    const grid = await page.locator('.action-pane').boundingBox();
    expect(cart!.x).toBeLessThan(grid!.x);
    expect(Math.abs(cart!.width / 1920 - 0.38)).toBeLessThan(0.01);
    await expect(page.locator('.shell')).toHaveClass(/shell--terminal/);
  });

  test('tablet portrait stacks the cart over the grid and the cart collapses', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 800, height: 1280 });
    await enrolAndSignIn(page, request);
    await expect(page.locator('.shell')).toHaveClass(/shell--tablet-portrait/);
    const cart = await page.locator('.cart-pane').boundingBox();
    const grid = await page.locator('.action-pane').boundingBox();
    expect(cart!.y).toBeLessThan(grid!.y);
    await page.getByRole('button', { name: 'Hide cart' }).click();
    await expect(page.locator('#cart-body')).toBeHidden();
  });

  test('tablet landscape keeps the two panes', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await enrolAndSignIn(page, request);
    await expect(page.locator('.shell')).toHaveClass(/shell--tablet-landscape/);
    const cart = await page.locator('.cart-pane').boundingBox();
    const grid = await page.locator('.action-pane').boundingBox();
    expect(cart!.x).toBeLessThan(grid!.x);
  });

  test('handheld is a single column with a full-width tender button', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await enrolAndSignIn(page, request);
    await expect(page.locator('.shell')).toHaveClass(/shell--handheld/);
    const cart = await page.locator('.cart-pane').boundingBox();
    const grid = await page.locator('.action-pane').boundingBox();
    expect(cart!.y).toBeLessThan(grid!.y);
  });
});

test.describe('customer display', () => {
  test('is accessible with and without a cart', async ({ page, request, context }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await enrolAndSignIn(page, request);
    const cfd = await context.newPage();
    await cfd.setViewportSize({ width: 1280, height: 800 });
    await cfd.goto('/?mode=cfd');
    await expectAccessible(cfd);
    await scan(page, '9300675024235');
    await expect(cfd.getByRole('heading', { name: 'Your order' })).toBeVisible();
    await expectAccessible(cfd);
  });
});
