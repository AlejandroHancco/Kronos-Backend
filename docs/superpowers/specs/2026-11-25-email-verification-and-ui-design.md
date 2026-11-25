# Diseño: verificación de email propia (Brevo) + estilo unificado

Fecha: 2026-11-25 · Estado: aprobado por el usuario · Ramas: `feat/laas-platform` (backend y frontend)

## Por qué
Los usuarios que se registran con contraseña quedan atrapados en `/verify-email`: nada envía el
correo ni marca `emailVerified`. Además, varias pantallas en uso conservan el estilo antiguo (slate).

## Enfoques
- **A) Verificación propia en el backend + Brevo (elegido):** un solo sistema de usuarios; Brevo envía
  a cualquier destinatario verificando solo un remitente (sin dominio), 300/día gratis, API HTTPS.
- B) Verificación con Supabase: el SMTP por defecto de Supabase solo envía a miembros del equipo del
  proyecto, exige SMTP propio igualmente y acopla dos sistemas de usuarios. Descartado.

## Backend
- Tabla `email_verification_tokens` (schema `platform`, migración nueva): `id`, `userId` (FK users.uuid,
  ON DELETE CASCADE), `tokenHash` (SHA-256 hex, único), `expiresAt`, `usedAt?`, `createdAt`.
  Índice por `userId`. Nunca se guarda el token en claro.
- Registro (`POST /auth/register`): crea el usuario (`emailVerified=false`), genera token aleatorio de
  32 bytes (base64url), TTL `EMAIL_VERIFICATION_TTL_HOURS` (default 24), envía el correo con
  `${FRONTEND_URL}/confirm-email?token=<token>`. Un fallo de envío no rompe el registro (se loguea).
- `POST /auth/verify-email { token }` (público, throttled): token válido, no usado y no expirado →
  `emailVerified=true`, `usedAt=now`; responde `{ verified: true, email }`. Si no → 400
  `El enlace no es válido o expiró`.
- `POST /auth/resend-verification` (JWT): si ya verificado → `{ alreadyVerified: true }`; si el último
  token del usuario tiene < 60 s → 429 `Espera un minuto antes de pedir otro correo`; si no, invalida los
  tokens pendientes (marca `usedAt`) y envía uno nuevo → `{ sent: true }`.
- `MailService` (Brevo `POST https://api.brevo.com/v3/smtp/email`, header `api-key`), variables
  `BREVO_API_KEY`, `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME` (default `Kronos`). Sin `BREVO_API_KEY`: no envía y
  escribe el enlace en el log (warn) — modo desarrollo. Timeout 10 s.
- Correo en español, HTML + texto plano: asunto `Confirma tu correo en Kronos`.
- Usuarios Google: sin cambios (ya vienen verificados).

## Frontend
- Ruta pública `/confirm-email?token=…` (fuera de PrivateRoute): llama a `/auth/verify-email`;
  éxito → si hay sesión, a `/join-team`; si no, botón `Iniciar sesión`. Error → mensaje y, si hay sesión,
  botón `Reenviar correo`.
- `/verify-email`: `Reenviar correo` llama a `/auth/resend-verification` (no a Supabase); mantiene el
  sondeo de `/auth/me` cada 10 s; muestra el 429 como aviso.
- `OnboardingLayout` con el mismo marco que `LoginPage` (bg-background, logo KRONOS, `KronosCard`
  centrada, pie). Aplicado a: verificar correo, confirmar correo, unirse a un equipo, en revisión,
  rechazado, suspendido.
- `TeamRequestsPage` y `DeviceFormModal`: tokens del tema (`bg-card`, `text-foreground`,
  `text-muted-foreground`, `border-border`…) y componentes `Kronos*`; sin cambios de comportamiento.
- Borrar ficheros sin uso: `components/DashboardLayout`, `features/auth/components/Login`,
  `features/projects/components/*` sin importadores, `components/task/ChannelMetadataModal`,
  `components/Navbar` si nada lo importa tras lo anterior.

## Despliegue
Variables Brevo en `deploy/single-vm/.env.example` y `deploy/vm-app/.env.example`; redeploy de api y
frontend en la VM app; corregir el email de la cuenta de prueba y reenviar el correo.

## No-objetivos
Recuperación de contraseña, cambio de email, plantillas de correo con diseño elaborado.
