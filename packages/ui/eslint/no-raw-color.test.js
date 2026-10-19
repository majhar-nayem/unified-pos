import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';

import { noRawColor } from './no-raw-color.js';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

tester.run('no-raw-color', noRawColor, {
  valid: [
    "const a = 'var(--pos-color-text)';",
    'const b = <div className="pos-card" id="main" />;',
    "const c = 'jump to #main';",
    'const d = `translate(${x}px)`;',
    'const e = \'href="#content"\';',
  ],
  invalid: [
    { code: "const a = '#fff';", errors: [{ messageId: 'raw' }] },
    { code: "const a = '#1D4ED8';", errors: [{ messageId: 'raw' }] },
    { code: "const a = '#1d4ed8cc';", errors: [{ messageId: 'raw' }] },
    { code: "const a = '1px solid #e2e8f0';", errors: [{ messageId: 'raw' }] },
    { code: 'const a = <div style={{ color: "#000000" }} />;', errors: [{ messageId: 'raw' }] },
    { code: 'const a = `border: 1px solid #abc`;', errors: [{ messageId: 'raw' }] },
    { code: "const a = 'rgb(0 0 0 / 0.5)';", errors: [{ messageId: 'raw' }] },
    { code: "const a = 'hsl(10, 20%, 30%)';", errors: [{ messageId: 'raw' }] },
  ],
});
