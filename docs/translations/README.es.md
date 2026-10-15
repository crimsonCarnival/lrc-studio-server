# LRC Studio — Servidor

El backend de [LRC Studio](https://www.lrcstudio.app), una plataforma de sincronización de letras. Una API en Fastify 5 que sirve REST, GraphQL y WebSockets sobre MongoDB, además de la canalización de transcripción con IA que impulsa el Estampado Automático.

**[Aplicación en vivo](https://www.lrcstudio.app)** · [GitHub](https://github.com/crimsonCarnival/lrc-studio) · [README del cliente](../../../client/README.md)

> Idiomas: [English (Inglés)](../../README.md)

## Tabla de Contenidos

- [Arquitectura](#arquitectura)
- [Mapa de Módulos](#mapa-de-módulos)
- [Referencia de la API](#referencia-de-la-api)
  - [`/health`](#health)
  - [`/auth`](#auth)
  - [`/projects`](#projects)
  - [`/lyrics` y `/editor`](#lyrics-y-editor--análisis-y-operaciones-del-editor)
  - [`/lyrics` búsqueda e importación](#lyrics--búsqueda-e-importación)
  - [`/asr`](#asr--estampado-automático)
  - [`/uploads`](#uploads)
  - [`/settings`](#settings)
  - [`/notifications`](#notifications)
  - [Otros endpoints](#song-metadata-youtube-google-og)
  - [`/admin`](#admin)
  - [GraphQL](#graphql--post-graphql)
  - [Socket.IO](#socketio)
- [Subsistemas Clave](#subsistemas-clave)
  - [Autenticación y Sesiones](#autenticación-y-sesiones)
  - [Permisos](#permisos)
  - [Estampado Automático (ASR)](#estampado-automático-asr)
  - [Proveedores de Letras](#proveedores-de-letras)
  - [Persistencia de Proyectos y Letras](#persistencia-de-proyectos-y-letras)
  - [URLs de Proyectos y Slugs](#urls-de-proyectos-y-slugs)
  - [Artistas Destacados](#artistas-destacados)
  - [Nombres de Cuenta](#nombres-de-cuenta)
  - [Vistas Previas de Enlaces (Open Graph)](#vistas-previas-de-enlaces-open-graph)
  - [Gamificación](#gamificación)
  - [Tareas en Segundo Plano](#tareas-en-segundo-plano)
- [Empezando](#empezando)
- [Variables de Entorno](#variables-de-entorno)
- [Scripts](#scripts)
- [Pruebas](#pruebas)
- [Notas Operativas](#notas-operativas)
- [Licencia](#licencia)

## Arquitectura

```text
Cliente (React 19)
  │
  ├── REST        → Fastify 5          CRUD, auth, subidas, admin, ASR
  ├── GraphQL     → Mercurius          lecturas sociales: perfiles, feed, explorar, listas
  └── WebSocket   → Socket.IO          cambios de proyecto, acks de autoguardado, notificaciones, progreso ASR

Fastify 5
  ├── Mongoose 8  → MongoDB
  ├── Cloudinary  → subidas directas firmadas (el binario nunca pasa por este servidor)
  └── Groq        → transcripción Whisper para Estampado Automático
```

La división es deliberada: **REST** gestiona mutaciones, archivos y todo lo que necesite semántica HTTP concreta; **GraphQL** gestiona consultas sociales de mucha lectura donde el cliente quiere moldear la respuesta. `loaders.ts` aporta procesamiento por lotes estilo DataLoader para evitar consultas N+1. La introspección está desactivada en producción y la profundidad de consulta se limita a 12.

Las capas dentro de cada módulo son estrictas: las rutas registran y declaran cadenas de `preHandler`, los controladores traducen HTTP a llamadas de servicio, y los servicios contienen toda la lógica de negocio y todas las consultas de Mongoose. Los controladores nunca contienen lógica de negocio, y los servicios nunca conocen `FastifyRequest`.

## Mapa de Módulos

| Módulo | Responsabilidad |
|---|---|
| `auth` | Registro, inicio de sesión, llaves de acceso (WebAuthn), intercambio OTT de Google OAuth, sesiones, rotación de tokens de refresco, apelaciones, arranque de superadministrador por variable de entorno |
| `password-reset` / `email-verification` | Flujos de tokens transaccionales, separados de `auth` |
| `projects` | CRUD de proyectos, clonar/bifurcar, compartir, estrella, impulso, activar/desactivar bifurcaciones, slugs legibles en las URLs y la regla «un proyecto debe tener nombre» |
| `artists` | Registros de artistas por usuario, autocompletado sobre la propia biblioteca y migración de las cadenas de artista heredadas (ver [Artistas Destacados](#artistas-destacados)) |
| `lyrics` | Analizar LRC/SRT/TXT, compilar a LRC/SRT, desplazamiento masivo, desfase global, detección de duplicados, inferencia de tiempos de fin |
| `asr` | **Estampado Automático** — transcripción Groq Whisper, extracción de audio de YouTube con yt-dlp, alineación letra/transcripción, almacén de trabajos |
| `genius` | Búsqueda e importación de letras mediante una cadena de varios proveedores (ver [Proveedores de Letras](#proveedores-de-letras)) |
| `uploads` | URLs firmadas de Cloudinary para audio/avatar/portada, registros de medios, persistencia de URLs de YouTube |
| `song-metadata` | Búsqueda de metadatos de pistas (API de Spotify como proveedor, Last.fm como reserva) |
| `youtube` | Obtención de metadatos vía oEmbed |
| `settings` | Ajustes por usuario con sincronización diferencial por ruta; las actualizaciones parciales se fusionan campo a campo |
| `admin` | Banear/desbanear, apelaciones, bloqueo de IP y dispositivo, asignación de roles, conjuntos de permisos por rol, registros de auditoría, baneo en la sombra |
| `blocks` | Bloqueo entre usuarios (distinto de los bloqueos de red administrativos) |
| `requests` | Flujo de propuestas del personal — solo GraphQL, con carga útil en lista blanca y reclamación atómica al aprobar |
| `badges` | Definiciones de insignias, otorgar/revocar, análisis retroactivos, recompensas de XP |
| `progression` | Progresión de XP y niveles |
| `stats` | Niveles de adicción, clasificación |
| `activity` | Feed de actividad y mapa de calor privado de autoría |
| `explore` | Consultas de tendencias y popularidad |
| `reactions` | Reacciones con emoji en proyectos y comentarios |
| `notifications` | Estado leído/no leído, entrega en tiempo real |
| `users` | Búsqueda pública de usuarios y lectura de perfiles; historial de nombres de cuenta (los nombres antiguos siguen resolviendo) |
| `user_logs` | `UserActionLog` — escrito por servicios, nunca por controladores |
| `og` | Metadatos de vista previa de enlaces (`/og/meta`), páginas para rastreadores e imágenes de tarjeta para proyectos, perfiles y listas |
| `email` | Transporte SMTP |
| `health` | Comprobación de estado |

## Referencia de la API

Todas las rutas, sus guardas y la estructura de su petición/respuesta.

**Convenciones.** Todas las respuestas son JSON salvo indicación contraria. Toda petición debería enviar `X-Device-Id`; las rutas de `/auth` lo **exigen**. Las cookies (`credentials: 'include'`) llevan la autenticación — los tokens nunca van en el cuerpo. `lines[]` es el array compartido de líneas de letra (`text`, `timestamp`, `endTime`, `secondary`, `translations[]`, `words[]`, `type`, `label`, `singers[]`). Los errores son `{ error: string }` con un código estable, más `{ retryAfter }` en un 429.

**Guardas** (decoradores de Fastify, ver [Permisos](#permisos)):

| Guarda | Significado |
|---|---|
| — | Pública |
| `optionalAuth` | Define `userId` si hay un token válido; nunca rechaza |
| `requireAuth` | 401 sin token válido; 403 si está baneado |
| `requireActiveUser` | `requireAuth` + comprobación de baneo de dispositivo/IP |
| `requireAuthForAppeal` | `requireAuth` sin la comprobación de baneo |
| `requireStaff` | Debe tener al menos un permiso |
| `perm(x)` | Debe tener el permiso `x` |
| `sudo` | Cookie `adminSudo` válida (TTL de 5 minutos) |
| `requireSuperadmin` | Literalmente `role === 'superadmin'` |

### `/health`

| Método | Ruta | Guarda | Petición | Respuesta |
|---|---|---|---|---|
| GET | `/health/live` | — | — | `{ status: 'ok' }` |
| GET | `/health/ready` | — | — | `{ status, checks: { database } }` — 503 si la BD falla |
| GET | `/health` | — | — | Informe de estado completo — 503 si hay error |

### `/auth`

Aquí los límites de tasa se basan **solo en la IP**, nunca en la cabecera de dispositivo que envía el cliente.

| Método | Ruta | Guarda | Límite | Petición | Respuesta |
|---|---|---|---|---|---|
| POST | `/register` | — | 3/h | `{ accountName?, email?, password, recaptchaToken? }` (se exige accountName o email; contraseña ≥8) | Define cookies → `{ user }` |
| POST | `/login` | — | 10/min | `{ identifier, password, recaptchaToken? }` | Define cookies → `{ user }` |
| POST | `/check-identifier` | — | 10/min | `{ identifier }` | `{ exists, methods }` — qué métodos aplican |
| POST | `/refresh` | — | — | Cuerpo ignorado; lee la **cookie** `refreshToken` | Rota ambas cookies → `{ user }` |
| POST | `/logout` | `optionalAuth` | — | — | Borra las cookies |
| GET | `/me` | `requireAuth` | — | — | `{ user }` |
| PATCH | `/profile` | `requireAuth` | — | `{ avatarUrl?, avatarPublicId?, accountName?, email?, bio? }` (bio ≤160) | `{ user }` |
| POST | `/appeal` | `requireAuthForAppeal` | — | `{ message }` | `{ ok }` |
| POST | `/forgot-password` | — | 10/min | `{ email }` | `{ ok }` (nunca revela si existe) |
| GET | `/reset-password/validate` | — | 10/min | `?token` | `{ valid }` |
| POST | `/reset-password` | — | 10/min | `{ token, password }` | `{ ok }` |
| POST | `/change-password` | `requireAuth` | — | `{ currentPassword, newPassword }` | `{ ok }` |
| POST | `/set-password` | `requireAuth` | — | `{ password }` — para cuentas solo OAuth | `{ ok }` |
| POST | `/verify-email` | — | 10/min | `{ token }` | `{ ok }` |
| GET | `/sessions` | `requireAuth` | — | — | `[{ id, deviceId, ip, userAgent, createdAt, expiresAt, current }]` |
| DELETE | `/sessions/:id` | `requireAuth` | — | — | `{ ok }` |
| POST | `/logout-all` | `requireAuth` | — | — | Revoca todas las sesiones |
| GET | `/passkey/register/options` | `requireAuth` | — | — | `PublicKeyCredentialCreationOptions` de WebAuthn |
| POST | `/passkey/register/verify` | `requireAuth` | — | Respuesta de atestación WebAuthn | `{ verified }` |
| POST | `/passkey/login/options` | — | 10/min | `{ identifier? }` | `PublicKeyCredentialRequestOptions` de WebAuthn |
| POST | `/passkey/login/verify` | — | 10/min | Respuesta de aserción WebAuthn | Define cookies → `{ user }` |
| GET | `/passkeys` | `requireAuth` | — | — | `[{ id, name, createdAt, transports }]` |
| DELETE | `/passkeys/:id` | `requireAuth` | — | — | `{ ok }` |
| POST | `/deactivate` | `requireAuth` | — | — | Borrado lógico de la cuenta |
| POST | `/exchange-ott` | — | 20/min | `{ ott }` — el token de un solo uso de Google | Define cookies → `{ user }` |

### `/projects`

> **Nota:** las rutas REST de `/projects` ya no están registradas: el CRUD de proyectos lo sirve GraphQL (`createProject`, `updateProject`, `deleteProject`, `cloneProject`; ver [GraphQL](#graphql--post-graphql)). La tabla de abajo muestra las formas de petición heredadas. Los artistas, los slugs y la regla del «proyecto con nombre» se describen en [Artistas Destacados](#artistas-destacados) y [URLs de Proyectos y Slugs](#urls-de-proyectos-y-slugs).

| Método | Ruta | Guarda | Petición | Respuesta |
|---|---|---|---|---|
| POST | `/projects` | `requireActiveUser` | `{ title?, uploadId?, lyrics?, state?, metadata?, readOnly?, public?, ytUrl?, uploadUrl?, uploadPublicId?, fileName?, duration?, recaptchaToken? }` | `{ project }` con un `publicId` nanoid(10) |
| GET | `/projects` | `requireActiveUser` | — | `{ projects }` |
| GET | `/projects/:id` | `optionalAuth` | `:id` = `publicId` | `{ project, lyrics, upload }` |
| PUT | `/projects/:id` | `requireActiveUser` | Cuerpo completo (como POST) | `{ project }` |
| PATCH | `/projects/:id` | `requireActiveUser` | Cualquier subconjunto, más `version` y `saveKind: 'manual'\|'auto'` | `{ project, version }`; emite `project:updated` + `autosave:ack` |
| DELETE | `/projects/:id` | `requireActiveUser` | — | `{ ok }` |
| GET | `/projects/share/:id` | — | — | Proyecto de solo lectura para enlaces compartidos |

`lyrics` en un PATCH acepta un reemplazo completo o un parche posicional quirúrgico:

```jsonc
// reemplazo completo
{ "lyrics": { "editorMode": "lrc", "language": "en", "sections": [ { "label": "Verse", "singers": [], "lines": [] } ] } }

// una línea    → sections.<sectionIdx>.lines.<lineIdx>
{ "lyrics": { "sectionIdx": 0, "lineIdx": 4, "line": { "text": "…", "timestamp": 63.42 } } }

// una palabra  → …lines.<lineIdx>.words.<wordIndex>
{ "lyrics": { "sectionIdx": 0, "lineIdx": 4, "wordIndex": 2, "word": { "word": "close", "time": 11.4 } } }
```

Límites: `sectionIdx ≤ 2000`, `lineIdx ≤ 10000`, `wordIndex ≤ 2000`.

### `/lyrics` y `/editor` — análisis y operaciones del editor

El mismo router está montado bajo **ambos** prefijos, así que cada ruta responde en `/lyrics/…` *y* en `/editor/…`. Todas son públicas y sin estado: transforman `lines[]` y lo devuelven.

| Método | Ruta | Petición | Respuesta |
|---|---|---|---|
| POST | `/parse` | `{ content, filename? }` (≤5 MB; la extensión elige LRC/SRT/TXT) | `{ lines, detectedFormat, count, metadata, artists }` — ver abajo |
| POST | `/compile/lrc` | `{ lines, includeTranslations?, includeSecondary?, precision?: 'hundredths'\|'thousandths', wordPrecision?, metadata?, includeFeaturedInTitle?, lineEndings?: 'lf'\|'crlf', exportTranslationIndex? }` | `{ output, format }` |
| POST | `/compile/srt` | `{ lines, duration?, includeTranslations?, includeSecondary?, lineEndings?, srtConfig? }` | `{ content }` |
| POST | `/infer-end-times` | `{ lines, duration?, srtConfig? }` | `{ lines }` |
| POST | `/mark` | `{ lines, activeLineIndex, time, editorMode, settings, activeWordIndex?, stampTarget?: 'main'\|'secondary', awaitingEndMark?, lastAction? }` | `{ lines, activeLineIndex, awaitingEndMark }` |
| POST | `/bulk-shift` | `{ lines, selectedIndices, delta }` | `{ lines }` |
| POST | `/global-offset` | `{ lines, delta }` | `{ lines }` |
| POST | `/clear-all` | `{ lines, isSrt?, isWords? }` | `{ lines }` |
| POST | `/clear-line` | `{ lines, index, isSrt?, isWords? }` | `{ lines }` |
| POST | `/detect-duplicates` | `{ lines, threshold? }` | `{ duplicates }` |

**Artistas destacados en los archivos LRC.** `POST /compile/lrc` acepta `metadata.artists` (`[{ name, role }]`): `[ar:]` pasa a ser entonces los créditos formateados (`Drake feat. Rihanna & Kanye`), por encima de un `metadata.ar` simple. `[ti:]` se queda con el título tal cual salvo que `includeFeaturedInTitle` sea `true`, que escribe `Título (feat. Rihanna & Kanye)`. Si el cuerpo omite `includeFeaturedInTitle`, una petición con sesión (cookie) usa el ajuste guardado `settings.export.includeFeaturedInTitle` del usuario; las anónimas reciben `false`; un `true`/`false` explícito siempre gana. Créditos inválidos → `422 { error, code }`.

`POST /parse` devuelve además las etiquetas de cabecera del archivo y lo que el analizador compartido hace con ellas (para `.lrc`/`.txt`; `{}`/`null` en otro caso):

```jsonc
{ "metadata": { "ti": "Canción (feat. B)", "ar": "A & B" },
  "artists": { "credits": [{ "name": "A", "role": "primary", "order": 0 }],
               "title": "Canción", "display": "A feat. B",
               "flags": [{ "code": "ambiguous_separator", "source": "artist", "text": "A & B" }] } }
```

### `/lyrics` — búsqueda e importación

`optionalAuth`, 20 peticiones/minuto. Ver [Proveedores de Letras](#proveedores-de-letras).

| Método | Ruta | Petición | Respuesta |
|---|---|---|---|
| GET | `/lyrics/search` | `?q` (obligatorio) | `{ results: [{ id, title, artist, album?, duration?, synced?, thumbnail, url, provider }] }` — `id` va con espacio de nombres (`lrclib:123`) cuando es resoluble |
| GET | `/lyrics/extract` | `?track` (obligatorio), `?artist`, `?album`, `?duration`, `?id` | `{ lyrics, synced, provider }` · `422 lyrics_unavailable` si ningún proveedor la tiene |

### `/asr` — Estampado Automático

Todas las rutas con `requireAuth`, 10 peticiones/hora. El progreso también se emite por Socket.IO como `asr:progress`.

| Método | Ruta | Petición | Respuesta |
|---|---|---|---|
| POST | `/asr/stamp` | `{ lines: [{ index, text, wordTokens? }], fuzzyTolerance?: 0.5–1 }` más **exactamente uno** de `uploadId` o `youtubeUrl` (ambos o ninguno → 400) | `{ jobId }` |
| POST | `/asr/stamp/upload` | `multipart/form-data`: el campo `payload` (`{ lines, fuzzyTolerance? }` como JSON) **debe ir antes** de la parte `file`; ≤50 MB, 1 archivo | `{ jobId }` |
| GET | `/asr/jobs/:id` | — | `{ jobId, phase, result?, errorCode? }` · **404** si no es tuyo |
| GET | `/asr/jobs/:id/audio` | — | Bytes del audio extraído (para la forma de onda) · 404 si no es tuyo |
| POST | `/asr/jobs/:id/cancel` | — | `{ cancelled }` |

`phase` ∈ `starting, fetching_audio, extracting_audio, transcribing, aligning, applying, completed, failed, cancelled`. Cada entrada de `result[]` es `{ index, timestamp, endTime, confidence, status, words }` con `status` ∈ `matched, partial, low, none`.

Códigos de error: `asr_invalid_key`, `asr_no_audio`, `asr_unsupported_audio`, `asr_empty_transcript`, `asr_rate_limited`, `asr_timeout`, `asr_network`, `asr_cancelled`, `asr_malformed_response`, `asr_youtube_blocked`, `asr_youtube_unavailable`, `asr_ytdlp_not_configured`, `asr_job_not_found`.

### `/uploads`

| Método | Ruta | Guarda | Límite | Petición | Respuesta |
|---|---|---|---|---|---|
| POST | `/signature` | `optionalAuth` | — | `{ fileName, fileSize }` (≤50 MB), `recaptchaToken?` | `{ signature, timestamp, apiKey, cloudName, folder }` |
| POST | `/avatar-signature` | `requireAuth` | 5/h | — | Parámetros firmados de Cloudinary |
| POST | `/cover-signature` | `requireAuth` | 20/h | — | Parámetros firmados de Cloudinary |
| GET | `/media` | `requireActiveUser` | — | `?limit` (≤100, por defecto 50), `?offset` | `{ uploads }` |
| GET | `/media/:id` | `requireActiveUser` | — | — | `{ upload }` |
| POST | `/media` | `requireActiveUser` | — | `{ source: 'cloudinary'\|'youtube', uploadUrl?, publicId?, fileName?, title?, duration? }` | `{ upload }` |
| PATCH | `/media/:id` | `requireActiveUser` | — | `{ title?, fileName?, duration? }` | `{ upload }` |
| DELETE | `/media/:id` | `requireActiveUser` | — | — | `{ ok }` |

El binario nunca pasa por este servidor: el cliente sube directamente a Cloudinary con la firma y después lo registra con `POST /media`.

### `/settings`

> **Nota:** los ajustes se leen y escriben por GraphQL (`settings`, `updateSettings`, `resetSettings`); las rutas REST de abajo son heredadas. `updateSettings` fusiona **campo a campo**: enviar `{ export: { stripEmptyLines: true } }` ya no borra el resto de campos de `export`. Novedad: `export.includeFeaturedInTitle` (booleano, se lee como `false` si nunca se definió).

Todas con `requireAuth`. Los cuerpos se validan contra el árbol completo de ajustes (`playback`, `editor`, `export`, `interface`, `shortcuts`, `import`, `advanced`, `autoStamp`).

| Método | Ruta | Petición | Respuesta |
|---|---|---|---|
| GET | `/settings` | — | `{ settings }` |
| PUT | `/settings` | Objeto de ajustes completo | `{ settings }` |
| PATCH | `/settings` | Ajustes parciales (fusión profunda) | `{ settings }` |
| DELETE | `/settings` | — | Restablece los valores por defecto |

### `/notifications`

Todas con `requireAuth`. También se entregan en vivo por Socket.IO.

| Método | Ruta | Petición | Respuesta |
|---|---|---|---|
| GET | `/notifications` | — | `{ notifications, unreadCount }` |
| POST | `/notifications/read` | `{ ids }` | `{ ok }` |
| POST | `/notifications/read-all` | — | `{ ok }` |
| DELETE | `/notifications/:id` | — | `{ ok }` |

### `/song-metadata`, `/youtube`, `/google`, `/og`

| Método | Ruta | Guarda | Límite | Petición | Respuesta |
|---|---|---|---|---|---|
| GET | `/song-metadata/lookup` | — | 20/min | `?songName` (obligatorio), `?artistName` | Metadatos de la pista (título, artista, álbum, año, portada…) |
| GET | `/youtube/search` | `optionalAuth` | 30/min | `?q` | Resultados de búsqueda |
| GET | `/youtube/availability` | `optionalAuth` | 30/min | `?videoId` (11 caracteres) | Disponibilidad más un motivo de fallo concreto |
| GET | `/youtube/check-embed` | `optionalAuth` | 30/min | `?videoId` | Alias **obsoleto** que devuelve la forma antigua `{ embeddable }` |
| GET | `/google/auth/url` | `requireAuth` | — | — | `{ url }` — para vincular Google a una cuenta existente |
| GET | `/google/login/url` | — | — | — | `{ url }` — para iniciar sesión |
| GET | `/google/auth/callback` | — | — | `?code&state` | HTML que envía por `postMessage` un token de un solo uso a la ventana que lo abrió |
| POST | `/google/disconnect` | `requireAuth` | — | — | `{ disconnected }` · 409 `last_auth_method` si es el único método de acceso |
| GET | `/og/project/:publicId` | — | — | `?s` (tiempo de inicio), `?list`, `?hl` | **HTML** (no JSON) con etiquetas Open Graph/Twitter y redirección a la URL canónica con slug (se conservan `?s` / `?list`), bajo un nonce CSP por respuesta · 404 si es privado o no existe |
| GET | `/og/meta` | — | sí | `?path` (una ruta de la aplicación web, p. ej. `/32blunts/projects/radiohead-creep-<id>`), `?hl` | Metadatos JSON de vista previa. **Siempre 200**; un recurso privado/inexistente/oculto es idéntico byte a byte a uno que no existe. Ver [Vistas Previas de Enlaces](#vistas-previas-de-enlaces-open-graph) |
| GET | `/og/image/:type/:id.png` | — | sí | `type` ∈ `project\|profile\|list` | 302 a una tarjeta de 1200×630 (o la tarjeta de la marca) |

### `/admin`

Un hook `onRequest` aplica `requireStaff` a **todas** las rutas siguientes. Las acciones destructivas necesitan además un permiso *y* una concesión `sudo` reciente. El personal solo puede actuar sobre rangos estrictamente inferiores.

| Método | Ruta | Guarda | Petición | Respuesta |
|---|---|---|---|---|
| GET | `/sudo/factors` | personal | — | `{ factors }` — métodos de reautenticación disponibles |
| POST | `/sudo` | personal | `{ password? }` | Define la cookie `adminSudo` (5 min) |
| POST | `/sudo/passkey/options` | personal | — | Opciones de solicitud WebAuthn |
| POST | `/sudo/passkey/verify` | personal | Aserción WebAuthn | Define la cookie `adminSudo` |
| GET | `/users` | `perm('users.view')` | `?cursor`, `?limit` (≤100), `?search`, `?role`, `?status` ∈ `all\|active\|banned\|pending\|deleted\|verified\|premium` | `{ users, nextCursor }` |
| GET | `/stats` | `perm('stats.view')` | — | Agregados del panel |
| GET | `/audit-logs` | `perm('audit.view')` | `?page`, `?limit` (≤100) | `{ logs, total }` |
| GET | `/banned-ips` | `perm('network.block')` | — | `{ ips }` |
| GET | `/banned-devices` | `perm('network.block')` | — | `{ devices }` |
| POST | `/users/:id/ban` | `perm('users.ban')` + sudo | `{ reason?, bannedUntil?, banIp?, banDevice? }` | `{ user }` |
| POST | `/users/:id/unban` | `perm('users.ban')` + sudo | — | `{ user }` |
| POST | `/users/:id/reject-appeal` | `perm('users.ban')` + sudo | — | `{ user }` |
| POST | `/users/:id/shadowban` | `perm('users.shadowban')` + sudo | `{ feed, search, reason? }` | `{ user }` |
| POST | `/users/:id/unshadowban` | `perm('users.shadowban')` + sudo | — | `{ user }` |
| POST | `/users/:id/role` | `perm('users.role')` + sudo | `{ role: 'user'\|'mod'\|'admin'\|'superadmin' }` | `{ user }` |
| DELETE | `/users/:id` | `perm('users.delete')` + sudo | — | `{ ok }` |
| POST | `/users/:id/reactivate` | `perm('users.delete')` + sudo | — | `{ user }` |
| POST | `/banned-ips` | `perm('network.block')` + sudo | `{ ip, reason? }` | `{ entry }` |
| DELETE | `/banned-ips/:id` | `perm('network.block')` + sudo | — | `{ ok }` |
| POST | `/banned-devices` | `perm('network.block')` + sudo | `{ deviceId, reason? }` | `{ entry }` |
| DELETE | `/banned-devices/:id` | `perm('network.block')` + sudo | — | `{ ok }` |
| POST | `/xp` | `perm('xp.adjust')` + sudo | `{ userId, delta, reason? }` | `{ user }` |
| GET | `/permissions` | `requireSuperadmin` | — | `{ permissions, rolePresets, editableRoles }` |
| PUT | `/permissions/roles/:role` | `requireSuperadmin` + sudo | `:role` ∈ solo `mod\|admin`; `{ permissions: [] }` | `{ rolePresets }` |
| PUT | `/permissions/users/:id` | `requireSuperadmin` + sudo | `{ permissions: [] }` | `{ user }` |

> La gestión de permisos se controla por el `role` literal, no por una cadena de permiso: otorgar permisos *es* la superficie de escalada de privilegios, así que no debe poder delegarse.

### GraphQL — `POST /graphql`

Límite de profundidad 12; introspección desactivada en producción. El contexto es `{ userId, bannedUserId, ip, tokenExpired, socketId }`. Las mutaciones sin autenticar lanzan `UNAUTHORIZED`.

**Consultas**

| Consulta | Argumentos | Devuelve |
|---|---|---|
| `health` | — | `HealthStatus!` |
| `me` | — | `User` |
| `project` | `id: ID!` | `Project` |
| `projects` | `limit, offset` | `[Project!]!` |
| `publicProject` | `publicId: String!` | `Project` |
| `getShare` | `id: ID!` | `Project` |
| `upload` / `uploads` | `id: ID!` / `limit, offset` | `Upload` / `[Upload!]!` |
| `settings` | — | `Settings` |
| `publicProfile` | `accountName: String!, asVisitor: Boolean` | `PublicUser` |
| `followList` | `accountName: String!, type: FollowListType!, offset` | `FollowListResult!` |
| `blockedUsers` | — | `[BlockedUser!]!` |
| `playlist` / `playlists` | `id: ID!` / `accountName: String!` | `Playlist` / `[Playlist!]!` |
| `savedPlaylists` | — | `[Playlist!]!` |
| `feed` | `offset, limit` | `FeedResult!` |
| `userActivity` | `offset, limit` | `FeedResult!` |
| `userActivityHeatmap` | — | `[ActivityHeatmapDay!]!` |
| `searchProjects` | `query: String!, sortBy: SearchSort, offset, limit` | `SearchResult!` |
| `searchUsers` | `query: String!, limit` | `[FollowUser!]!` |
| `trendingProjects` | `offset, limit` | `ProjectPage!` |
| `popularPlaylists` | `offset, limit` | `PlaylistPage!` |
| `suggestedUsers` | `limit` | `[FollowUser!]!` |
| `exploreStats` | — | `ExploreStats!` |
| `projectReactions` | `publicId: String!` | `ProjectReactions!` |
| `leaderboard` | `limit, offset` | `LeaderboardResult!` |
| `badgeDefinitions` | — | `[BadgeDef!]!` |
| `publicBadgeDefinitions` | — | `[PublicBadgeDef!]!` |
| `userShowcase` | `accountName: String!` | `[ShowcasedBadge!]!` |
| `myMusicLibrary` | — | `[MusicLibraryEntry!]!` — solo artistas principales |
| `myArtistSuggestions` | `prefix: String!, limit, offset` | `ArtistSuggestionPage!` — coincidencia por prefijo sobre los artistas **del propio usuario**, `limit` ≤ 20 |
| `parseArtists` | `artist: String!, title: String` | `ParsedArtists!` — lo que el analizador compartido lee de una cadena de artista / título (créditos, título limpio, avisos, texto formateado) |
| `userContentStats` | — | `ContentStats!` |
| `adminAddictionLevels` | — | `[AddictionLevel!]!` |
| `myPreferences` | — | `UserPreferences!` |
| `myRequests` / `pendingRequests` / `reviewedRequests` | — | `[StaffRequest!]!` |
| `requestCapabilities` / `requestCounts` | — | `RequestCapabilities!` / `RequestCounts!` |

**Mutaciones**

| Mutación | Argumentos | Devuelve |
|---|---|---|
| `createProject` | `input: CreateProjectInput!` | `Project!` |
| `updateProject` | `id: ID!, input: UpdateProjectInput!` | `Project!` |
| `deleteProject` | `id: ID!` | `Boolean!` |
| `updateLyrics` | `publicId: String!, input: UpdateLyricsInput!` | `Lyrics!` |
| `cloneProject` | `id: ID!` | `Project!` — bifurcación |
| `starProject` / `unstarProject` | `id: ID!` | `Project!` |
| `boostProject` | `publicId: ID!` | `Boolean!` |
| `setForksEnabled` | `publicId: ID!, enabled: Boolean!` | `Project!` |
| `reactToProject` | `publicId: String!, emoji: String!` | `ProjectReactions!` |
| `incrementProjectView` / `incrementProjectShare` | `id: ID!` | `Boolean!` |
| `incrementPlaylistView` / `incrementPlaylistShare` | `id: ID!` | `Boolean!` |
| `updateProfile` | `input: UpdateProfileInput!` (`accountName`, `displayName`, `email`, `bio`, `avatarUrl`) | `User!` |
| `updateSettings` / `resetSettings` | `input: UpdateSettingsInput!` / — | `Settings!` / `Boolean!` |
| `updatePreferences` | `input: UpdatePreferencesInput!` (visibilidad, notificaciones, `showActivityHeatmap`, insignias del mini-perfil) | `UserPreferences!` |
| `saveMedia` / `deleteMedia` | `input: SaveMediaInput!` / `id: ID!` | `Upload!` / `Boolean!` |
| `sendVerificationEmail` | — | `Boolean!` |
| `follow` / `unfollow` | `accountName: String!` | `Boolean!` |
| `blockUser` / `unblockUser` | `accountName: String!` | `Boolean!` |
| `createPlaylist` | `input: CreatePlaylistInput!` | `Playlist!` |
| `updatePlaylist` | `id: ID!, input: UpdatePlaylistInput!` | `Playlist!` |
| `deletePlaylist` | `id: ID!` | `Boolean!` |
| `addProjectToPlaylist` / `removeProjectFromPlaylist` | `playlistId: ID!, publicId: ID!` | `Playlist!` |
| `reorderPlaylist` | `playlistId: ID!, publicIds: [ID!]!` | `Playlist!` |
| `savePlaylist` / `unsavePlaylist` | `playlistId: ID!` | `Boolean!` |
| `updateShowcase` | `badgeIds: [String!]!, showcasePublic: Boolean` | `UpdateShowcaseResult!` |
| `adminGrantBadge` | `userIdentifier: String!, badgeId: String!` | `Boolean!` |
| `adminRevokeBadge` | `userId: ID!, badgeId: String!` | `Boolean!` |
| `adminCreateBadge` / `adminUpdateBadge` | `input: BadgeDefInput!` / `id: String!, input` | `BadgeDef!` |
| `adminDeleteBadge` | `id: String!` | `Boolean!` |
| `adminRetroactiveScan` | `badgeId: String!` | `RetroactiveResult!` |
| `adminCreateAddictionLevel` / `adminUpdateAddictionLevel` | `input` / `id: String!, input` | `AddictionLevel!` |
| `adminDeleteAddictionLevel` | `id: String!` | `Boolean!` |
| `adminShadowBan` | `userId: ID!, feed: Boolean!, search: Boolean!, reason: String` | `Boolean!` |
| `adminUnshadowBan` | `userId: ID!` | `Boolean!` |
| `submitRequest` | `type: String!, payload: String!` (cadena JSON, en lista blanca en el servidor) | `StaffRequest!` |
| `reviewRequest` | `id: ID!, decision: String!, note: String` | `StaffRequest!` — reclamación atómica; se rechaza la autorrevisión |

**Notas sobre entradas y resultados**

- **Metadatos del proyecto.** `Project.slug` (`String!`) es el slug legible de la URL; `Project.metadata.artists` es `[ArtistCredit!]!` y `metadata.songArtist` es el texto formateado **derivado y de solo lectura**. Se eliminó `ProjectMetadataInput.songArtist`; envía `artists: [{ name, role }]` (omitido = conservar, `[]` = vaciar). Ver [Artistas Destacados](#artistas-destacados).
- **Errores.** `createProject` / `updateProject` fallan con `extensions: { code, status }`: `project_identity_required` (422) y los códigos `artist_*` / `artists_*` indicados en [Artistas Destacados](#artistas-destacados).
- **Nombres de cuenta.** `publicProfile`, `followList`, `userShowcase` y `playlists` aceptan también un nombre de cuenta *anterior* y devuelven el `accountName` **actual** del usuario; el cliente redirige. Ver [Nombres de Cuenta](#nombres-de-cuenta).
- **Ajustes.** `updateSettings` fusiona campo a campo (ver [`/settings`](#settings)); `settings { export { includeFeaturedInTitle } }` es el valor guardado de la opción de exportación LRC.

### Socket.IO

Los clientes se unen a las salas `user:{userId}` y `project:{publicId}`.

| Evento | Dirección | Carga |
|---|---|---|
| `project:updated` | → cliente | Difundido a la sala del proyecto tras un parche correcto |
| `autosave:ack` | → cliente | Solo al socket que originó la petición |
| `asr:progress` | → cliente | `{ jobId, phase, result?, errorCode? }` |
| `notification` | → cliente | Nueva notificación |
| `session:invalidated` | → cliente | Fuerza el cierre de sesión en el cliente |

## Subsistemas Clave

### Autenticación y Sesiones

Tres métodos: **contraseña** (Argon2), **llave de acceso** (WebAuthn con `@simplewebauthn/server`) y **Google OAuth** (ventana emergente → token de un solo uso → `POST /auth/exchange-ott`).

Los tokens de acceso y de refresco son JWT entregados como cookies `httpOnly`. Cada refresco rota el token y almacena su hash; se permite una ventana breve de reintento mediante `previousRefreshTokenHash`. Reutilizar un token rotado después de esa ventana invalida toda la familia de sesiones (`familyId`) como detección de robo. Los clientes refrescan al 75 % de la vida del token de acceso y agrupan los refrescos concurrentes para que una carrera no parezca un robo.

> **La migración del proyecto de invitado es crítica.** Los usuarios sin autenticar construyen proyectos en `localStorage`. Toda vía de autenticación correcta debe migrar ese borrador a la nueva cuenta. Si añades una ruta de autenticación, conéctale la migración — y nunca borres la copia local si falla.

### Permisos

`role` es **solo descriptivo y nunca concede acceso.** La autorización siempre lee `user.permissions[]`.

Aplícalo a nivel de ruta con `fastify.requirePermission('badges.manage')`, `fastify.requireStaff`, `fastify.requireSudo` o `fastify.requireSuperadmin`, y vuelve a comprobarlo dentro del servicio en cada mutación. Cuando un miembro del personal actúa sobre otro, compara `rankOf()`: solo se puede afectar a rangos estrictamente inferiores. Las acciones administrativas destructivas requieren además una cookie `adminSudo` de 5 minutos.

Los conjuntos de permisos por rol viven en `shared/permissions.ts` y pueden sobrescribirse en la BD solo para `mod` y `admin`; `user` y `superadmin` nunca son sobrescribibles. **El rol de superadministrador se concede exclusivamente con la variable `SUPERADMIN_EMAIL`** — nunca por una ruta HTTP ni por la interfaz. Solo concede, nunca degrada; revocar es un paso manual deliberado con `scripts/grant-role.ts`.

### Estampado Automático (ASR)

Transcribe el audio y lo alinea con la letra del usuario para poder marcar una canción sin hacerlo a mano.

1. **Resolver el audio** — URL de YouTube (extraída con yt-dlp), `uploadId` de Cloudinary o un archivo subido directamente.
2. **Transcribir** — Groq `whisper-large-v3` con `timestamp_granularities[]=word`.
3. **Alinear** — alineación global Needleman-Wunsch entre los tokens de la letra y los de la transcripción, sobre texto normalizado a NFKC y con similitud de Levenshtein por token. Monótona por construcción, que es lo que mantiene el orden de los estribillos repetidos.
4. **Preparar** — los resultados se devuelven para confirmación, no se escriben directamente. Cada línea recibe una puntuación de confianza y un estado `matched | partial | low | none`.

YouTube es totalmente compatible; no es una función exclusiva de archivos locales. Límites: vídeos de 20 minutos, 25 MB de audio, 3 extracciones concurrentes.

Este módulo concentra la mayor parte de la superficie de entrada no confiable del servidor, así que sus protecciones importan:

- Las descargas de Cloudinary exigen `https:` con el host exactamente `res.cloudinary.com` y pasan `redirect: 'error'`, para que una redirección no pueda salir del host validado.
- Los límites de bytes se aplican dos veces — `Content-Length` y de nuevo sobre el flujo real — porque una cabecera ausente o falsa no debe convertirse en un OOM.
- yt-dlp se lanza con `shell: false` y un argv construido por completo en el servidor a partir de un ID de vídeo validado contra `/^[A-Za-z0-9_-]{11}$/`. Nunca interpoles cadenas del usuario en esos argumentos.
- Las lecturas de trabajos comparan la propiedad y devuelven **404, no 403**, para que no se puedan sondear IDs de trabajos.

### Proveedores de Letras

`GET /lyrics/extract` ejecuta una cadena, con cada proveedor aislado para que un fallo ajeno no haga fallar la petición:

| Orden | Proveedor | Requiere clave | Letras sincronizadas |
|---|---|---|---|
| 1 | [LRCLIB](https://lrclib.net) | No | **Sí** — devuelve LRC |
| 2 | LyricFind | Sí (comercial) | Depende de la licencia |
| 3 | [lyrics.ovh](https://api.lyrics.ovh) | No | No |

**Nada de esto necesita configuración.** Sin ninguna clave, la búsqueda recurre a LRCLIB y la consulta ejecuta LRCLIB → lyrics.ovh. LRCLIB es el principal porque es la única fuente que devuelve LRC ya sincronizado — un acierto permite al usuario saltarse tanto la sincronización manual como la transcripción. Se identifica mediante `APP_URL`.

`GET /lyrics/search` prefiere Genius cuando `GENIUS_CLIENT_ACCESS_TOKEN` está definido (portadas, mejor emparejamiento difuso) y recurre a LRCLIB en caso contrario. Las respuestas son `{ lyrics, synced, provider }`.

LyricFind está condicionado a `LYRICFIND_API_KEY` y es una operación nula silenciosa sin ella, ya que requiere un acuerdo comercial y no tiene nivel gratuito. Su estructura de petición/respuesta sigue la interfaz documentada `lyric.do` de LyricFind pero **no se ha verificado con una clave real** — confirma los nombres de los campos con la documentación de tu contrato cuando tengas credenciales.

### Persistencia de Proyectos y Letras

Las letras se guardan como `sections[]` anidadas, cada una con sus `lines[]`. El cliente trabaja con un array plano y convierte en la frontera (`flatToSections` / `sectionsToFlat`). Nunca aceptes líneas planas directamente.

`PATCH /projects/:id` acepta un reemplazo completo de `sections` o un parche posicional quirúrgico (`{ sectionIdx, lineIdx, line }`, opcionalmente hasta `{ wordIndex, word }`). Los campos posicionales **deben** declararse en `projects.schema.ts` — AJV se ejecuta con `removeAdditional`, así que un campo no declarado se elimina en silencio y el parche se convierte en una operación nula. Los límites de índice del esquema replican las constantes `MAX_*_INDEX` del servicio; mantenlos sincronizados.

Tras un parche correcto, el servidor emite `project:updated` a la sala `project:{id}` y `autosave:ack` al socket de origen.

### URLs de Proyectos y Slugs

| Página | URL |
|---|---|
| Proyecto público | `/:accountName/projects/:slug-:publicId` |
| Editor (propietario) | `/:accountName/projects/:slug-:publicId/edit` |
| Perfil / lista | `/:accountName` · `/:accountName/lists/:listId` |
| Heredadas (se siguen leyendo) | `/project/:publicId`, `/profile/:accountName[/lists/:id]`, `/u/:accountName` |

El slug y el nombre de cuenta de una URL son **cosméticos**. Un proyecto se resuelve siempre por `publicId`: los *últimos 10 caracteres* del último segmento de la ruta (el alfabeto de nanoid contiene `-`, así que el id no se obtiene dividiendo por guiones). Por eso un cambio de nombre nunca rompe un enlace y no se guarda historial de slugs.

`src/utils/project-slug.ts` es la única fuente del slug (el cliente web lo replica): pliega los diacríticos latinos con NFD (el dakuten del kana se conserva), pasa a minúsculas, elimina apóstrofos, conserva letras y dígitos de **cualquier** alfabeto, convierte el resto en `-` y limita a 60 caracteres. El slug es `slugify(texto del artista + " " + nombre de la canción)`, si no `slugify(título)`, si no vacío (la URL queda solo con el id). `projectPath()` construye la ruta completa.

`Project.slug` es **derivado y nunca entrada del cliente**. Un hook de pre-validación lo fija al crear/guardar, y cada `findOneAndUpdate` que escribe `title` o `metadata` lo fija en la misma escritura. El campo `slug` de GraphQL lo calcula al vuelo si la fila aún no lo tiene guardado, así que las filas son válidas antes de ejecutar la migración.

**Un proyecto debe tener nombre.** `title`, `metadata.songName` o un artista deben contener al menos una letra o dígito; de lo contrario crear/actualizar falla con `project_identity_required` (422). Una actualización solo se rechaza si eliminaría el *último* de ellos, de modo que las ediciones ajenas a esto en filas heredadas no se bloquean. Una bifurcación de un origen sin nombre recibe un título de reserva (título de la subida → nombre de archivo → `untitled`). Los títulos se recortan y limitan a 200 caracteres; los nombres de canción, a 500.

`pnpm tsx scripts/backfill-project-slugs.ts` rellena `slug` en los proyectos existentes (por lotes, idempotente, con `--dry-run` y `--recompute`; no toca `updatedAt`). Las filas heredadas sin nombre reciben el título de reserva y se cuentan en el registro.

### Artistas Destacados

Una canción tiene una lista ordenada de **créditos**, cada uno `primary` (principal) o `featured` (destacado):

- **Almacenamiento.** `Project.metadata.artists: [{ artistId, name, role, order }]`, respaldado por una colección `artists` por usuario (`userId` + nombre sin distinguir mayúsculas, único). `metadata.songArtist` es el **texto formateado derivado** (`Drake feat. Rihanna & Kanye`) que siguen usando la búsqueda, OG, los slugs y los lectores antiguos; ya no se acepta como entrada. Las filas heredadas conservan su `songArtist` original hasta migrarlas.
- **Código compartido.** `src/utils/artists.ts` contiene el analizador, el formateador y el validador y no tiene importaciones, así que el cliente lo copia tal cual; su archivo de pruebas es la especificación del comportamiento.
- **Formateador.** `A` · `A & B` · `A, B & C` para los principales; los destacados van después como `feat. A` · `feat. A & B` · `feat. A, B & C` (`Principal feat. A & B`).
- **Analizador.** Lee `feat.` / `feat` / `ft.` / `ft` / `featuring` (y `with` solo entre corchetes o paréntesis), sin distinguir mayúsculas, dentro o fuera de corchetes anidados, tanto en la cadena del artista como en el título (devolviendo el título limpio). Separa nombres por `,` `&` `and` `x`. Los casos dudosos se **marcan, nunca se adivinan**: `ambiguous_separator` (*Simon & Garfunkel*), `weak_marker` (`ft` / `feat` sin punto), `empty_feat_segment`, `unbalanced_bracket`, `duplicate_removed`.
- **Validación** (422, `extensions.code`): `artists_invalid`, `artist_role_invalid`, `artist_name_empty`, `artist_name_too_long` (> 300), `artists_too_many` (> 10), `artist_duplicate` (sin distinguir mayúsculas, cualquier rol), `artist_primary_required` (una lista no vacía necesita un principal; `[]` es válido).
- **Escrituras.** Envía `metadata.artists`; omitido conserva los créditos guardados, `[]` los vacía. Nunca se acepta `artistId`: los ids se resuelven por nombre dentro de los registros del propietario. Una bifurcación reasigna los créditos a los registros de quien bifurca. La biblioteca musical guarda solo artistas **principales**.
- **Autocompletado.** `myArtistSuggestions(prefix, limit ≤ 20, offset)` busca solo entre los nombres de artista del propio usuario, por prefijo sin distinguir mayúsculas, como texto plano (sin patrones).
- **Búsqueda.** Los nombres destacados forman parte de `songArtist`, así que las rutas de búsqueda existentes los encuentran; no hace falta cambiar el índice de Atlas.
- **Migración.** `pnpm tsx scripts/migrate-artists.ts` convierte las cadenas heredadas y es un **simulacro por defecto** (`--write` aplica, `--include-ambiguous` aplica también las filas con `&`/`and`/`x` y `ft` sin punto, `--report archivo.json` guarda el informe). Un título / nombre de canción pierde su segmento `feat.` solo cuando se movió a `artists`, y nunca se deja vacío. Las filas mal formadas nunca se aplican. Se puede repetir sin riesgo.

Las formas completas de petición/respuesta, los mensajes de error y las notas para el cliente están en [`docs/featured-artists-api.md`](../featured-artists-api.md).

### Nombres de Cuenta

Cambiar el nombre de una cuenta guarda el anterior en `account_name_history`, de modo que los enlaces antiguos siguen funcionando:

- Las búsquedas por nombre desde una URL (`publicProfile`, `followList`, `userShowcase`, `playlists` y OG) comprueban primero los nombres **actuales** y solo después el historial (la fila más reciente primero). La respuesta lleva el `accountName` *actual* del usuario; el cliente lo compara con la URL y redirige.
- Un nombre antiguo **nunca se reasigna** a otra persona (el registro y el cambio de nombre lo rechazan); su anterior propietario puede recuperarlo, y entonces se libera de su historial. El índice del historial no es único a propósito: la unicidad de un nombre *en uso* se garantiza en el código.
- `RESERVED_USERNAMES` (`modules/auth/auth.validation.ts`) cubre todos los segmentos de ruta de primer nivel de la aplicación web, porque `/:accountName` comparte la raíz con las rutas propias de la app (`admin`, `explore`, `feed`, `library`, `login`, `notifications`, `profile`, `project`, `projects`, `search`, `settings`, `u`, `og`, `api`, …).

### Vistas Previas de Enlaces (Open Graph)

`GET /og/meta?path=` recibe una ruta de la aplicación web y devuelve los metadatos que renderiza el proxy para rastreadores del cliente; `GET /og/project/:id` renderiza los mismos metadatos como HTML. Ambos pasan por `og.meta.service.ts`.

- **Rutas reconocidas:** `/`, `/explore`, `/leaderboard`, `/:accountName`, `/:accountName/lists/:id`, `/:accountName/projects/:slug-:id[/edit]`, además de las formas heredadas `/project/:id` y `/profile/...`. Cada segmento capturado se valida antes de llegar a una consulta.
- **URLs canónicas:** proyectos → `/<propietario>/projects/<slug>-<id>`, perfiles → `/<accountName>`, listas → `/<accountName>/lists/<id>` (las URLs heredadas informan la nueva canónica).
- **Título del proyecto:** `Canción – Artista, Sincronizado por propietario | LRC Studio` (inglés: `Synced by`), el mismo texto que la pestaña del cliente web. La canción recurre al título del proyecto y luego al nombre del sitio; el artista es el texto formateado derivado; el propietario es el nombre de cuenta *actual*. Sin artista esa parte se omite; sin propietario (respaldo heredado) también se omite `Sincronizado por …`. Los títulos de perfil y lista conservan ` — LRC Studio`. Los textos están en `og.strings.ts`; el renderizador escapa todo el HTML.
- **Recursos ocultos** (proyecto privado, propietario bloqueado/eliminado/con shadow ban, ruta desconocida) devuelven todos una misma carga neutra, de modo que nada se filtra y no se puede sondear su existencia.

### Gamificación

XP y niveles, definiciones de insignias con tipos de condición, rangos de adicción definidos por administración y rachas de actividad seguidas con `streak.lastActiveDate`. Las rachas se reinician en los límites de día UTC y se avisa a los usuarios antes de perderlas.

El mapa de calor lee `heatmap_days`, que guarda `projectsCreated` y `editedProjects` por usuario y día UTC. `editedProjects` cuenta **proyectos distintos que recibieron un cambio de contenido guardado**, tanto por autoguardado como por guardado manual — así que autoguardar un proyecto todo el día aporta 1. La deduplicación inserta en `heatmap_project_edits` (índice único en `{userId, projectId, day}`) y solo incrementa el contador cuando la inserción tiene éxito, lo que evita el doble conteo con guardados concurrentes del mismo proyecto. Estos contadores nunca llegan al feed público.

### Tareas en Segundo Plano

Programadas en `plugins/cron.ts` con `setInterval`/`setTimeout` en lugar de una librería de cron:

| Tarea | Frecuencia |
|---|---|
| `recomputeTrendingScores` + `recomputeLeaderboardRanking` | Cada hora |
| `sweepJobs` | Cada hora — descarta trabajos ASR terminados que superan su TTL de 10 minutos |
| `runStreakWarnings` | Tic frecuente, actúa a la hora `STREAK_WARNING_HOUR_UTC`; idempotente por usuario y día UTC |
| `archiveDeletedUsers` | Semanal, domingos a las 02:00 UTC |
| `seedBuiltinBadges`, `seedAddictionLevels`, `syncRolePermissions`, `syncSuperadminEmailGrant` | Una vez al arrancar, todas idempotentes |

Índices TTL: actividades 365 días, `heatmap_days` 400 días, `heatmap_project_edits` 2 días, registros de administración 90 días, IPs/dispositivos baneados 2 años, sesiones en `expiresAt`.

## Empezando

### Prerrequisitos

- **Node.js ≥ 20.3.0** (exigido por `engines`)
- **pnpm** — ambos paquetes usan `pnpm-lock.yaml`
- Una instancia de MongoDB (local o Atlas)
- Opcional: `yt-dlp` en el `PATH` para Estampado Automático con fuentes de YouTube

### Instalación

```bash
git clone https://github.com/crimsonCarnival/lrc-studio.git
cd lrc-studio/server

pnpm install
cp .env.example .env    # define MONGODB_URI, JWT_SECRET, COOKIE_SECRET
pnpm dev                # http://localhost:3000
```

Toda la pila (cliente, servidor, MongoDB) también puede arrancarse desde la raíz del repositorio:

```bash
docker-compose up -d --build
```

## Variables de Entorno

`.env.example` documenta todas las variables. Solo unas pocas son realmente obligatorias.

**Obligatorias** (el servidor no arranca en producción sin ellas):

| Variable | Propósito |
|---|---|
| `MONGODB_URI` | Cadena de conexión a la base de datos |
| `JWT_SECRET` | Firma los tokens de acceso y de refresco |
| `COOKIE_SECRET` | Firma de cookies — debe ser distinta de `JWT_SECRET` |
| `CORS_ORIGIN` | Orígenes permitidos, separados por comas |

**Opcionales destacadas:**

| Variable | Si falta |
|---|---|
| `SUPERADMIN_EMAIL` | Nadie puede recibir el rol de superadministrador. Lista separada por comas, comparada sin distinguir mayúsculas y de forma exacta |
| `GROQ_API_KEY` | El Estampado Automático devuelve `asr_invalid_key`; nada más se ve afectado |
| `YTDLP_PATH` / `YTDLP_POT_PROVIDER_URL` | El Estampado Automático no puede usar fuentes de YouTube. El proveedor de PO-token es prácticamente obligatorio en producción: YouTube aplica comprobación antibots a las IPs de centros de datos |
| `GENIUS_CLIENT_ACCESS_TOKEN` | La búsqueda de letras recurre a LRCLIB (que sigue funcionando e indica qué resultados están sincronizados) |
| `LYRICFIND_API_KEY` | LyricFind se omite en silencio |
| `CLOUDINARY_*` | Sin subidas de audio, avatar ni portada |
| `EMAIL_SMTP_*` | No se envían correos de verificación ni de restablecimiento |
| `RECAPTCHA_SECRET_KEY` | La protección antibots en registro y subidas queda inactiva |
| `TRACK_METADATA_*`, `LASTFM_API_KEY` | Sin búsqueda de metadatos. El formulario de registro de Last.fm pide una URL de retorno, pero solo su flujo de autenticación *de usuario* la usa — la consulta a nivel de aplicación la ignora, así que cualquier URL sirve |

Nunca subas `.env` al repositorio. Nunca registres ni muestres valores secretos.

## Scripts

| Comando | Descripción |
|---|---|
| `pnpm dev` | Servidor de desarrollo en modo vigilancia (`tsx watch`) |
| `pnpm build` | Compila TypeScript a `dist/` |
| `pnpm start` | Ejecuta el servidor compilado |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest, una ejecución |
| `pnpm test:watch` | Vitest en modo vigilancia |
| `pnpm test:coverage` | Informe de cobertura |

Los scripts de mantenimiento puntuales se ejecutan con `pnpm tsx scripts/<nombre>.ts` y necesitan `MONGODB_URI`. Los dos de abajo son idempotentes y se pueden repetir sin riesgo:

| Script | Propósito |
|---|---|
| `backfill-project-slugs.ts` | Rellena `Project.slug` en los proyectos existentes. `--dry-run` solo informa; `--recompute` reescribe también las filas ya rellenas |
| `migrate-artists.ts` | Convierte las cadenas `songArtist` heredadas en `artists` estructurados. **Simulacro salvo con `--write`**; `--include-ambiguous`, `--report <archivo>` |

## Pruebas

Vitest con `mongodb-memory-server`, de modo que las suites corren contra una MongoDB real en memoria en lugar de simulaciones.

Las suites viven junto al código como `*.test.ts`. Las suites puras (analizador/formateador de artistas, slugs, títulos y análisis de rutas de OG, fusión de ajustes, exportación LRC) corren en cualquier sitio. Las suites con base de datos usan `mongodb-memory-server`, que descarga un binario de `mongod` la primera vez, por lo que necesitan acceso de red a `fastdl.mongodb.org`; sin él fallan al arrancar, no en una aserción. Las suites que usan transacciones corren sobre un conjunto de réplicas de un solo nodo.

## Notas Operativas

Dos subsistemas guardan estado en la memoria del proceso y **se rompen al escalar horizontalmente**:

- **Almacén de trabajos ASR** (`asr/job.store.ts`) — un `Map` con TTL de 10 minutos. Un cliente que consulte `GET /asr/jobs/:id` puede dar con una instancia que nunca ejecutó ese trabajo y recibir un 404 espurio.
- **Cola de propuestas pendientes** — una cola de prioridad en memoria.

Ambos necesitan un almacén respaldado por la base de datos antes de ejecutar más de una instancia.

## Licencia

MIT.
