import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP } from '../playwright.config';

// One browser session walks through the main flows in order, like a user would.
// `UPDATE_SCREENSHOTS=1 pnpm test:e2e` refreshes the images in docs/screenshots.
test.describe.configure({ mode: 'serial' });

const NEW_PASSWORD = 'E2E-Changed#Pass2026';
const SHOTS = process.env.UPDATE_SCREENSHOTS === '1';

let page: Page;

async function shot(name: string) {
  if (!SHOTS) return;
  await page.screenshot({
    path: fileURLToPath(new URL(`../../docs/screenshots/${name}.png`, import.meta.url)),
  });
}

/** Replaces the active editor text. insertText avoids Monaco's auto-closing quotes. */
async function setSql(sql: string) {
  const editor = page.getByTestId('sql-editor').locator('.monaco-editor').first();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(sql);
}

async function run(sql: string) {
  await setSql(sql);
  await page.getByTestId('run-query').click();
}

function nav(label: string) {
  return page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('button', {
    name: label,
    exact: true,
  });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

test('rejects a wrong password, then logs in and forces the bootstrap password change', async () => {
  await page.goto('/');
  await page.getByLabel('E-mail').fill(BOOTSTRAP.email);
  await page.getByLabel('Senha').fill('wrong-password-123');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.getByLabel('Senha').fill(BOOTSTRAP.password);
  await page.getByRole('button', { name: 'Entrar' }).click();

  await page.getByLabel('Senha atual').fill(BOOTSTRAP.password);
  await page.getByLabel('Nova senha', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirmar nova senha').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();

  await expect(page.getByTestId('current-user')).toContainText('Admin Demo');
  await expect(page.getByTestId('omie-mode')).toContainText(/mock/i);
  await expect(page.getByTestId('app-version')).toBeVisible();
});

test('shows the schema grouped by area', async () => {
  const schema = page.getByRole('complementary', { name: 'Schema' });
  await expect(schema.getByTestId('schema-table-clientes')).toBeVisible();
  await expect(schema.getByTestId('schema-table-nfes')).toBeVisible();
  await schema.getByPlaceholder('Filtrar tabelas e colunas…').fill('departamentos');
  await expect(schema.getByTestId('schema-table-departamentos')).toBeVisible();
  await expect(schema.getByTestId('schema-table-nfes')).toBeHidden();
  await schema.getByPlaceholder('Filtrar tabelas e colunas…').fill('');
});

test('runs a SELECT and shows results, JSON, API request and messages', async () => {
  await run(
    "SELECT codigo_cliente_omie, razao_social, cidade, estado FROM clientes WHERE estado = 'SP' ORDER BY razao_social LIMIT 25",
  );
  const grid = page.getByTestId('result-grid');
  await expect(grid).toBeVisible();
  await expect(grid).toContainText('razao_social');
  await expect(page.getByTestId('result-status')).toContainText(/linha/);
  await shot('query-results');

  await page.getByRole('tab', { name: 'JSON' }).click();
  await expect(page.getByTestId('result-json')).toContainText('"estado": "SP"');

  await page.getByRole('tab', { name: 'API Request' }).click();
  const request = page.getByTestId('api-request');
  await expect(request).toContainText('ListarClientes');
  await expect(request).toContainText('REDACTED');

  await page.getByRole('tab', { name: 'Results' }).click();
});

test('explains a query plan', async () => {
  await setSql(
    'SELECT c.razao_social, p.numero_pedido FROM pedidos_venda p INNER JOIN clientes c ON c.codigo_cliente_omie = p.codigo_cliente LIMIT 10',
  );
  await page.getByRole('button', { name: 'Explain', exact: true }).first().click();
  await expect(page.getByTestId('explain-view')).toBeVisible();
  await expect(page.getByTestId('explain-step').first()).toBeVisible();
  await shot('explain-plan');
  await page.getByRole('tab', { name: 'Results' }).click();
});

test('saves the current query and lists it under saved queries', async () => {
  await setSql(
    'SELECT estado, COUNT(*) AS total FROM clientes GROUP BY estado ORDER BY total DESC',
  );
  await page.keyboard.press('ControlOrMeta+S');
  await page.getByTestId('save-name').fill('Clientes por estado');
  await page.getByTestId('save-confirm').click();

  await nav('Consultas salvas').click();
  await expect(page.getByTestId('saved-list')).toContainText('Clientes por estado');
  await page.getByRole('button', { name: 'Executar' }).first().click();
  await expect(page.getByTestId('result-grid')).toContainText('total');
});

test('records executed queries in the history', async () => {
  await nav('Histórico').click();
  await expect(page.getByTestId('history-table')).toContainText('GROUP BY estado');
  await expect(page.getByTestId('history-table')).toContainText("WHERE estado = 'SP'");
  await nav('Editor SQL').click();
});

test('AI assistant suggests SQL without executing it', async () => {
  await page.getByTestId('toggle-ai').click();
  await page.getByTestId('ai-question').fill('Quantos clientes existem em SP?');
  await page.getByRole('button', { name: 'Gerar SQL' }).click();
  const answer = page.getByTestId('ai-answer');
  await expect(answer).toContainText('COUNT(*)');
  await expect(answer).toContainText("estado = 'SP'");
  await shot('ai-assistant');
  await answer.getByRole('button', { name: 'Inserir no editor' }).click();
  await page.getByTestId('toggle-ai').click();
});

const UPDATE_SQL = "UPDATE clientes SET cidade = 'Campinas' WHERE codigo_cliente_omie = 1000001";

test('previews an UPDATE and cancels without sending anything', async () => {
  await run(UPDATE_SQL);
  // The preview dialog opens by itself as soon as the write is planned.
  const dialog = page.getByTestId('write-preview');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Campinas');
  await expect(page.getByTestId('confirm-write')).toBeDisabled();
  await shot('write-preview');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByText('Escrita cancelada. Nada foi enviado ao Omie.')).toBeVisible();
  // The preview stays available in the results panel and can be reopened.
  await page.getByRole('button', { name: 'Revisar e confirmar' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
});

test('executes the confirmed UPDATE against the mock and shows the outcome', async () => {
  await run(UPDATE_SQL);
  await expect(page.getByTestId('write-preview')).toBeVisible();
  await page.getByTestId('ack-write').check();
  await page.getByTestId('confirm-write').click();
  await expect(page.getByTestId('write-outcome')).toContainText(/1/);

  await run('SELECT codigo_cliente_omie, cidade FROM clientes WHERE codigo_cliente_omie = 1000001');
  await expect(page.getByTestId('result-grid')).toContainText('Campinas');
});

test('audit log lists the write with its before/after', async () => {
  await nav('Auditoria').click();
  const table = page.getByTestId('audit-table');
  await expect(table).toContainText('write.execute');
  await expect(table).toContainText('auth.login_failed');
  await shot('audit-log');
  await table.getByTestId('audit-row').filter({ hasText: 'write.execute' }).first().click();
  const detail = page.getByTestId('audit-detail');
  await expect(detail).toContainText('Campinas');
  await expect(detail).not.toContainText('app_secret": "');
  await detail.getByRole('button', { name: 'Fechar' }).first().click();
});

test('explorer overview screenshot', async () => {
  await nav('Editor SQL').click();
  await run(
    'SELECT codigo_produto, descricao, unidade, valor_unitario FROM produtos ORDER BY descricao LIMIT 50',
  );
  await expect(page.getByTestId('result-grid')).toBeVisible();
  await shot('explorer');
});
