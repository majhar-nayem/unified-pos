import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { formatDiffs, type GoldenCase, runGoldenCase } from './runner.js';

const goldenDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../golden');

const files = readdirSync(goldenDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('pricing golden files', () => {
  it('has the five Sprint 0 seed cases', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    const goldenCase = JSON.parse(readFileSync(join(goldenDir, file), 'utf8')) as GoldenCase;
    it(`${file}: ${goldenCase.name}`, () => {
      const result = runGoldenCase(goldenCase);
      expect(result.passed, `golden mismatch in ${file}\n${formatDiffs(result)}`).toBe(true);
    });
  }
});
