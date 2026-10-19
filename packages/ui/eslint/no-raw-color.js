// Forbids raw colour literals (hex, rgb(), hsl() and friends) outside the generated tokens module.
// docs/04-design-plan.md section 8: tokens are the only source of colour in every app.
const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/i;
const FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;

/** @type {import('eslint').Rule.RuleModule} */
export const noRawColor = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid raw colour values; use design tokens (vars.color.*, var(--pos-color-*)).',
    },
    schema: [],
    messages: {
      raw: 'Raw colour "{{value}}" is not allowed. Use a design token from @pos/ui (tokens/*.json).',
    },
  },
  create(context) {
    /** @param {import('estree').Node} node @param {string} text */
    function inspect(node, text) {
      const match = HEX.exec(text) ?? FUNCTION.exec(text);
      if (match) context.report({ node, messageId: 'raw', data: { value: match[0] } });
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') inspect(node, node.value);
      },
      TemplateElement(node) {
        inspect(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};
