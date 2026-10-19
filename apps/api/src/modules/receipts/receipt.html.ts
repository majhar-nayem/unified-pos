import type { orders } from '@pos/domain-core';

const esc = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * Standard receipt template (key `receipt.standard`) as a self-contained HTML document: 80 mm
 * column, inline CSS, no external requests, so it prints from a browser and mails as-is. Every
 * dynamic string is escaped. The tax breakdown shows, for inclusive pricing, the GST contained in
 * the total and the taxable amount per rate.
 */
export function renderReceiptHtml(m: orders.ReceiptModel): string {
  const row = (left: string, right: string, cls = '') =>
    `<tr class="${cls}"><td>${esc(left)}</td><td class="r">${esc(right)}</td></tr>`;
  const lines = m.lines
    .map((l) => {
      const qty = l.quantity === '1' ? '' : `${esc(l.quantity)} × `;
      const mods = l.modifiers
        .map(
          (x) =>
            `<tr class="sub"><td>+ ${esc(x.name)}</td><td class="r">${x.delta ? esc(x.delta.text) : ''}</td></tr>`,
        )
        .join('');
      const unit =
        l.quantity !== '1' && !l.isReturn
          ? `<tr class="sub"><td>@ ${esc(l.unitPrice.text)} each</td><td></td></tr>`
          : '';
      const disc = l.discount
        ? `<tr class="sub"><td>Discount</td><td class="r">${esc(l.discount.text)}</td></tr>`
        : '';
      const note = l.note ? `<tr class="sub"><td colspan="2">Note: ${esc(l.note)}</td></tr>` : '';
      return `<tr class="${l.isReturn ? 'ret' : ''}"><td>${qty}${esc(l.name)}</td><td class="r">${esc(l.total.text)}</td></tr>${unit}${mods}${disc}${note}`;
    })
    .join('');
  const totals = [
    row('Subtotal', m.subtotal.text),
    ...m.discounts.map((d) => row(d.description, d.amount.text)),
    ...(m.discounts.length === 0 && m.discountTotal.minor !== 0n
      ? [row('Discounts', m.discountTotal.text)]
      : []),
    ...m.charges.map((c) => row(c.description, c.amount.text)),
    ...(m.pricing === 'exclusive' && m.taxTotal.minor !== 0n ? [row('Tax', m.taxTotal.text)] : []),
    ...(m.tip ? [row('Tip', m.tip.text)] : []),
    ...(m.rounding ? [row('Rounding', m.rounding.text)] : []),
    row('TOTAL', m.total.text, 'total'),
    ...(m.paid.minor !== 0n ? [row('Paid', m.paid.text)] : []),
    ...(m.due.minor !== 0n ? [row('Amount due', m.due.text, 'total')] : []),
    ...(m.refunded ? [row('Refunded', m.refunded.text)] : []),
  ].join('');
  const gst = m.tax.find((t) => t.tax.minor !== 0n)?.name ?? m.tax[0]?.name ?? 'tax';
  const taxBlock =
    m.tax.length === 0
      ? ''
      : `<table class="tax"><caption>${
          m.pricing === 'inclusive' && m.taxTotal.minor !== 0n
            ? `Total includes ${esc(gst)} ${esc(m.taxTotal.text)}`
            : 'Tax summary'
        }</caption><thead><tr><th>Tax</th><th class="r">Taxable</th><th class="r">Tax</th></tr></thead><tbody>${m.tax
          .map(
            (t) =>
              `<tr><td>${esc(t.name)}${t.rate ? ` ${esc(t.rate)}` : ''}</td><td class="r">${esc(t.taxable.text)}</td><td class="r">${esc(t.tax.text)}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  const banner =
    m.kind === 'reprint'
      ? `<p class="banner">*** REPRINT${m.copyNumber ? ` - COPY ${m.copyNumber}` : ''} ***</p>`
      : m.kind === 'proforma'
        ? '<p class="banner">NOT A TAX INVOICE</p>'
        : m.kind === 'void' || m.title === 'Void'
          ? '<p class="banner">*** ORDER VOIDED ***</p>'
          : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.title)} ${esc(m.number)}</title>
<style>
  body { font: 13px/1.35 ui-monospace, Menlo, Consolas, monospace; margin: 0; background: #fff; color: #000; }
  main { width: 302px; margin: 0 auto; padding: 12px 8px; }
  h1 { font-size: 16px; margin: 0; text-align: center; } h2 { font-size: 14px; text-align: center; margin: 8px 0 2px; letter-spacing: .06em; }
  p { margin: 2px 0; text-align: center; } .banner { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; } td, th { padding: 1px 0; vertical-align: top; } .r { text-align: right; white-space: nowrap; padding-left: 8px; }
  .sub td { color: #333; padding-left: 10px; } .ret td { font-weight: 700; } .total td { font-weight: 700; font-size: 15px; border-top: 1px solid #000; }
  hr { border: 0; border-top: 1px dashed #000; margin: 8px 0; } .tax caption { text-align: left; font-weight: 700; margin-bottom: 2px; } .tax th { text-align: left; font-weight: 400; border-bottom: 1px solid #000; }
  .legal { font-size: 11px; }
  @media print { main { width: auto; } }
</style></head>
<body><main>
<h1>${esc(m.businessName)}</h1>
${m.locationName !== m.businessName ? `<p>${esc(m.locationName)}</p>` : ''}
${m.addressLines.map((l) => `<p>${esc(l)}</p>`).join('')}
${m.taxRegistration ? `<p>ABN ${esc(m.taxRegistration)}</p>` : ''}
${m.header ? `<p>${esc(m.header)}</p>` : ''}
<hr><h2>${esc(m.title.toUpperCase())}</h2>${banner}
<table>${row('Receipt', m.number)}${row('Order', `#${m.orderNumber}${m.checkNumber ? ` check ${m.checkNumber}` : ''}`)}${m.clientOrderRef ? row('Register ref', m.clientOrderRef) : ''}${row('Date', m.issuedAt)}</table>
<hr><table>${lines}</table>
<hr><table>${totals}</table>
${taxBlock ? `<hr>${taxBlock}` : ''}
${m.legalText ? `<hr><p class="legal">${esc(m.legalText)}</p>` : ''}
</main></body></html>
`;
}
