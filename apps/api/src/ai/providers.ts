import { AppError } from '@dbx/shared';
import type { AppConfig } from '../config';

export interface AiProvider {
  readonly name: 'mock' | 'openai' | 'anthropic';
  readonly model: string;
  complete(system: string, user: string, signal: AbortSignal): Promise<string>;
}

type Fetch = typeof fetch;

async function postJson(
  fetchFn: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
) {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
  } catch (err) {
    const timeout = err instanceof DOMException && err.name === 'TimeoutError';
    throw new AppError(
      'AI_PROVIDER_ERROR',
      timeout ? 'The AI provider timed out' : 'The AI provider could not be reached',
    );
  }
  if (!res.ok) {
    // The provider body may echo request data; only the status is surfaced.
    throw new AppError('AI_PROVIDER_ERROR', `The AI provider answered HTTP ${res.status}`, {
      httpStatus: res.status,
    });
  }
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new AppError('AI_PROVIDER_ERROR', 'The AI provider returned an invalid response');
  }
}

export function createAiProvider(config: AppConfig, fetchFn: Fetch = fetch): AiProvider | null {
  const ai = config.ai;
  switch (ai.provider) {
    case 'disabled':
      return null;
    case 'mock':
      return createMockProvider();
    case 'openai':
      return {
        name: 'openai',
        model: ai.openai.model,
        async complete(system, user, signal) {
          const body = await postJson(
            fetchFn,
            `${ai.openai.baseUrl}/chat/completions`,
            { authorization: `Bearer ${ai.openai.apiKey ?? ''}` },
            {
              model: ai.openai.model,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
            },
            signal,
          );
          const text = (body as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]
            ?.message?.content;
          if (typeof text !== 'string')
            throw new AppError('AI_PROVIDER_ERROR', 'The AI provider returned no content');
          return text;
        },
      };
    case 'anthropic':
      return {
        name: 'anthropic',
        model: ai.anthropic.model,
        async complete(system, user, signal) {
          const body = await postJson(
            fetchFn,
            `${ai.anthropic.baseUrl}/messages`,
            { 'x-api-key': ai.anthropic.apiKey ?? '', 'anthropic-version': '2023-06-01' },
            {
              model: ai.anthropic.model,
              max_tokens: 1024,
              system,
              messages: [{ role: 'user', content: user }],
            },
            signal,
          );
          const blocks = (body as { content?: { type?: string; text?: unknown }[] }).content ?? [];
          const text = blocks
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('');
          if (!text) throw new AppError('AI_PROVIDER_ERROR', 'The AI provider returned no content');
          return text;
        },
      };
  }
}

const UFS = [
  'AC',
  'AL',
  'AM',
  'AP',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MG',
  'MS',
  'MT',
  'PA',
  'PB',
  'PE',
  'PI',
  'PR',
  'RJ',
  'RN',
  'RO',
  'RR',
  'RS',
  'SC',
  'SE',
  'SP',
  'TO',
];

/**
 * Deterministic offline provider for demos, CI and E2E tests. It recognises a few
 * Portuguese phrasings; it is not a language model.
 */
export function createMockProvider(): AiProvider {
  return {
    name: 'mock',
    model: 'mock-rules-v1',
    complete(_system, user) {
      const question = /<user_question>\n([\s\S]*?)\n<\/user_question>/.exec(user)?.[1] ?? user;
      const q = question.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const uf = UFS.find((s) => new RegExp(`\\b${s.toLowerCase()}\\b`).test(q));
      const n = Number(/\b(\d{1,3})\b/.exec(q)?.[1] ?? 0) || 20;
      const answer = (sql: string, explanation: string) =>
        Promise.resolve(JSON.stringify({ sql, explanation }));

      if (/quant[oa]s?\s+clientes/.test(q)) {
        return answer(
          uf
            ? `SELECT COUNT(*) AS total FROM clientes WHERE estado = '${uf}'`
            : 'SELECT COUNT(*) AS total FROM clientes',
          'Conta os clientes cadastrados' + (uf ? ` no estado ${uf}.` : '.'),
        );
      }
      if (/clientes?\s+por\s+estado/.test(q)) {
        return answer(
          'SELECT estado, COUNT(*) AS total FROM clientes GROUP BY estado ORDER BY total DESC',
          'Agrupa os clientes por estado e ordena pelo total.',
        );
      }
      if (/pedidos?/.test(q) && /clientes?/.test(q)) {
        return answer(
          `SELECT p.numero_pedido, p.data_previsao, p.valor_total_pedido, c.razao_social FROM pedidos_venda p INNER JOIN clientes c ON c.codigo_cliente_omie = p.codigo_cliente ORDER BY p.valor_total_pedido DESC LIMIT ${n}`,
          `Lista ${n} pedidos de venda com a razão social do cliente, do maior para o menor valor.`,
        );
      }
      if (/pedidos?/.test(q)) {
        return answer(
          `SELECT numero_pedido, etapa, data_previsao, valor_total_pedido FROM pedidos_venda ORDER BY valor_total_pedido DESC LIMIT ${n}`,
          `Lista ${n} pedidos de venda do maior para o menor valor.`,
        );
      }
      if (/(contas?\s+a\s+receber|receber)/.test(q)) {
        return answer(
          `SELECT codigo_lancamento_omie, numero_documento, data_vencimento, valor_documento, status_titulo FROM contas_receber WHERE status_titulo = 'ATRASADO' ORDER BY data_vencimento LIMIT ${n}`,
          'Lista títulos a receber em atraso, do vencimento mais antigo para o mais recente.',
        );
      }
      if (/(contas?\s+a\s+pagar|pagar)/.test(q)) {
        return answer(
          `SELECT codigo_lancamento_omie, data_vencimento, valor_documento, status_titulo FROM contas_pagar ORDER BY data_vencimento LIMIT ${n}`,
          'Lista as contas a pagar pelo vencimento.',
        );
      }
      if (/estoque|saldo/.test(q)) {
        return answer(
          `SELECT codigo_produto, descricao, saldo FROM estoque ORDER BY saldo DESC LIMIT ${n}`,
          'Lista os produtos com maior saldo em estoque.',
        );
      }
      if (/produtos?/.test(q)) {
        return answer(
          `SELECT codigo_produto, codigo, descricao, valor_unitario FROM produtos ORDER BY valor_unitario DESC LIMIT ${n}`,
          'Lista os produtos mais caros.',
        );
      }
      if (/clientes?/.test(q)) {
        return answer(
          `SELECT codigo_cliente_omie, razao_social, cidade, estado FROM clientes${uf ? ` WHERE estado = '${uf}'` : ''} ORDER BY razao_social LIMIT ${n}`,
          'Lista clientes' + (uf ? ` do estado ${uf}` : '') + ' em ordem alfabética.',
        );
      }
      return answer(
        'SHOW TABLES',
        'Não reconheci a pergunta; comece listando as tabelas disponíveis.',
      );
    },
  };
}
