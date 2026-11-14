# Diseño: plataforma LaaS (IEEE 1876 capa 1) sobre API + Worker en 3 VMs

Fecha: 2026-11-13
Estado: borrador para aprobación
Rama: `feat/laas-platform` (backend y frontend), creada desde `origin/feat/laas-acquisition`.
Referencia aprobada (separación API/worker): `docs/superpowers/specs/2026-11-13-monorepo-api-worker-design.md`.

## 1. Intención y por qué

La tesis demuestra que la plataforma es **extensible e interoperable**: cualquier equipo de
medición accesible por IP se incorpora escribiendo **un plugin**, y queda operable mediante los
servicios estándar de **IEEE Std 1876-2019, cláusula 4 (Lab as a Service)**, sin tocar el resto.

La rama `feat/laas-acquisition` ya generalizó el núcleo: plugins por modelo con
`service-description.json` (Tablas 14/15/18/19), capacidades `SensorPlugin.getSensorData` y
`ActuatorPlugin.setActuatorData`, configuración por dispositivo, experimentos derivados, mediciones
genéricas (`{x, values}`, barrido o lectura puntual), reportes/gráficas genéricos, 6 plugins
(Hioki IM3570, MUX Kronos 16, Agilent E4402B, 3 simuladores). Nunca pasó a producción.

Este diseño: (1) lleva esa rama a la arquitectura de **3 VMs** (API pública sin acceso al
laboratorio, worker con acceso, datos), y (2) completa lo que falta de la **capa LaaS** para que
el laboratorio sea un servidor LaaS que cualquier cliente pueda usar.

Arquitectura conceptual (capas del estándar):
- **Servidor LaaS (capa 1):** catálogo de plugins + equipos registrados + servicios estándar. La
  ejecución contra el hardware ocurre **solo en el worker**.
- **Plataforma Kronos (capa 2):** proyectos, tareas, mediciones, reportes, dashboard. Es un
  cliente del LaaS: la medición de una tarea es un experimento ejecutado con `setActuatorData` +
  `getSensorData`.

## 2. Objetivos

1. Base = `origin/feat/laas-acquisition` en ambos repos.
2. Rehacer la separación API/worker de la referencia aprobada sobre esta base.
3. Eliminar las suposiciones de "un solo proceso" de la rama LaaS (estado ocupado/configurando de
   dispositivos, configuración en vivo, chequeo de equipos).
4. Exponer la capa LaaS completa (servicios requeridos §4.3.1 + metadatos §4.2) bajo `/laas/v1`.
5. Despliegue en 3 VMs con **base de datos nueva** (migraciones + seed).

## 3. No-objetivos

- Migrar o convertir datos existentes (Postgres local del usuario): vm-data arranca vacía. El
  script `migrate-data.sh` queda como herramienta opcional.
- Capas 2–3 del estándar (Learning Objects, xAPI, LMS/LTI).
- Modos `push`/`stream`; servicios opcionales `getLoggingInfo`, `getModels`.
- Cambiar el comportamiento visible del frontend de `feat/laas-acquisition` (solo se añaden
  Dockerfile y nginx.conf).
- Alta disponibilidad de Postgres/Redis.

## 4. Anti-objetivos

- Que añadir un equipo nuevo requiera tocar algo fuera de su carpeta de plugin.
- Que la API (VM pública) abra conexiones a equipos del laboratorio.
- Que un cambio de configuración o de actuador interrumpa una medición en curso.
- Que dos mediciones usen el mismo equipo a la vez (con N workers).
- Que el dashboard/reportes dejen de ver progreso y resultados.

## 5. Restricciones

- Mismo stack que la referencia (NestJS 11, Prisma 7, Bull 4, ioredis, Socket.io 4 + redis
  emitter/adapter, Node 24). Supabase Auth se mantiene.
- Contrato HTTP/WS que usa hoy el frontend de `feat/laas-acquisition`: sin cambios (rutas, nombres
  de campos LaaS, eventos, salas `user:<id>`, `team:<id>`, `task:<id>`, `<userId>` en
  `/measurements`, autenticación de sockets por middleware, revocación con `WS_AUTH_ERROR` +
  `disconnectSockets`).
- Commits sin líneas `Co-Authored-By`.

## 6. Enfoques considerados (decididos con el usuario)

- **Base:** A) rama LaaS como base y rehacer la separación encima (**elegido**); B) fusionar la
  rama LaaS sobre la rama del monorepo (descartado: conflictos en casi todo `src/`).
- **Organización:** todo gira alrededor de LaaS: el worker es el servidor LaaS que ejecuta, la
  plataforma es su cliente (**elegido**, "lectura 1"); frente a añadir un módulo LaaS al lado.
- **getSensorData:** C) por defecto devuelve la última lectura; con `fresh=true` lanza una
  medición nueva (**elegido**).
- **Experimentos:** se reutilizan los experimentos derivados ya existentes (Tabla 20); la medición
  pertenece a una tarea, como hoy.
- **Transporte:** REST bajo `/laas/v1` + avisos asíncronos por el Socket.io existente; metadatos
  públicos por HTTP GET (permitido por §4.4.2).

## 7. Diseño

### 7.1 Ramas

- Backend: `feat/laas-platform` desde `origin/feat/laas-acquisition`. La rama
  `feat/monorepo-api-worker` queda como referencia (no se fusiona); su código se reaplica.
- Frontend: `feat/laas-platform` desde `origin/feat/laas-acquisition` + cherry-pick del commit de
  `feat/docker-deploy` (Dockerfile, nginx.conf).

### 7.2 Separación API/worker (reaplicar la referencia)

Todo lo de la referencia aplica igual (monorepo Nest, `apps/api`, `apps/worker`, libs `database`,
`redis` + `RedisLockService`, `queue`, `realtime`, `notifications`, `measurement`, `common`;
Redis obligatorio; leader locks; `device-ops`; `/health` con 503; Docker/deploy/compose por VM),
**incluidas las correcciones de su revisión final** (cliente Redis propio del emitter, espera de
`device-ops` sin `Job.finished()`, etc.). Diferencias por la nueva base:

**Librerías de dispositivos, partidas en dos:**
- `libs/laas-catalog` (`@app/laas-catalog`) — **puro, sin E/S**: tipos del contrato
  (`device-plugin.interface.ts` sin las implementaciones), los `service-description.json` de cada
  modelo, validación de descripciones, catálogo/registry de *descripciones*, `acquisition`,
  `configuration` (funciones puras), `experiments`/`experiment-config` puros. La API lo usa.
- `libs/device-drivers` (`@app/device-drivers`) — **E/S**: clases de plugin
  (`getSensorData`, `setActuatorData`, `testConnection`, `read/applyLiveConfiguration`),
  transportes SCPI/Prologix, registry de *drivers*. **Solo el worker lo importa.**
- Un plugin sigue siendo **una carpeta**: `libs/device-drivers/src/plugins/<modelo>/` con su
  `*.plugin.ts`, y su `service-description.json` vive en `libs/laas-catalog/src/plugins/<modelo>/`.
  Añadir un modelo = crear esas dos piezas y registrarlo en la lista de cada lib. El worker
  comprueba al arrancar que cada descripción del catálogo tiene driver y viceversa (falla si no).

**Operaciones de dispositivo vía worker (`device-ops`, request/response con timeout):**

| Job | Usado por (API) | Timeout por defecto |
|---|---|---|
| `test-connection` | `POST /devices/test-connection` | `DEVICE_TEST_TIMEOUT_MS` 5000 |
| `read-live-configuration` | `GET /devices/:id/configuration` (valores `live`) | `DEVICE_OP_TIMEOUT_MS` 10000 |
| `apply-live-configuration` | `PUT /devices/:id/configuration` | `DEVICE_OP_TIMEOUT_MS` |
| `set-actuator-data` | `PUT /laas/v1/actuators/:actuatorId/data` | `DEVICE_OP_TIMEOUT_MS` |

Mismo mecanismo de espera que el `test-connection` corregido (listeners globales propios,
`removeOnComplete/removeOnFail: {age: 60}`). Si vence el timeout: lectura en vivo → valor `null`
(como hoy cuando falla la lectura); escritura → 504 `El laboratorio no respondió a tiempo`.

**Estado ocupado/configurando en Redis (sustituye a `DeviceActivityService` en memoria):**
- Medición: el processor ya toma `withDeviceLocks([sensorId, selectorId])`; eso define "midiendo".
- `apply-live-configuration`, `set-actuator-data` y la persistencia de configuración toman el mismo
  lock de dispositivo **sin esperar** (`tryAcquire`): si está tomado → 409 con los mensajes
  actuales (`"<name>" está midiendo; espera a que termine…`).
- "Ocupado" para la vista de configuración = existe `lock:device:<id>` **o** hay un ScheduledJob
  `running` que lo usa (lógica actual de `runningJobDeviceIds`).
- Se elimina `DeviceActivityService`; sus specs se reescriben sobre `RedisLockService`.

**Valores `live` sin estado en el driver:** hoy `KronosMux16Plugin` guarda el último canal en un
`Map` del proceso (el MUX no permite leerlo). Con N workers eso daría valores aleatorios. Regla
nueva: los drivers no guardan estado. El **core** registra el último valor aplicado de cada
parámetro `live` en Redis (`live:<deviceId>` → hash `{ <param>: valor, updatedAt }`) cada vez que
pasa por `applyLiveConfiguration`, por `setActuatorData` (servicio LaaS) o por el cambio de canal
de una medición (el valor del actuador que corresponde a un parámetro `live` homónimo).
`read-live-configuration` llama a `readLiveConfiguration` del plugin si lo implementa y devuelve
algo distinto de `null`; si no, usa el valor registrado en Redis; si no hay, `null`. El MUX deja de
implementar `readLiveConfiguration` (no puede leer el equipo). Comportamiento visible igual que hoy
("Canal activo" = último canal activado).

**Tiempo real:** `RealtimePublisher` reproduce los emits de los gateways de esta base, incluido
`deviceStatus` a salas `team:<teamId>` (resolviendo los equipos del proyecto con Prisma, como hace
hoy el gateway) y, en la API, la revocación (`WS_AUTH_ERROR` + `disconnectSockets` vía adapter).
El middleware de autenticación de sockets permanece en la API.

### 7.3 Servicios LaaS (`/laas/v1`, en la API)

Identificadores de instancia: un equipo registrado (`devices.id`) con sus sensores/actuadores del
catálogo. `sensorId` LaaS = `<deviceId>:<sensorId del catálogo>`; `actuatorId` LaaS =
`<deviceId>:<actuatorId del catálogo>`. Alcance: equipos no archivados de los proyectos del
equipo de trabajo del usuario (como el resto de la API).

| Servicio (§4.3) | Ruta | Permiso | Respuesta |
|---|---|---|---|
| Metadata | `GET /laas/v1/metadata` | **público** | §7.4 |
| getSensorMetadata | `GET /laas/v1/sensors` (`?deviceId=` opcional) | `device:view` | Tabla 14 por instancia, con `sensorConfiguration` (Tabla 16) y `lastMeasured` |
| getSensorData | `GET /laas/v1/sensors/:sensorId/data` (`?taskId=` opcional) | `measurement:view` | la **última medición tomada con ese equipo y sensor** (de cualquier tarea del equipo de trabajo, o de `taskId` si se indica), con todos sus canales: `{ sensorId, measurementId, taskId, lastMeasured, acquisition, sensorValues, channels: [{ channel, points: [{x?, values}] }] }`; 404 si no hay lecturas |
| getSensorData (fresh) | `GET /laas/v1/sensors/:sensorId/data?fresh=true&taskId=..&channels=1,2` | `measurement:execute` | 202 `{ jobId, taskId, estimatedSeconds }`; reutiliza la admisión de mediciones de la tarea (rangos de su configuración); la tarea debe usar ese equipo como sensor (si no → 400). Progreso y resultado por los eventos existentes |
| getActuatorMetadata | `GET /laas/v1/actuators` (`?deviceId=`) | `device:view` | Tabla 19 por instancia |
| setActuatorData | `PUT /laas/v1/actuators/:actuatorId/data` body `{ values: { <name>: number } }` | `device:edit` | 200 `{ actuatorId, values, appliedAt }`; 400 si fuera de `rangeMinimum/Maximum/Step`; 409 ocupado; 504 sin respuesta |
| getConfiguration | `GET /laas/v1/configuration/:deviceId` | `device:view` | vista actual de configuración del dispositivo (mismo cuerpo que `GET /devices/:id/configuration`) |
| setConfiguration | `PUT /laas/v1/configuration/:deviceId` | `device:edit` | igual que `PUT /devices/:id/configuration` |
| getExperiment (opcional) | `GET /laas/v1/experiments` (`?projectId=`) | `device:view` | Tabla 20: `{ experimentId, fullName, description, sensors: string[], actuators: string[] }` (ids LaaS de instancias si hay `projectId`; ids de catálogo si no) |
| getClients (opcional) | `GET /laas/v1/clients` | público | `[{ name: 'Kronos', url: FRONTEND_URL }]` |

- **Atribución de lecturas:** hoy una medición solo guarda nombre/IP del equipo. Nueva migración
  (barata: la base de vm-data es nueva) que añade a `measurements` las columnas nullable
  `sensorDeviceId` (uuid, FK a `devices`, `ON DELETE SET NULL`), `sensorId` (id del sensor en el
  catálogo) y `channelSelectorDeviceId` (uuid, FK, `SET NULL`), rellenadas por `measureTask`, con
  índice `(sensorDeviceId, sensorId, takenAt DESC)`. `getSensorData` y `lastMeasured` de
  `getSensorMetadata` usan esas columnas (no la configuración actual de la tarea).
- `getConfiguration/setConfiguration` se exponen **por dispositivo** (decisión ya tomada en la base;
  el estándar no fija el nivel). Las rutas `/devices/...` existentes se mantienen para el frontend;
  `/laas/v1/...` reutiliza los mismos servicios (sin duplicar lógica).
- Validación de seguridad (§4.4.1): rangos de actuador con los `actuatorValues` declarados;
  rangos de barrido con los límites declarados por el sensor (ya existe en la base).

### 7.4 Documento de metadatos (`GET /laas/v1/metadata`)

Generado en tiempo de ejecución a partir del catálogo y la configuración; sin datos de equipos
concretos (público).

```json
{
  "title": "...", "description": "...", "termsOfServiceURL": "...", "contact": "...",
  "license": "...", "licenseUrl": "...",
  "basePath": "https://<API_DOMAIN>/laas/v1",
  "apis": [ { "identifier": "/sensors/{sensorId}/data", "protocol": "http",
              "produces": "application/json",
              "operations": [ { "method": "GET", "nickname": "getSensorData", "summary": "...",
                                "notes": "...", "type": "SensorData",
                                "parameters": [ { "name": "sensorId", "description": "...",
                                                  "required": true, "paramType": "path" } ],
                                "responseMessages": "200 ...; 404 ..." } ] } ],
  "models": [ { "id": "SensorData", "required": [...], "properties": { ... } } ],
  "authorization": { "authorizationType": "SSO protocol", "keyName": "Authorization",
                     "authServiceUrl": "<SUPABASE_URL>/auth/v1" },
  "concurrency": { "interactionMode": "asynchronous" },
  "x-kronos": { "deviceModels": [ <descripciones del catálogo> ],
                "events": { "namespace": "/measurements", "progress": "measurement:progress", ... } }
}
```

- Tabla 1 desde variables de entorno `LAAS_TITLE`, `LAAS_DESCRIPTION`, `LAAS_TERMS_URL`,
  `LAAS_CONTACT`, `LAAS_LICENSE`, `LAAS_LICENSE_URL` (con valores por defecto razonables).
- Tablas 2–6: `apis` lista **todas** las operaciones de §7.3; `models` describe sus cuerpos.
  `paramType` en la tabla del estándar es "Integer"; se publica el texto (`path`/`query`/`body`)
  como extensión documentada (decisión del diseñador, ver §9).
- Tabla 7: Supabase como SSO; además se acepta el JWT propio (`/auth/login`), documentado en
  `notes`.
- Tabla 9: `interactionMode: asynchronous` (se prepara, se encola y se recibe). Con modo asíncrono
  el estándar no exige `concurrencyScheme`/`roles`.
- **`protocol` en sensores/actuadores publicados = `http`** (cómo los alcanza el cliente). El
  protocolo con el equipo (`tcp`, `http`, `simulated`) se publica como `x-deviceProtocol`.

### 7.5 Despliegue

Igual que la referencia, con base de datos nueva: la imagen de la API aplica `prisma migrate deploy`
y la primera vez se ejecuta `npm run seed` (documentado en `deploy/README.md`). El script opcional
`migrate-data.sh` se corrige para volcar/restaurar/contar el esquema de la aplicación (`platform`,
el de `schemas` en `schema.prisma`) en lugar de `public`, con su precheck de destino vacío sobre ese
esquema; se valida con `bash -n` y con las herramientas simuladas (no se ejecuta contra datos). Nuevas variables:
`DEVICE_OP_TIMEOUT_MS`, `LAAS_*`. El frontend usa su Dockerfile.

## 8. Decidido por el usuario

- Base A (`feat/laas-acquisition`); organización centrada en LaaS (lectura 1).
- getSensorData opción C; experimentos existentes; medición ligada a tarea.
- 3 VMs; Supabase Auth se mantiene; datos actuales no se migran (base nueva).
- Commits sin `Co-Authored-By`.

## 9. Decisiones del diseñador (revisables)

- Partir `device-plugins` en `laas-catalog` (puro) + `device-drivers` (E/S) para que la API use los
  metadatos sin acceso al laboratorio.
- Nuevas operaciones `device-ops` y estado ocupado en Redis; 504 en timeout de escritura.
- IDs LaaS de instancia `<deviceId>:<id de catálogo>`.
- `paramType` publicado como texto; `protocol` publicado como `http` + `x-deviceProtocol`.
- Metadatos y `getClients` públicos; resto con login y permisos actuales.
- `/devices/...` se mantienen; `/laas/v1/...` reutiliza los servicios.
- Drivers sin estado; último valor `live` aplicado registrado por el core en Redis.
- Nueva migración con `sensorDeviceId`/`sensorId`/`channelSelectorDeviceId` en `measurements`;
  `getSensorData` = última medición del equipo+sensor (filtrable por `taskId`).
- `migrate-data.sh` corregido al esquema `platform`.

## 10. Testing

- Specs existentes de la base movidas con su código, en verde.
- Nuevos: composición de módulos (API sin drivers, worker sin controllers de negocio); paridad
  catálogo↔drivers al arrancar el worker; cada job `device-ops`; 409 por lock; documento de
  metadatos (campos de Tablas 1–9 presentes, una operación por servicio de §7.3); cada endpoint
  `/laas/v1` (permisos, ids, rangos de actuador, fresh → 202 con jobId, 404 sin lecturas);
  `RealtimePublisher` con salas `team:`.
- Verificación con Docker cuando esté disponible (e2e realtime, imágenes, arranque, medición con
  simuladores de punta a punta).
