import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { runBackup } from './backup.ts';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run backup.test.ts');
}

describe('backup', () => {
  let scratchDir: string | undefined;

  afterEach(async () => {
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true });
      scratchDir = undefined;
    }
  });

  it('writes a timestamped custom-format dump and reports its size', async () => {
    scratchDir = await mkdtemp(path.join(os.tmpdir(), 'learn-backup-'));

    const result = await runBackup(connectionString!, { outDir: scratchDir, keep: 7 });

    expect(path.basename(result.file)).toMatch(/^learn-app-\d{8}-\d{6}\.dump$/);
    expect(existsSync(result.file)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.deletedFiles).toEqual([]);
  }, 30_000);

  it('prunes down to the newest N backups and never touches a file outside its own naming pattern', async () => {
    scratchDir = await mkdtemp(path.join(os.tmpdir(), 'learn-backup-'));

    // 9 fake backups at successive seconds, oldest first, plus one file that
    // matches nothing this tool is allowed to delete.
    for (let i = 0; i < 9; i++) {
      const name = `learn-app-20260101-0000${String(i).padStart(2, '0')}.dump`;
      await writeFile(path.join(scratchDir, name), 'x');
    }
    const decoy = 'not-a-backup.txt';
    await writeFile(path.join(scratchDir, decoy), 'keep me');

    // The real backup created here becomes the 10th, newest file — at
    // 000009, one second after the last fake — so with keep=3 exactly the
    // three newest (000007, 000008, 000009) should survive.
    const result = await runBackup(connectionString!, {
      outDir: scratchDir,
      keep: 3,
      now: new Date(2026, 0, 1, 0, 0, 9),
    });

    expect(result.deletedFiles).toHaveLength(7);

    const remaining = await readdir(scratchDir);
    const remainingBackups = remaining.filter((f) => f.endsWith('.dump')).sort();

    expect(remainingBackups).toEqual([
      'learn-app-20260101-000007.dump',
      'learn-app-20260101-000008.dump',
      'learn-app-20260101-000009.dump',
    ]);
    // The decoy file is untouched — retention only ever deletes files
    // matching its own naming pattern.
    expect(remaining).toContain(decoy);
  }, 30_000);
});
