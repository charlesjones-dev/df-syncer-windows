/**
 * Phase 2 verification helper.
 *
 * Run: `pnpm exec tsx scripts/verify-detect.ts`
 *
 * Prints the result of `detectGameFolder()` against the user's actual
 * machine. Used to confirm the auto-detect path during phase rollout
 * without spinning up the full Electron app.
 */
import { detectGameFolder } from '../src/main/paths';

async function main(): Promise<void> {
  const result = await detectGameFolder();
  // eslint-disable-next-line no-console
  console.log('detectGameFolder() →', result ?? '(not found)');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('verify-detect failed:', err);
  process.exit(1);
});
