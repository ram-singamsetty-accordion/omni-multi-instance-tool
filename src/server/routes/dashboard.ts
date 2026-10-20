import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getInstance, isUnlocked, listInstances, getAppDisabledEntities, setAppDisabledEntities } from '../storage/vault.js';
import { OmniClient, type OmniClientOptions } from '../omni/client.js';

// One unreachable instance must not hold the combined response: fail it fast and report an error row.
const DASHBOARD_CLIENT: OmniClientOptions = { timeoutMs: 30_000, maxAttempts: 2 };
// Idle limit, not total time: every request waits its turn behind the key's rate gap, so a large instance
// legitimately takes longer. `work` restarts the clock with the heartbeat after each completed page.
const INSTANCE_DEADLINE_MS = 45_000;

function withDeadline<T>(work: (heartbeat: () => void) => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  let expire!: (err: Error) => void;
  const deadline = new Promise<never>((_, reject) => { expire = reject; });
  const arm = (): void => {
    // After expiry the abandoned work throws here on its next page instead of paging on against the key's rate budget.
    if (expired) throw new Error(`${label}: abandoned after no answer within ${ms / 1000}s`);
    clearTimeout(timer);
    timer = setTimeout(() => {
      expired = true;
      expire(new Error(`${label}: no answer within ${ms / 1000}s`));
    }, ms);
  };
  arm();
  return Promise.race([work(arm), deadline]).finally(() => clearTimeout(timer));
}

export interface ConnectionStat {
  id: string;
  name: string;
  dialect: string;
  database: string;
  hasSchemaModel: boolean;
  schemaModelId: string | null;
  schemaModelUpdatedAt: string | null;
  filtered?: boolean;
}

export interface InstanceDashboardStats {
  instanceId: string;
  instanceLabel: string;
  instanceRole: string;
  baseUrl: string;
  totalConnections: number;
  connections: ConnectionStat[];
  filteredCount: number;
  error?: string;
}

export interface EmbedUserStat {
  id: string;
  displayName: string;
  userName: string;
  active: boolean;
  embedExternalId: string;
  groups: Array<{ display: string; value: string }>;
  lastLogin?: string | null;
  createdAt?: string;
  filtered?: boolean;
}

export interface InstanceEmbedUserStats {
  instanceId: string;
  instanceLabel: string;
  instanceRole: string;
  baseUrl: string;
  users: EmbedUserStat[];
  filteredCount: number;
  error?: string;
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard/stats', async (_req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });

    const publicInstances = listInstances().filter(i => !i.dashboardTabs || i.dashboardTabs.includes('connections'));
    const results = await Promise.allSettled(
      publicInstances.map(pub => withDeadline(async (heartbeat): Promise<InstanceDashboardStats> => {
        const inst = getInstance(pub.id)!;
        const client = new OmniClient(inst, DASHBOARD_CLIENT);
        const [connections, models] = await Promise.all([
          client.listConnections().then(r => { heartbeat(); return r; }),
          client.listSchemaModels(heartbeat),
        ]);

        const schemaModelByConnectionId = new Map(
          models
            .filter(m => !m.deletedAt)
            .map(m => [m.connectionId, m])
        );

        const dbContains = (inst.dashboardFilter?.databaseContains ?? []).map(s => s.toLowerCase());
        const dbExact = (inst.dashboardFilter?.databaseExact ?? []).map(s => s.toLowerCase());
        const hasFilter = dbContains.length > 0 || dbExact.length > 0;
        const connectionStats: ConnectionStat[] = connections
          .filter(c => !c.deletedAt)
          .map(c => {
            const model = schemaModelByConnectionId.get(c.id);
            const hasSchemaModel = !!model && model.createdAt !== model.updatedAt;
            const dbName = c.database ?? ''; // Omni allows a null database
            const db = dbName.toLowerCase();
            const filtered = hasFilter && (dbContains.some(n => db.includes(n)) || dbExact.some(n => db === n));
            return { id: c.id, name: c.name, dialect: c.dialect, database: dbName, hasSchemaModel, schemaModelId: model?.id ?? null, schemaModelUpdatedAt: model?.updatedAt ?? null, filtered };
          });

        return {
          instanceId: inst.id,
          instanceLabel: inst.label,
          instanceRole: inst.role,
          baseUrl: inst.baseUrl,
          totalConnections: connectionStats.filter(c => !c.filtered).length,
          connections: connectionStats,
          filteredCount: connectionStats.filter(c => c.filtered).length,
        };
      }, INSTANCE_DEADLINE_MS, pub.label))
    );

    const stats: InstanceDashboardStats[] = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const pub = publicInstances[i]!;
      return {
        instanceId: pub.id,
        instanceLabel: pub.label,
        instanceRole: pub.role,
        baseUrl: pub.baseUrl,
        totalConnections: 0,
        connections: [],
        filteredCount: 0,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    return stats;
  });

  app.post('/api/dashboard/:instanceId/refresh-schema', async (req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const { instanceId } = req.params as { instanceId: string };
    const body = z.object({ modelId: z.string().min(1) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'modelId required' });
    const { modelId } = body.data;
    const inst = getInstance(instanceId);
    if (!inst) return reply.code(404).send({ error: 'instance not found' });
    const client = new OmniClient(inst);
    const result = await client.refreshSchemaModel(modelId);
    return result;
  });

  app.get('/api/dashboard/embed-users', async (_req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });

    const publicInstances = listInstances().filter(i => !i.dashboardTabs || i.dashboardTabs.includes('users'));
    const results = await Promise.allSettled(
      publicInstances.map(pub => withDeadline(async (heartbeat): Promise<InstanceEmbedUserStats> => {
        const inst = getInstance(pub.id)!;
        const client = new OmniClient(inst, DASHBOARD_CLIENT);
        const rawUsers = await client.listEmbedUsers(heartbeat);
        const idContains = (inst.dashboardFilter?.externalIdContains ?? []).map(s => s.toLowerCase());
        const idExact = (inst.dashboardFilter?.externalIdExact ?? []).map(s => s.toLowerCase());
        const hasFilter = idContains.length > 0 || idExact.length > 0;
        const users = rawUsers.map(u => {
          const eid = u.embedExternalId.toLowerCase();
          const filtered = hasFilter && (idContains.some(n => eid.includes(n)) || idExact.some(n => eid === n));
          return {
            id: u.id,
            displayName: u.displayName,
            userName: u.userName,
            active: u.active,
            embedExternalId: u.embedExternalId,
            groups: u.groups,
            lastLogin: u['urn:omni:params:scim:schemas:extension:user:2.0']?.lastLogin ?? null,
            createdAt: u.meta.created,
            filtered,
          };
        });
        return {
          instanceId: inst.id,
          instanceLabel: inst.label,
          instanceRole: inst.role,
          baseUrl: inst.baseUrl,
          users,
          filteredCount: users.filter(u => u.filtered).length,
        };
      }, INSTANCE_DEADLINE_MS, pub.label))
    );

    const stats: InstanceEmbedUserStats[] = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const pub = publicInstances[i]!;
      return {
        instanceId: pub.id,
        instanceLabel: pub.label,
        instanceRole: pub.role,
        baseUrl: pub.baseUrl,
        users: [],
        filteredCount: 0,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    return stats;
  });

  app.get('/api/dashboard/app-disabled', async (_req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    return { keys: getAppDisabledEntities() };
  });

  app.post('/api/dashboard/app-disabled', async (req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const body = z.object({ keys: z.array(z.string().max(512)) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'keys must be string[]' });
    setAppDisabledEntities(body.data.keys);
    return { ok: true };
  });
}
