import { describe, expect, it } from 'vitest';
import { classifyResponse } from './classify';

describe('classifyResponse', () => {
  it('accepts a normal JSON body', () => {
    const r = classifyResponse({ httpStatus: 200, body: { pagina: 1, clientes_cadastro: [] } });
    expect(r.ok).toBe(true);
  });

  it('treats "no records" faults as an empty page marker', () => {
    const r = classifyResponse({
      httpStatus: 500,
      body: {
        faultstring: 'ERROR: Não existem registros para a página [1]!',
        faultcode: 'SOAP-ENV:Client-5113',
      },
    });
    expect(r).toMatchObject({
      ok: false,
      noRecords: true,
      retryable: false,
      faultCode: 'SOAP-ENV:Client-5113',
    });
  });

  it('maps HTTP 425 to OMIE_BLOCKED without retry', () => {
    expect(classifyResponse({ httpStatus: 425, body: {} })).toMatchObject({
      ok: false,
      code: 'OMIE_BLOCKED',
      retryable: false,
    });
  });

  it('maps HTTP 429 to a retryable rate limit', () => {
    expect(classifyResponse({ httpStatus: 429, body: {} })).toMatchObject({
      code: 'OMIE_RATE_LIMITED',
      retryable: true,
    });
  });

  it('does not retry redundant-request faults', () => {
    const r = classifyResponse({
      httpStatus: 500,
      body: { faultstring: 'ERROR: Consumo redundante detectado' },
    });
    expect(r).toMatchObject({ code: 'OMIE_RATE_LIMITED', retryable: false });
  });

  it('maps credential faults to OMIE_AUTH_ERROR', () => {
    const r = classifyResponse({
      httpStatus: 500,
      body: {
        faultstring: 'ERROR: A chave de acesso não é válida',
        faultcode: 'SOAP-ENV:Client-1',
      },
    });
    expect(r).toMatchObject({ code: 'OMIE_AUTH_ERROR', retryable: false });
  });

  it('maps 5xx without a fault to retryable OMIE_UNAVAILABLE', () => {
    expect(
      classifyResponse({ httpStatus: 503, body: undefined, rawSnippet: '<html>' }),
    ).toMatchObject({ code: 'OMIE_UNAVAILABLE', retryable: true });
    expect(classifyResponse({ httpStatus: 502, body: { foo: 1 } })).toMatchObject({
      code: 'OMIE_UNAVAILABLE',
      retryable: true,
    });
  });

  it('maps non-JSON 2xx to OMIE_BAD_RESPONSE', () => {
    expect(
      classifyResponse({ httpStatus: 200, body: undefined, rawSnippet: 'oops' }),
    ).toMatchObject({ code: 'OMIE_BAD_RESPONSE' });
    expect(classifyResponse({ httpStatus: 200, body: [1, 2] })).toMatchObject({
      code: 'OMIE_BAD_RESPONSE',
    });
  });

  it('detects business status errors in write responses', () => {
    const r = classifyResponse({
      httpStatus: 200,
      body: { codigo_status: '102', descricao_status: 'Cliente já cadastrado' },
    });
    expect(r).toMatchObject({ ok: false, code: 'OMIE_API_ERROR', faultCode: '102' });
    expect(
      classifyResponse({ httpStatus: 200, body: { cCodStatus: '0', cDesStatus: 'ok' } }).ok,
    ).toBe(true);
  });

  it('understands omie_fail envelopes', () => {
    const r = classifyResponse({
      httpStatus: 200,
      body: { omie_fail: { code: 5, description: 'Falha geral' } },
    });
    expect(r).toMatchObject({ ok: false, code: 'OMIE_API_ERROR', message: 'Omie: Falha geral' });
  });

  it('marks PROTO_BYEBYE as transient', () => {
    expect(
      classifyResponse({ httpStatus: 500, body: { faultstring: 'PROTO_BYEBYE' } }),
    ).toMatchObject({ code: 'OMIE_UNAVAILABLE', retryable: true });
  });
});
