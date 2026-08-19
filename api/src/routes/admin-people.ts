import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor, Role } from '../policy/can.ts';
import { KNOWN_ROLES, can as defaultCan } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';
import { actorWithFreshRoles } from '../auth/roles.ts';

// =============================================================================
// ADMINISTRATION: the roster, role assignment, invite budgets, audit log
// (design §5, §5.1, §12).
//
// §5's last three rows are all here: "Define degrees, global badges" lives in
// admin-badges.ts, and these are "Assign roles, grant invite budgets" and
// "Read audit log, instance settings".
//
// WHY BUDGETS ARE SET, NOT INCREMENTED. §12 calls it a grant, and a grant is
// a decision about the total ("this teacher may create ten accounts"), not
// about a delta. Two admins granting "+5" a minute apart would compound into
// a number neither of them intended; two admins setting "10" agree.
//
// WHY ROLE EXCLUSIVITY IS NOT CHECKED HERE. §5.1's admin/learner disjointness
// is a database exclusion constraint (migration 0005), and it has to be: two
// concurrent grants under READ COMMITTED each see a snapshot without the
// other's uncommitted row. So this route lets the insert fail and translates
// the violation, rather than re-implementing the invariant where it cannot
// actually hold.
// =============================================================================

export interface AdminPeopleRouteDeps {
  can?: typeof defaultCan;
  /** Test seam only — see auth/actor.ts. */
  actor?: Actor;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_BUDGET = 1000;

/** Exclusion-constraint violation code. Migration 0005's user_roles_admin_is_exclusive. */
const EXCLUSION_VIOLATION = '23P01';

interface AdminUserRow {
  id: string;
  email: string | null;
  handle: string | null;
  display_name: string | null;
  platform_invite_budget: number;
  created_at: Date;
  roles: string[] | null;
}

const USER_COLUMNS = `
  u.id, u.email, u.handle, u.display_name, u.platform_invite_budget, u.created_at,
  array_remove(array_agg(r.role order by r.role), null) as roles
`;

function serializeUser(row: AdminUserRow) {
  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    displayName: row.display_name,
    roles: row.roles ?? [],
    inviteBudget: row.platform_invite_budget,
    createdAt: row.created_at,
  };
}

async function loadUser(userId: string) {
  const { rows } = await getPool().query<AdminUserRow>(
    `select ${USER_COLUMNS}
       from users u
       left join user_roles r on r.user_id = u.id
      where u.id = $1
      group by u.id`,
    [userId],
  );
  return rows[0] ?? null;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

export function registerAdminPeopleRoutes(fastify: FastifyInstance, deps: AdminPeopleRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;

  // ---------------------------------------------------------------------------
  // GET /api/v1/admin/audit (§12: "all privileged actions are written to audit_log")
  // ---------------------------------------------------------------------------
  fastify.get<{ Querystring: { limit?: string; action?: string } }>('/api/v1/admin/audit', async (request, reply) => {
    const actor = actorFor(request, deps);
    if (!can(actor, 'audit:read')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const action = typeof request.query.action === 'string' && request.query.action !== '' ? request.query.action : null;

    const { rows } = await getPool().query<{
      id: string;
      action: string;
      actor_id: string | null;
      actor_handle: string | null;
      target: string | null;
      meta: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `select a.id, a.action, a.actor_id, a.target, a.meta, a.occurred_at, u.handle as actor_handle
         from audit_log a
         left join users u on u.id = a.actor_id
        where ($2::text is null or a.action = $2::text)
        order by a.occurred_at desc, a.id desc
        limit $1`,
      [clampLimit(request.query.limit), action],
    );

    return reply.code(200).send(
      rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorId: row.actor_id,
        actorHandle: row.actor_handle,
        target: row.target,
        meta: row.meta,
        occurredAt: row.occurred_at,
      })),
    );
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/admin/users — the roster the two mutations below act on
  // ---------------------------------------------------------------------------
  fastify.get<{ Querystring: { limit?: string } }>('/api/v1/admin/users', async (request, reply) => {
    const actor = actorFor(request, deps);
    if (!can(actor, 'user:list')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const { rows } = await getPool().query<AdminUserRow>(
      `select ${USER_COLUMNS}
         from users u
         left join user_roles r on r.user_id = u.id
        group by u.id
        order by u.created_at desc
        limit $1`,
      [clampLimit(request.query.limit)],
    );

    return reply.code(200).send(rows.map(serializeUser));
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/admin/users/:userId/roles
  // ---------------------------------------------------------------------------
  fastify.post<{ Params: { userId: string }; Body: { role?: unknown; granted?: unknown } }>(
    '/api/v1/admin/users/:userId/roles',
    async (request, reply) => {
      // Design §13: a privileged mutation re-reads its own roles first.
      const actor = await actorWithFreshRoles(getPool(), actorFor(request, deps));
      if (!can(actor, 'role:assign')) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      const body = request.body ?? {};
      const role = body.role;
      if (typeof role !== 'string' || !KNOWN_ROLES.has(role as Role)) {
        return reply.code(400).send({ message: 'role must be one of: student, teacher, admin.' });
      }
      if (typeof body.granted !== 'boolean') {
        return reply.code(400).send({ message: 'granted must be true or false.' });
      }

      const target = await loadUser(request.params.userId);
      if (!target) {
        return reply.code(404).send({ message: 'No such account.' });
      }

      try {
        if (body.granted) {
          await getPool().query(
            `insert into user_roles (user_id, role, granted_by) values ($1, $2, $3)
             on conflict (user_id, role) do nothing`,
            [target.id, role, actor.id],
          );
        } else {
          await getPool().query('delete from user_roles where user_id = $1 and role = $2', [target.id, role]);
        }
      } catch (err) {
        if ((err as { code?: string }).code === EXCLUSION_VIOLATION) {
          // §5.1: admin is an operator role, disjoint from the learner roles.
          return reply.code(409).send({
            message:
              'admin is exclusive of student and teacher (design §5.1). Remove the learner roles first, or use a separate operator account.',
          });
        }
        throw err;
      }

      await getPool().query(
        `insert into audit_log (actor_id, action, target, meta)
         values ($1, 'role.assigned', $2, $3::jsonb)`,
        [
          actor.id,
          target.id,
          JSON.stringify({ role, granted: body.granted, handle: target.handle, email: target.email }),
        ],
      );

      return reply.code(200).send(serializeUser((await loadUser(target.id))!));
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/v1/admin/users/:userId/invite-budget
  // ---------------------------------------------------------------------------
  fastify.post<{ Params: { userId: string }; Body: { budget?: unknown } }>(
    '/api/v1/admin/users/:userId/invite-budget',
    async (request, reply) => {
      const actor = await actorWithFreshRoles(getPool(), actorFor(request, deps));
      if (!can(actor, 'invite:budget:grant')) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      const budget = (request.body ?? {}).budget;
      if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 0 || budget > MAX_BUDGET) {
        return reply.code(400).send({ message: `budget must be a whole number between 0 and ${MAX_BUDGET}.` });
      }

      const target = await loadUser(request.params.userId);
      if (!target) {
        return reply.code(404).send({ message: 'No such account.' });
      }

      await getPool().query('update users set platform_invite_budget = $2 where id = $1', [target.id, budget]);

      // The previous value goes in the entry alongside the new one: "granted
      // 10" is not the same story as "cut from 40 to 10", and an audit log
      // that cannot tell them apart is not much of one.
      await getPool().query(
        `insert into audit_log (actor_id, action, target, meta)
         values ($1, 'invite.budget_granted', $2, $3::jsonb)`,
        [
          actor.id,
          target.id,
          JSON.stringify({
            handle: target.handle,
            email: target.email,
            previousBudget: target.platform_invite_budget,
            budget,
          }),
        ],
      );

      return reply.code(200).send(serializeUser((await loadUser(target.id))!));
    },
  );
}
