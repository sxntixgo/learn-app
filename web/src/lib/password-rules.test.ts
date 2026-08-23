import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { MIN_PASSWORD_LENGTH } from './password-rules.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const contract = readFileSync(path.join(repoRoot, 'openapi', 'openapi.yaml'), 'utf8');

describe('the form’s password rule matches the contract', () => {
  it('reads a minLength out of the change-password request body', () => {
    // If this stops finding one, every assertion below is vacuous — the
    // contract could have dropped the constraint entirely and the form would
    // keep enforcing a number nothing backs.
    const body = contract.slice(contract.indexOf('/api/v1/auth/password:'));
    const newPassword = body.slice(body.indexOf('newPassword:'), body.indexOf('newPassword:') + 400);
    const declared = /minLength:\s*(\d+)/.exec(newPassword)?.[1];

    expect(declared, 'no minLength on newPassword in openapi.yaml').toBeDefined();
    expect(Number(declared)).toBe(MIN_PASSWORD_LENGTH);
  });

  it('is the number the form actually shows and enforces', () => {
    // Both the `minLength` attribute and the visible hint come from this
    // constant, so a drift shows up as a browser that submits what the server
    // refuses.
    const form = readFileSync(path.join(repoRoot, 'web', 'app', 'settings', 'account', 'ChangePasswordForm.tsx'), 'utf8');
    expect(form).toContain('MIN_PASSWORD_LENGTH');
    expect(form, 'the form should not hardcode the number beside the constant').not.toMatch(/minLength=\{\d+\}/);
  });
});
