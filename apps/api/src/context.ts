import type { DatabaseHandle, SessionRow, UserRow } from '@dbx/database';
import type { AppConfig } from './config';
import type { AiProvider } from './ai/providers';
import type { OmieRuntime } from './services/omie';
import type { ConfirmationsService } from './services/confirmations';
import type { AuditService, HistoryService, SavedQueriesService } from './services/records';
import type { SessionsService } from './services/sessions';
import type { UsersService } from './services/users';
import type { ExecutionRegistry } from './services/executions';

export interface AppServices {
  config: AppConfig;
  database: DatabaseHandle;
  omie: OmieRuntime;
  ai: AiProvider | null;
  users: UsersService;
  sessions: SessionsService;
  audit: AuditService;
  history: HistoryService;
  saved: SavedQueriesService;
  confirmations: ConfirmationsService;
  executions: ExecutionRegistry;
  startedAt: Date;
}

export interface AuthState {
  user: UserRow;
  session: SessionRow;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: AppServices;
  }
  interface FastifyRequest {
    auth: AuthState | null;
  }
}
