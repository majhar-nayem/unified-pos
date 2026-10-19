// Concatenates tokens.css, base.css and every component stylesheet into dist/styles.css.
// Apps import it once: `import '@pos/ui/styles.css'`.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const all = walk(src).filter((f) => f.endsWith('.css'));
const first = [join(src, 'styles/tokens.css'), join(src, 'styles/base.css')];
const rest = all.filter((f) => !first.includes(f)).sort();
const files = [...first, ...rest];

const css = files
  .map((f) => `/* ${relative(src, f)} */\n${readFileSync(f, 'utf8').trim()}\n`)
  .join('\n');

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/styles.css'), css);
console.log(`wrote dist/styles.css (${files.length} files, ${css.length} bytes)`);
