import { describe, expect, it } from 'vitest';
import { REDACTED, createRedactor, redact } from './redact';

describe('redact', () => {
  it('replaces sensitive keys at any depth, case-insensitively', () => {
    const input = {
      call: 'ListarProdutos',
      app_key: '123',
      APP_SECRET: 'abc',
      param: [{ pagina: 1, nested: { password: 'x', Authorization: 'Bearer t' } }],
      headers: { cookie: 'sid=1', 'set-cookie': ['a'], 'x-api-key': 'k' },
    };
    expect(redact(input)).toEqual({
      call: 'ListarProdutos',
      app_key: REDACTED,
      APP_SECRET: REDACTED,
      param: [{ pagina: 1, nested: { password: REDACTED, Authorization: REDACTED } }],
      headers: { cookie: REDACTED, 'set-cookie': REDACTED, 'x-api-key': REDACTED },
    });
  });

  it('covers token, api_key and provider key names', () => {
    const out = redact({
      token: 't',
      session_token: 's',
      api_key: 'a',
      openai_api_key: 'o',
      ANTHROPIC_API_KEY: 'n',
      sessionSecret: 'z',
      confirmationToken: 'c',
    }) as Record<string, unknown>;
    for (const v of Object.values(out)) expect(v).toBe(REDACTED);
  });

  it('does not mutate the input and keeps non-sensitive keys', () => {
    const input = { descricao: 'Parafuso', valor_unitario: 1.5, tokenizer: 'keep?' };
    const copy = structuredClone(input);
    const out = redact(input);
    expect(input).toEqual(copy);
    expect(out).toEqual({ descricao: 'Parafuso', valor_unitario: 1.5, tokenizer: 'keep?' });
  });

  it('handles cycles without throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });

  it('ignores __proto__ keys (no prototype pollution through redaction)', () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as object;
    const out = redact(input) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out.ok).toBe(1);
  });
});

describe('createRedactor', () => {
  it('scrubs known secret values embedded in strings', () => {
    const r = createRedactor(['SUPERSECRET123456', 'short']);
    const out = r({ message: 'auth failed for SUPERSECRET123456 at x', list: ['SUPERSECRET123456'] });
    expect(JSON.stringify(out)).not.toContain('SUPERSECRET123456');
    expect(out).toEqual({ message: `auth failed for ${REDACTED} at x`, list: [REDACTED] });
  });

  it('ignores empty or very short secret values to avoid over-redaction', () => {
    const r = createRedactor(['', 'ab']);
    expect(r({ text: 'abc' })).toEqual({ text: 'abc' });
  });

  it('redacts plain strings', () => {
    const r = createRedactor(['TOPSECRETVALUE']);
    expect(r('x TOPSECRETVALUE y')).toBe(`x ${REDACTED} y`);
  });
});
