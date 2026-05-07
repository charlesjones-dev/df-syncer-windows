/**
 * Phase 2 verification helper.
 *
 * Run: `pnpm exec tsx scripts/verify-ipc-roundtrip.ts`
 *
 * Exercises the same code paths the IPC `config:get` and `config:save`
 * handlers run through (`ConfigStore.get` / `ConfigStore.save`) in
 * isolation. Used to confirm the round-trip without spinning up the
 * full Electron app + DevTools dance.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ConfigStore } from '../src/main/store';

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'df-syncer-windows-verify-ipc-'));
  try {
    const store = new ConfigStore({ cwd: tmp });
    // eslint-disable-next-line no-console
    console.log('initial config.machineId =', store.get().machineId);
    // eslint-disable-next-line no-console
    console.log('initial isFirstRun       =', store.isFirstRun());

    const next = store.save({ machineId: 'test' });
    // eslint-disable-next-line no-console
    console.log('after save({machineId:"test"}).machineId =', next.machineId);

    const reread = store.get();
    // eslint-disable-next-line no-console
    console.log('reread .machineId =', reread.machineId);
    // eslint-disable-next-line no-console
    console.log('store path        =', store.path);

    if (reread.machineId !== 'test') {
      throw new Error('round-trip failed: machineId did not persist');
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('verify-ipc-roundtrip failed:', err);
  process.exit(1);
});
