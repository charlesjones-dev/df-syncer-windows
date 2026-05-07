import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  atomicCopy,
  atomicDelete,
  atomicWrite,
  DEL_SUFFIX,
  TMP_SUFFIX
} from '../../src/main/sync/atomic';

/**
 * Each test gets its own temp dir so state from one case can never
 * leak into another. We never touch the user's real userData.
 */
describe('atomic primitives', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'df-syncer-windows-atomic-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('atomicWrite', () => {
    it('writes a Buffer to the target with no leftover .tmp', async () => {
      const target = path.join(tmp, 'hello.txt');
      await atomicWrite(target, Buffer.from('hello world'));

      await expect(fs.readFile(target, 'utf8')).resolves.toBe('hello world');
      await expect(fs.access(target + TMP_SUFFIX)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('writes a Readable stream to the target', async () => {
      const target = path.join(tmp, 'streamed.bin');
      const payload = Buffer.from('chunk-1+chunk-2+chunk-3');
      await atomicWrite(target, Readable.from([payload.subarray(0, 8), payload.subarray(8)]));

      const onDisk = await fs.readFile(target);
      expect(onDisk.equals(payload)).toBe(true);
      await expect(fs.access(target + TMP_SUFFIX)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('replaces an existing file at the target path', async () => {
      const target = path.join(tmp, 'replace.txt');
      await fs.writeFile(target, 'old');
      await atomicWrite(target, Buffer.from('new'));
      await expect(fs.readFile(target, 'utf8')).resolves.toBe('new');
    });

    it('cleans up a stale .tmp leftover from a previous crash', async () => {
      const target = path.join(tmp, 'recover.txt');
      // Simulate crash artefact.
      await fs.writeFile(target + TMP_SUFFIX, 'half-written-bytes');
      await atomicWrite(target, Buffer.from('clean-write'));
      await expect(fs.readFile(target, 'utf8')).resolves.toBe('clean-write');
      await expect(fs.access(target + TMP_SUFFIX)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not leave a half-written target if the stream errors mid-write', async () => {
      const target = path.join(tmp, 'crashy.txt');

      // A Readable that emits one chunk and then errors. The error
      // should propagate, the target must not exist (it never got
      // renamed), and the .tmp must be cleaned up.
      const source = new Readable({
        read() {
          this.push(Buffer.from('first-chunk'));
          process.nextTick(() => this.destroy(new Error('simulated mid-stream failure')));
        }
      });

      await expect(atomicWrite(target, source)).rejects.toThrow(/simulated mid-stream failure/);

      await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(target + TMP_SUFFIX)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('atomicCopy', () => {
    it('copies a file via temp + rename', async () => {
      const src = path.join(tmp, 'src.bin');
      const dst = path.join(tmp, 'sub', 'dst.bin');
      await fs.mkdir(path.dirname(dst), { recursive: true });
      const payload = Buffer.from('the quick brown fox');
      await fs.writeFile(src, payload);

      await atomicCopy(src, dst);

      const copied = await fs.readFile(dst);
      expect(copied.equals(payload)).toBe(true);
      // Source intact.
      const original = await fs.readFile(src);
      expect(original.equals(payload)).toBe(true);
      await expect(fs.access(dst + TMP_SUFFIX)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('overwrites an existing destination', async () => {
      const src = path.join(tmp, 'src.txt');
      const dst = path.join(tmp, 'dst.txt');
      await fs.writeFile(src, 'fresh');
      await fs.writeFile(dst, 'stale');
      await atomicCopy(src, dst);
      await expect(fs.readFile(dst, 'utf8')).resolves.toBe('fresh');
    });
  });

  describe('atomicDelete', () => {
    it('removes the target via .del rename', async () => {
      const target = path.join(tmp, 'gone.txt');
      await fs.writeFile(target, 'bye');
      await atomicDelete(target);
      await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(target + DEL_SUFFIX)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('is a no-op when the target does not exist', async () => {
      const target = path.join(tmp, 'never.txt');
      await expect(atomicDelete(target)).resolves.toBeUndefined();
    });

    it('cleans up a stale .del before re-renaming', async () => {
      const target = path.join(tmp, 'twice.txt');
      await fs.writeFile(target, 'present');
      await fs.writeFile(target + DEL_SUFFIX, 'leftover');
      await atomicDelete(target);
      await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(target + DEL_SUFFIX)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('rename retry on transient EPERM', () => {
    /**
     * We can't reliably hold a Windows file handle open in another
     * process from a single Vitest run. Instead we mock `fs.rename`
     * to fail twice with EPERM and succeed on the third attempt; the
     * test passes if `atomicWrite` ultimately writes the target.
     *
     * The verbal contract is documented at the top of `atomic.ts`:
     * three retries, 100 ms backoff each, then surface the error.
     */
    it('retries the rename on EPERM and eventually succeeds', async () => {
      const target = path.join(tmp, 'flaky.txt');
      const realRename = fs.rename;
      let attempts = 0;
      const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('simulated EPERM') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        return realRename(from, to);
      });
      try {
        await atomicWrite(target, Buffer.from('eventually'));
        expect(attempts).toBe(3);
        await expect(fs.readFile(target, 'utf8')).resolves.toBe('eventually');
      } finally {
        spy.mockRestore();
      }
    });

    it('surfaces the error after exhausting retries', async () => {
      const target = path.join(tmp, 'never-renames.txt');
      const spy = vi.spyOn(fs, 'rename').mockImplementation(async () => {
        const err = new Error('persistent EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });
      try {
        await expect(atomicWrite(target, Buffer.from('x'))).rejects.toMatchObject({
          code: 'EPERM'
        });
      } finally {
        spy.mockRestore();
      }
    });

    it('does not retry on non-transient codes', async () => {
      const target = path.join(tmp, 'no-retry.txt');
      let attempts = 0;
      const spy = vi.spyOn(fs, 'rename').mockImplementation(async () => {
        attempts++;
        const err = new Error('hard fail') as NodeJS.ErrnoException;
        err.code = 'EROFS';
        throw err;
      });
      try {
        await expect(atomicWrite(target, Buffer.from('y'))).rejects.toMatchObject({
          code: 'EROFS'
        });
        expect(attempts).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
