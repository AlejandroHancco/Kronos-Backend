# Diseño: SmartConcreteBackend como monorepo API + Worker (3 VMs)

Fecha: 2026-11-13
Estado: borrador para aprobación

## 1. Intención y por qué

El backend hoy es un único proceso NestJS que atiende la API REST, los WebSockets, el cron de
mediciones programadas, el procesador de la cola Bull y el chequeo periódico de equipos del
laboratorio. Se va a desplegar en **3 VMs** de un proveedor que solo da cómputo (CPU/RAM/disco):

| VM | Rol | Expuesta |
|---|---|---|
| vm-app | API (REST + WebSockets) + Caddy (HTTPS) + frontend estático | Sí (80/443) |
| vm-worker | Worker: cron, mediciones, health de equipos, pruebas de conexión + Tailscale al laboratorio | No |
| vm-data | PostgreSQL + Redis | No (solo red privada) |

El objetivo es que **cada parte escale por su motivo**: la API con usuarios (añadiendo VMs de API),
el worker con volumen de mediciones (añadiendo workers), los datos verticalmente. Y que la VM
pública **no tenga acceso a la red del laboratorio**.

El worker es un servidor de terceros que llega a **todos los laboratorios** (Tailscale con rutas a
cada LAN). No hay un worker por laboratorio: cualquier worker puede atender cualquier equipo.

**Supabase Auth se mantiene** (login con Google, enlace mágico, verificación de email en el
frontend; la API sigue validando tokens de Supabase y los propios). Lo que sale de Supabase es
solo la **base de datos**: pasa a PostgreSQL en vm-data, **migrando los datos actuales**.

## 2. Objetivos

- Separar el código en dos aplicaciones desplegables independientemente: `api` y `worker`.
- Compartir dominio (Prisma, plugins de dispositivos, lógica de medición, contratos de cola y
  eventos) mediante librerías del monorepo, sin duplicar código.
- Solo el worker abre conexiones TCP/HTTP hacia equipos del laboratorio.
- Los eventos en tiempo real generados en el worker (progreso de medición, estado de jobs,
  estado de equipos, notificaciones) siguen llegando al frontend conectado a la API.
- La API puede escalar a N réplicas sin duplicar trabajos ni perder eventos.
- Entregar Dockerfile(s) y ficheros de despliegue por VM.

## 3. No-objetivos

- No se cambia el contrato HTTP ni WebSocket con el frontend (mismas rutas, mismos namespaces
  `/kronos` y `/measurements`, mismos nombres de evento y payloads). **KronosFrontend no se toca.**
- No se cambia el esquema de base de datos.
- No se introduce Kubernetes, ni brokers distintos de Redis.
- No se añade alta disponibilidad de Postgres/Redis (fase 2).
- No se reescribe la lógica de medición (SCPI/MUX, clasificación Kronos Watcher): solo se mueve.

## 4. Anti-objetivos (sería un fracaso aunque "funcione")

- Que el cron se ejecute en más de un proceso y se encolen mediciones duplicadas.
- Que se ejecuten dos mediciones a la vez sobre el mismo MUX/analyzer (hoy garantizado por
  concurrencia 1 del processor; debe seguir así aunque haya varios workers — ver §7.4).
- Que el dashboard deje de recibir el progreso en tiempo real.
- Que la API (VM pública) necesite rutas de red al laboratorio.
- Romper el arranque en desarrollo local más allá de "necesitas Redis".

## 5. Restricciones

- NestJS 11, Prisma 7 (`prisma.config.ts`, adapter `@prisma/adapter-pg`), Bull 4 (`@nestjs/bull`),
  Socket.io 4, Node 24.
- Redis pasa a ser **obligatorio** (hoy es opcional con fallback a ejecución directa).
- Un único `package.json` / `node_modules` en la raíz (modo monorepo estándar de Nest CLI).
- Las migraciones Prisma siguen en `prisma/` en la raíz.

## 6. Enfoques considerados

1. **Un solo código con `ROLE=api|worker|all`** — cambio mínimo, una imagen; separación solo por
   configuración. *No elegido.*
2. **Monorepo Nest CLI con `apps/api`, `apps/worker` y `libs/*`** — separación explícita en la
   estructura; cada app solo importa lo que necesita; builds independientes. Más cambio (mover
   módulos, imports por alias). **Elegido por el usuario.**
3. **Dos repositorios** — descartado: duplicaría Prisma, plugins y lógica de dominio.

Decisión del usuario adicional: la prueba de conexión de equipos (`POST /devices/test-connection`)
la **ejecuta el worker**, no la API (opción "B").

## 7. Diseño

### 7.1 Estructura

```
SmartConcreteBackend/
  apps/
    api/src/        main.ts, api.module.ts, controllers + servicios de lectura/CRUD, gateways
    worker/src/     main.ts, worker.module.ts, cron, processors, health de equipos
  libs/
    database/       PrismaModule, PrismaService
    redis/          RedisModule (cliente ioredis compartido)
    queue/          BullModule.forRoot, nombres de colas, tipos de payload de jobs
    realtime/       contrato de eventos + RealtimePublisher (abstracción) + implementación por emitter
    device-plugins/ DevicePluginRegistry + plugin Hioki IM3570
    measurement/    ejecución de medición (measureTask), Kronos Watcher, estimación de duración
    notifications/  creación de notificaciones/eventos de actividad (escritura + publish)
    common/         TeamScopeService, decorators, validators
  prisma/           schema, migrations, seed (sin cambios)
  nest-cli.json     "monorepo": true, projects api/worker/libs
  tsconfig.json     paths @app/database, @app/queue, ...
```

Alias de import: `@app/<lib>` (convención por defecto de `nest g library`).

### 7.2 Qué va a cada app

**apps/api** (todo lo que hoy tiene controller, salvo el scheduler interno):
auth, users, teams, projects, tasks, task-preferences, task-channels, measurements (lecturas,
CRUD, `PATCH channels`), measurement-channels, devices (CRUD), scheduled-jobs, permissions,
notifications (lecturas/marcar leídas), dashboard, reports, search, health, `SchedulerController`,
gateways `KronosGateway` y `MeasurementsGateway`, ThrottlerGuard, RlsMiddleware.

- `MeasurementSchedulingService` (control de admisión de mediciones manuales) **se queda en la API**:
  calcula el backlog leyendo la cola y encola. Ya no tiene ruta de ejecución directa.
- `DevicesService.testConnection` deja de llamar al plugin: encola un job en la cola
  `device-ops` y espera su resultado (§7.5).

**apps/worker**:
- `SchedulerService` (`@Cron` cada minuto) — despacha ScheduledJobs a la cola `measurements`.
- `MeasurementProcessor` (cola `measurements`, concurrencia 1).
- `DeviceHealthService` (`@Interval` 30 s).
- `DeviceOpsProcessor` (cola `device-ops`, concurrencia ~5) — atiende `test-connection`.
- Endpoint HTTP mínimo **solo** `GET /health` (DB + Redis) para el healthcheck del contenedor,
  escuchando en un puerto interno (por defecto 3001). Sin controladores de negocio, sin CORS, sin
  Socket.io server.

### 7.3 Eventos en tiempo real desde el worker

Problema: `MeasurementsService.measureTask`, `MeasurementProcessor`, `SchedulerService`,
`DeviceHealthService` y `NotificationsService` llaman hoy directamente a métodos de
`KronosGateway` / `MeasurementsGateway`. En el worker no hay servidor Socket.io ni clientes.

Solución:
- `libs/realtime` define un `RealtimePublisher` abstracto con un método por evento existente
  (mismos nombres/payloads que hoy):
  - `/kronos`: `measurement:complete` (sala `task:<id>`), `job:status` (sala `user:<id>`),
    `notification` (sala `user:<id>`), `device:status` (broadcast).
  - `/measurements`: `measurement:progress`, `measurement:completed`, `measurement:error`
    (sala `<userId>`).
- **Worker**: implementación con `@socket.io/redis-emitter` (publica en Redis sin servidor).
- **API**: los gateways usan `@socket.io/redis-adapter`, de modo que lo publicado por el worker
  (y por cualquier réplica de API) llega a los clientes de todas las réplicas. Si en la API también
  se emite algo (p. ej. `NotificationsService` desde un endpoint de equipos), usa la misma
  abstracción con la implementación basada en el gateway.
- Todo el código de dominio en `libs/` depende de `RealtimePublisher`, nunca de un gateway.

### 7.4 Varios workers: exclusividad de equipos y tareas singleton

Todos los workers alcanzan todos los equipos, así que basta **una cola `measurements` compartida**.

**Exclusividad MUX/analyzer.** Hoy se garantiza con concurrencia 1 en un único proceso. Con N
workers, Bull repartiría jobs y podrían medir en paralelo sobre el mismo MUX. El processor
adquiere un **lock en Redis por dispositivo** (`lock:device:<muxDeviceId>` y
`lock:device:<analyzerDeviceId>`, `SET NX PX` con TTL, renovado mientras mide, liberado al
terminar o fallar). Si el equipo está ocupado, el processor **espera dentro del mismo job**
(sondeo con backoff, con un tope; al vencerlo el job falla como hoy). Así el `job.id` no cambia y el
frontend sigue viendo `queued → processing → completed` para el mismo `jobId`. Coste aceptado:
ese worker queda ocupado mientras espera.

**Cron y health check como singleton.** `SchedulerService` (cron) y `DeviceHealthService`
(interval) se ejecutan solo en el worker que tenga el **lock de líder** en Redis
(`lock:leader:scheduler`, `lock:leader:device-health`, TTL corto renovado en cada tick). Los demás
workers saltan el tick. Se mantiene además la guarda actual `updateMany pending→running`.

### 7.5 Prueba de conexión vía worker (opción B)

- API: `POST /devices/test-connection` → `deviceOpsQueue.add('test-connection', {type, ip, port},
  { removeOnComplete: true, removeOnFail: true, attempts: 1 })` y `await job.finished()` con
  timeout de **5 s**.
- Worker: `DeviceOpsProcessor` llama a `DevicePluginRegistry.get(type).testConnection(...)` y
  devuelve `boolean`.
- Si vence el timeout o no hay worker → responde lo mismo que hoy cuando no conecta (mismo shape
  de respuesta que el endpoint actual), y loguea warning. El contrato HTTP no cambia.

### 7.6 Medición: dónde vive cada pieza

`MeasurementsService` se divide:
- **libs/measurement** → `MeasurementExecutor.measureTask(...)` (selección de canal en MUX,
  barrido SCPI, guardado, clasificación Kronos Watcher, publish de progreso/completado/error,
  notificación). Depende de Prisma, DevicePluginRegistry, RealtimePublisher, notifications lib.
  También la estimación de duración (constantes hoy en `scheduling.service.ts`) si la usan ambos.
- **apps/api** → `MeasurementsService` con lecturas/CRUD (`getLatest`, `create`, `findAll`,
  `findByTask`, `findOne`, `remove`, channels).

### 7.7 Configuración por app

Variables comunes: `DATABASE_URL`, `REDIS_URL` (obligatoria; si falta, la app no arranca con un
error claro).

- api: `PORT` (def. 3000), `FRONTEND_URL` (CORS HTTP y Socket.io; hoy CORS HTTP está abierto —
  se restringe a `FRONTEND_URL`), `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_JWT_SECRET`, `SCHEDULER_MAX_BACKLOG_SECONDS`, `DEVICE_TEST_TIMEOUT_MS` (def. 5000).
- worker: `HEALTH_PORT` (def. 3001).

### 7.8 Scripts y desarrollo local

- `npm run build:api`, `npm run build:worker` (`nest build api|worker`), `npm run build` ambos.
- `npm run start:dev` arranca ambas apps en watch (dos procesos, p. ej. con `concurrently`).
- `docker-compose.dev.yml` en la raíz con Redis (y Postgres opcional) para desarrollo.
- `prisma generate`/`migrate` sin cambios; `seed` sin cambios.

### 7.9 Despliegue

- Un `Dockerfile` multi-stage con target por app (`--target api` / `--target worker`), misma base.
  La imagen de api ejecuta `prisma migrate deploy` antes de arrancar; el worker no migra.
- `deploy/` con un compose por VM:
  - `vm-app/`: `api` + `caddy` (HTTPS automático, `api.<dominio>` → api:3000 con WebSocket,
    `app.<dominio>` → frontend estático) + `.env.example` + `Caddyfile`.
    El frontend se construye con su propio Dockerfile en KronosFrontend (solo se añade ese fichero,
    sin cambios de código) o se sirve el `dist/` montado.
  - `vm-worker/`: `worker` + `.env.example` + instrucciones de Tailscale en el host
    (`--accept-routes`).
  - `vm-data/`: `postgres:16` + `redis:7` (AOF, `requirepass`), puertos ligados a la IP privada,
    script de backup `pg_dump` diario con retención.
- `deploy/README.md` con el orden de arranque y firewall entre VMs (5432/6379 solo desde app y
  worker).

### 7.9.1 Migración de datos a vm-data

Los datos actuales viven en el Postgres de origen (hoy el de Supabase, el `DATABASE_URL` actual).
Se entrega `deploy/vm-data/MIGRATION.md` + script:

1. Ventana de corte: parar escrituras (apagar el backend actual).
2. `pg_dump` del **esquema `public`** del origen (formato custom, `--no-owner --no-acl`), incluida
   la tabla `_prisma_migrations`. No se copian los esquemas internos de Supabase (`auth`,
   `storage`, ...): la autenticación sigue en Supabase y los usuarios se enlazan por email/UUID ya
   presentes en `public`.
3. Restaurar en el Postgres de vm-data con `pg_restore`.
4. Verificar: `prisma migrate status` sin pendientes ni divergencias; conteo de filas por tabla
   origen vs destino (script).
5. Arrancar api con el nuevo `DATABASE_URL`; `prisma migrate deploy` no aplica nada.
6. Rollback: volver a apuntar `DATABASE_URL` al origen (no se borra nada del origen).

Si el origen tuviera políticas RLS o funciones dependientes de esquemas de Supabase
(`auth.uid()`), el script las detecta y avisa antes de restaurar.

### 7.10 Tests

- Mantener los specs existentes (moviéndolos con su código) en verde.
- Nuevos:
  - el módulo de la API **no** registra `SchedulerService`, `MeasurementProcessor`,
    `DeviceHealthService` ni `DeviceOpsProcessor`; el del worker **no** registra controllers de
    negocio ni gateways.
  - `testConnection` en API: encola en `device-ops` y respeta el timeout.
  - `DeviceOpsProcessor` delega en el plugin.
  - `RealtimePublisher` del worker emite al namespace/sala/evento correctos.
  - lock de dispositivo: un segundo job sobre el mismo MUX no se ejecuta en paralelo y conserva
    su `jobId`.
  - lock de líder: con dos instancias del scheduler, solo una ejecuta el tick.
- Verificación final: `nest build` de ambas apps, `jest` en verde, `docker build` de ambos targets.

## 8. Decidido por el usuario

- 3 VMs: app / worker / data.
- Opción B: la API no toca el laboratorio; la prueba de conexión la hace el worker.
- Enfoque 2: monorepo Nest con `apps/api`, `apps/worker`, `libs/*`.
- Un worker atiende todos los laboratorios; varios workers comparten cola.
- Los datos actuales se migran a vm-data.
- Supabase Auth se mantiene; solo la base de datos sale de Supabase.

## 9. Decisiones del diseñador (revisables)

- Redis obligatorio; se elimina el fallback de ejecución directa sin Redis.
- Worker sin Socket.io server; eventos vía `@socket.io/redis-emitter` + adapter en la API.
- Lock por dispositivo en Redis; si el equipo está ocupado el job espera dentro del processor
  (mismo `jobId`).
- Cron y health check de equipos con lock de líder en Redis (un solo worker los ejecuta).
- Migración: solo esquema `public` + `_prisma_migrations`; origen intacto para rollback.
- Detrás de Caddy: `trust proxy` en Express para que el throttler use la IP real del cliente.
- Varias réplicas de API (fase 2): sticky sessions en Caddy (`lb_policy cookie`).
- Worker expone solo `GET /health` en puerto interno.
- CORS HTTP restringido a `FRONTEND_URL`.
- Migraciones las ejecuta la imagen de la API al arrancar.
- Trabajo en una rama `feat/monorepo-api-worker`; sin push.

## 10. Lo que queda a criterio del implementador

- Nombres exactos de clases/ficheros dentro de cada lib.
- Cómo dividir `notifications` entre lib (escritura + publish) y API (lecturas/endpoints).
- Mecanismo exacto de renovación del lock y retraso de re-programación.
- Uso de `concurrently` u otra herramienta para `start:dev`.
