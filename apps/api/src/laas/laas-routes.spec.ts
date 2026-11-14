import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRE_PERMISSION_KEY } from '@app/common';
import { CombinedAuthGuard } from '../auth/combined-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { LAAS_CONTROLLERS } from './laas.module';
import { LAAS_OPERATIONS } from './laas-operations';

interface Route { method: string; identifier: string; permission: string | undefined; guarded: boolean }

/** Rutas declaradas en los controllers de /laas/v1, leídas de los metadatos de Nest. */
function laasRoutes(): Route[] {
  return LAAS_CONTROLLERS.flatMap((ctrl) => {
    const base = String(Reflect.getMetadata(PATH_METADATA, ctrl));
    const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, ctrl) ?? [];
    const proto = ctrl.prototype as unknown as Record<string, unknown>;
    return Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, proto[name] as object) !== undefined)
      .map((name) => {
        const handler = proto[name] as object;
        const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '/');
        const full = `/${[base, sub].join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '');
        expect(full.startsWith('/laas/v1/')).toBe(true);
        return {
          method: RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod],
          identifier: full.slice('/laas/v1'.length).replace(/:(\w+)/g, '{$1}'),
          permission: Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler),
          guarded: [...classGuards, ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])].length > 0,
        };
      });
  });
}

describe('/laas/v1: rutas de los controllers ↔ operaciones de los metadatos', () => {
  const routes = laasRoutes();
  const key = (r: { method: string; identifier: string }) => `${r.method} ${r.identifier}`;

  it('cada ruta tiene su operación en los metadatos, y cada operación su ruta', () => {
    expect(routes.map(key).sort()).toEqual(LAAS_OPERATIONS.map(key).sort());
  });

  it('permiso de cada ruta = x-permission de su operación; las públicas sin guards', () => {
    for (const op of LAAS_OPERATIONS) {
      const route = routes.find((r) => key(r) === key(op))!;
      if (op['x-permission'] === null) {
        expect(route.guarded).toBe(false);
        expect(route.permission).toBeUndefined();
      } else {
        expect(route.guarded).toBe(true);
        expect(route.permission).toBe(op['x-permission']);
      }
    }
  });

  it('las rutas autenticadas usan CombinedAuthGuard + PermissionGuard; solo metadata y clients son públicas', () => {
    for (const ctrl of LAAS_CONTROLLERS) {
      const guards = Reflect.getMetadata(GUARDS_METADATA, ctrl);
      if (guards) expect(guards).toEqual([CombinedAuthGuard, PermissionGuard]);
    }
    expect(routes.filter((r) => !r.guarded).map(key).sort()).toEqual(['GET /clients', 'GET /metadata']);
  });
});
