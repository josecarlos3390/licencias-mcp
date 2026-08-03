> **Nota de migración:** esta guía vive ahora en el proyecto `sap-hana-mcp-license-server` (`licencias-mcp`). Los paths que mencionan `backend/license-server/` deben interpretarse como la raíz de este proyecto.

# Guía: Backend de licenciamiento y knowledge base en Railway/Render

Esta guía documenta paso a paso cómo desplegar el servidor en la nube que:

1. Valida licencias del MCP por hardware ID.
2. Almacena organizaciones, suscripciones y licencias.
3. Sirve artículos de base de conocimiento para sincronización remota.

> **Reutilizable:** esta misma configuración se puede aplicar a otros MCP. Solo hay que cambiar el producto registrado en la tabla `mcp_products` y ajustar las features por plan.

---

## 1. Estructura del backend

```
sap-hana-mcp-license-server/
├── package.json
├── server.js                 # API principal
├── Procfile                  # Para Railway
├── .env.example              # Variables de entorno
├── private-key.pem           # Clave privada RSA (no commitear)
└── scripts/
    ├── init-db.js            # Crea tablas en PostgreSQL
    ├── migrate-add-kb-cases.js
    └── migrate-add-vouchers.js
```

---

## 2. Esquema de base de datos (PostgreSQL)

### Tablas

| Tabla | Descripción |
|-------|-------------|
| `organizations` | Empresas/clientes. Campos: `code`, `name`, `contact_email`, `country`, `is_active`. |
| `mcp_products` | Productos MCP (ej. `hana-b1`, `otro-mcp`). |
| `subscriptions` | Suscripción de una organización a un producto. Campos: `plan`, `status`, `start_date`, `end_date`, `max_installations`. |
| `licenses` | Licencia vinculada a un hardware key. Campos: `hardware_key`, `token`, `expires_at`, `is_active`, `last_seen_at`. |
| `kb_articles` | Artículos de conocimiento descargables. Campos: `path`, `title`, `version`, `content`, `checksum`, `is_active`. |

### Campos sugeridos para futura extensión

Puedes agregar más columnas según necesidades comerciales:

- `organizations.billing_address`, `tax_id`, `phone`.
- `subscriptions.auto_renew`, `price`, `currency`, `payment_status`.
- `licenses.notes`, `friendly_name`, `ip_address`.
- `kb_articles.tags`, `language`, `audience`.

---

## 3. Preparación local

### 3.1 Instalar dependencias

```bash
cd backend/license-server
npm install
```

### 3.2 Copiar clave privada

Copia el archivo `private-key.pem` (generado previamente con `scripts/generate-license-keys.js`) a `backend/license-server/private-key.pem`.

```bash
cp ../../private-key.pem ./private-key.pem
```

### 3.3 Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env`:

```env
PORT=3000
NODE_ENV=development
ADMIN_API_KEY=tu-clave-secreta-muy-larga
DATABASE_URL=postgresql://user:pass@localhost:5432/license_db
JWT_PRIVATE_KEY_PATH=./private-key.pem
DEFAULT_LICENSE_DAYS=365
```

### 3.4 Crear base de datos local (opcional, para pruebas)

```bash
createdb license_db
npm run db:init
```

### 3.5 Iniciar servidor local

```bash
npm run dev
```

Verifica que responde:

```bash
curl http://localhost:3000/health
```

---

## 4. Endpoints de administración

Todos requieren header `X-API-Key: <ADMIN_API_KEY>`.

### 4.1 Crear organización (cliente/empresa)

```bash
curl -X POST http://localhost:3000/admin/organizations \
  -H "Content-Type: application/json" \
  -H "X-API-Key: tu-clave-secreta-muy-larga" \
  -d '{
    "code": "gruporoda",
    "name": "Grupo Roda",
    "contact_email": "admin@gruporoda.com",
    "country": "Nicaragua"
  }'
```

Respuesta:

```json
{
  "id": "uuid",
  "code": "gruporoda",
  "name": "Grupo Roda",
  ...
}
```

### 4.2 Crear producto MCP

```bash
curl -X POST http://localhost:3000/admin/products \
  -H "Content-Type: application/json" \
  -H "X-API-Key: tu-clave-secreta-muy-larga" \
  -d '{
    "code": "hana-b1",
    "name": "HANA MCP Server for SAP Business One",
    "description": "Agente MCP para diagnóstico de SAP HANA y Service Layer"
  }'
```

### 4.3 Crear suscripción

```bash
curl -X POST http://localhost:3000/admin/subscriptions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: tu-clave-secreta-muy-larga" \
  -d '{
    "organization_id": "<uuid-organizacion>",
    "product_id": "<uuid-producto>",
    "plan": "enterprise",
    "end_date": "2027-07-04",
    "max_installations": 3,
    "price": 1200.00,
    "currency": "USD",
    "billing_cycle": "yearly",
    "next_billing_date": "2028-07-04",
    "payment_provider": "manual"
  }'
```

### 4.4 Crear licencia para un hardware ID

El cliente debe enviarte su hardware ID. Puede obtenerlo con:

```bash
node -e "console.log(require('./src/licensing/hardware-id').getHardwareId())"
```

Luego generas la licencia:

```bash
curl -X POST http://localhost:3000/admin/licenses \
  -H "Content-Type: application/json" \
  -H "X-API-Key: tu-clave-secreta-muy-larga" \
  -d '{
    "subscription_id": "<uuid-suscripcion>",
    "hardware_key": "<hardware-id-del-cliente>",
    "days": 365
  }'
```

Respuesta:

```json
{
  "license": { "id": "...", ... },
  "token": "eyJhbGciOiJSUzI1NiIs...",
  "expires_at": "2027-07-04T..."
}
```

Copia el `token` y envíalo al cliente.

### 4.5 Subir artículo de KB

```bash
curl -X POST http://localhost:3000/admin/kb-articles \
  -H "Content-Type: application/json" \
  -H "X-API-Key: tu-clave-secreta-muy-larga" \
  -d '{
    "product_id": "<uuid-producto>",
    "path": "sap-b1/service-layer-crash.md",
    "title": "Service Layer heap corruption KBA 3733425",
    "version": "1.0",
    "content": "---\ndate: 2026-07-04\n..."
  }'
```

---

### 4.6 Publicar release para auto-update

```bash
curl -X POST http://localhost:3000/admin/releases \
  -H "Content-Type: application/json" \
  -H "X-API-Key: tu-clave-secreta-muy-larga" \
  -d '{
    "product_id": "<uuid-producto>",
    "version": "1.1.0",
    "download_url": "https://tu-cdn.com/hana-mcp-client-1.1.0.zip",
    "checksum": "<sha256-del-zip>",
    "release_notes": "Mejoras de rendimiento y diagnósticos.",
    "is_mandatory": false
  }'
```

### 4.7 Listar releases

```bash
curl -H "X-API-Key: tu-clave-secreta-muy-larga" \
  http://localhost:3000/admin/releases
```

### 4.8 Dashboard de telemetría

```bash
# Resumen de actividad
curl -H "X-API-Key: tu-clave-secreta-muy-larga" \
  "http://localhost:3000/admin/dashboard/overview?hours=24"

# Instalaciones activas
curl -H "X-API-Key: tu-clave-secreta-muy-larga" \
  http://localhost:3000/admin/dashboard/installations

# Uso de tools y errores recientes
curl -H "X-API-Key: tu-clave-secreta-muy-larga" \
  "http://localhost:3000/admin/dashboard/usage?hours=24"
```

---

## 5. Endpoints públicos (consumidos por el MCP)

### 5.1 Validar licencia

```bash
curl -X POST http://localhost:3000/api/license/validate \
  -H "Content-Type: application/json" \
  -d '{
    "token": "<jwt-token>",
    "hwid": "<hardware-id>",
    "product": "hana-b1",
    "version": "1.0.0"
  }'
```

Respuesta si es válida:

```json
{
  "active": true,
  "hwid": "...",
  "plan": "enterprise",
  "product": "hana-b1",
  "features": ["hana", "knowledge-base", "remote-support", "backup"],
  "subscription_end": "2027-07-04",
  "message": "License valid"
}
```

### 5.2 Consultar nueva versión (auto-update)

```bash
curl "http://localhost:3000/api/version?product=hana-b1"
```

Respuesta:

```json
{
  "version": "1.1.0",
  "download_url": "https://tu-cdn.com/hana-mcp-client-1.1.0.zip",
  "checksum": "...",
  "release_notes": "Mejoras de rendimiento y diagnósticos.",
  "is_mandatory": false,
  "created_at": "2026-07-04T..."
}
```

### 5.3 Heartbeat / telemetría

```bash
curl -X POST http://localhost:3000/api/telemetry/heartbeat \
  -H "Content-Type: application/json" \
  -d '{
    "hwid": "<hardware-id>",
    "product": "hana-b1",
    "version": "1.0.0",
    "license_status": "VALID",
    "features": ["hana", "knowledge-base"]
  }'
```

### 5.4 Evento de telemetría

```bash
curl -X POST http://localhost:3000/api/telemetry/event \
  -H "Content-Type: application/json" \
  -d '{
    "hwid": "<hardware-id>",
    "product": "hana-b1",
    "event_type": "tool_execution",
    "payload": { "tool": "hana_execute_query", "success": true }
  }'
```

### 5.5 Listar KB remoto

```bash
curl "http://localhost:3000/api/kb/list?product=hana-b1"
```

### 5.6 Descargar artículo

```bash
curl http://localhost:3000/api/kb/download/<article-uuid>
```

---

## 6. Configuración del MCP cliente

En el archivo `.env` del cliente:

```env
HANA_LICENSE_KEY=<token-jwt-generado-por-admin>
HANA_LICENSE_SERVER_URL=https://tu-app.railway.app/api/license/validate
HANA_KB_REMOTE_URL=https://tu-app.railway.app/api/kb
HANA_LICENSE_PRODUCT_CODE=hana-b1
```

O en `mcp.json`:

```json
{
  "mcpServers": {
    "hana": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\hana-mcp-agent\\hana-mcp-server.js"],
      "env": {
        "HANA_LICENSE_KEY": "<token-jwt>",
        "HANA_LICENSE_SERVER_URL": "https://tu-app.railway.app/api/license/validate",
        "HANA_KB_REMOTE_URL": "https://tu-app.railway.app/api/kb",
        "HANA_LICENSE_PRODUCT_CODE": "hana-b1",
        "HANA_HOST": "...",
        "HANA_USER": "...",
        "HANA_PASSWORD": "...",
        "HANA_SCHEMA": "..."
      }
    }
  }
}
```

---

## 7. Despliegue en Railway

### 7.1 Crear proyecto

1. Ve a [https://railway.app](https://railway.app).
2. Crea un nuevo proyecto.
3. Elige **Deploy from GitHub repo** o sube el código manualmente.

### 7.2 Agregar PostgreSQL

1. En el proyecto, haz clic en **New** → **Database** → **Add PostgreSQL**.
2. Railway creará automáticamente la variable `DATABASE_URL`.

### 7.3 Configurar variables de entorno

En **Variables**, agrega:

| Variable | Valor |
|----------|-------|
| `NODE_ENV` | `production` |
| `ADMIN_API_KEY` | Clave larga y aleatoria |
| `JWT_PRIVATE_KEY_PATH` | `/app/private-key.pem` |
| `DEFAULT_LICENSE_DAYS` | `365` |

`DATABASE_URL`, `PORT` y `RAILWAY_*` las gestiona Railway.

### 7.4 Subir clave privada

Railway no permite subir archivos directamente. Opciones:

- **Opción A (recomendada):** almacenar el contenido de `private-key.pem` en una variable de entorno `JWT_PRIVATE_KEY` y modificar `server.js` para leer de variable.
- **Opción B:** incluir el archivo en el repo (solo en deploy privado), asegurándote de que `.gitignore` lo ignore en el repo público.

Para Opción A, modifica `server.js`:

```js
const privateKey = process.env.JWT_PRIVATE_KEY
  ? process.env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n')
  : fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
```

Y en Railway crea la variable `JWT_PRIVATE_KEY` con el contenido completo de `private-key.pem`.

### 7.5 Inicializar base de datos

Después del primer deploy, ejecuta:

```bash
railway run npm run db:init
```

O conecta a la consola de Railway y corre el script.

### 7.6 Verificar deploy

```bash
curl https://tu-app.railway.app/health
```

---

## 8. Planes y features

El backend define features según el plan de la suscripción:

| Plan | Features |
|------|----------|
| `starter` | `hana` |
| `professional` | `hana`, `knowledge-base` |
| `enterprise` | `hana`, `knowledge-base`, `remote-support`, `backup` |

Para otros MCP, cambia los nombres de planes y features en la función `getFeaturesForPlan` de `server.js`.

---

## 9. Consideraciones de seguridad

- Usar siempre **HTTPS** en producción.
- Proteger `ADMIN_API_KEY` y rotarla periódicamente.
- No loguear tokens completos.
- Limitar intentos de validación (rate limiting) con un middleware adicional.
- Almacenar `private-key.pem` como variable de entorno, nunca en el repositorio.
- Respaldar la base de datos PostgreSQL periódicamente.

---

## 10. Adaptar a otro MCP

Para reutilizar este backend con otro MCP:

1. Copiar la carpeta `backend/license-server` al otro proyecto.
2. Registrar un nuevo producto en `mcp_products` (por ejemplo `otro-mcp`).
3. Ajustar `getFeaturesForPlan` en `server.js` según el nuevo producto.
4. Copiar `src/licensing/` y `src/knowledge-base/` al otro MCP.
5. En el otro MCP, instalar `jsonwebtoken`, `node-machine-id`, `dotenv`, `axios`.
6. Agregar la validación de licencia y sincronización KB al inicio del servidor.
7. Configurar `.env` del cliente:
   - `HANA_LICENSE_SERVER_URL=https://tu-app.railway.app/api/license/validate`
   - `HANA_KB_REMOTE_URL=https://tu-app.railway.app/api/kb`
   - `HANA_LICENSE_PRODUCT_CODE=otro-mcp`
8. Documentar el proceso en `docs/license-server-portable-config.md` del otro proyecto.

### Checklist portable

- [ ] Generar par de claves RSA (`scripts/generate-license-keys.js`) o reutilizar el existente.
- [ ] Copiar `src/licensing/public-key.pem` al nuevo MCP.
- [ ] Guardar `private-key.pem` solo en el backend/Railway.
- [ ] Desplegar backend con `scripts/deploy-license-server.ps1` (Windows) o `.sh` (Linux/macOS).
- [ ] Ejecutar `npm run db:init` en Railway.
- [ ] Crear organización, producto, suscripción y licencia mediante endpoints `/admin/*`.
- [ ] Entregar token JWT al cliente y configurar `.env`/`mcp.json`.
- [ ] Verificar que `hana_show_license_info` (o equivalente) reporta estado `VALID`.
- [ ] Verificar sincronización remota de KB con `hana_search_knowledge_base`.

---

## 11. Facturación y cobros

El schema incluye una capa básica de billing para saber cuándo cobrar y cuándo expira cada cliente.

### Campos de billing en `subscriptions`

| Campo | Uso |
|-------|-----|
| `price` | Precio del plan. |
| `currency` | Moneda (default `USD`). |
| `billing_cycle` | `monthly`, `yearly`, etc. |
| `payment_status` | `pending`, `paid`, `past_due`, `cancelled`. |
| `payment_provider` | Ej. `stripe`, `paypal`, `manual`. |
| `provider_subscription_id` | ID externo de la pasarela. |
| `next_billing_date` | Próxima fecha de cobro. |
| `last_invoice_at` | Última factura generada. |

### Tablas

- `invoices` → facturas por período.
- `payments` → pagos registrados, vinculados a invoice o subscription.

### Endpoints administrativos

```bash
# Resumen de billing
curl -H "X-API-Key: <ADMIN_API_KEY>" \
  https://tu-app.railway.app/admin/billing/overview

# Suscripciones por vencer en N días
curl -H "X-API-Key: <ADMIN_API_KEY>" \
  "https://tu-app.railway.app/admin/billing/expiring?days=30"

# Marcar expiraciones y past_due automáticamente
curl -X POST -H "X-API-Key: <ADMIN_API_KEY>" \
  https://tu-app.railway.app/admin/billing/check-expirations

# Crear factura manual
curl -X POST -H "X-API-Key: <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "subscription_id": "<uuid>",
    "organization_id": "<uuid>",
    "invoice_number": "INV-001",
    "period_start": "2026-07-01",
    "period_end": "2027-06-30",
    "amount": 1200,
    "currency": "USD",
    "due_date": "2026-07-15"
  }' \
  https://tu-app.railway.app/admin/invoices

# Registrar pago
curl -X POST -H "X-API-Key: <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "invoice_id": "<uuid>",
    "subscription_id": "<uuid>",
    "organization_id": "<uuid>",
    "amount": 1200,
    "status": "completed",
    "provider": "stripe",
    "provider_payment_id": "pi_xxx"
  }' \
  https://tu-app.railway.app/admin/payments
```

### Job de expiraciones

Puedes correrlo manualmente o programarlo como cron:

```bash
npm run billing:check
```

En Railway puedes agregar un segundo servicio con el mismo repo y un `startCommand` distinto, o usar un workflow externo (GitHub Actions) que llame al endpoint `POST /admin/billing/check-expirations`.

### Integración con pasarelas de pago

La estructura actual es compatible con Stripe/PayPal pero no incluye sus SDKs. Para automatizar cobros:

1. Instalar el SDK correspondiente en `backend/license-server`.
2. Agregar webhook endpoint `POST /webhooks/stripe` (o `/webhooks/paypal`).
3. Crear/actualizar `invoices` y `payments` desde el webhook.
4. Actualizar `subscriptions.payment_status` y `next_billing_date`.

---

## 12. Comandos útiles

```bash
# Instalar
cd backend/license-server && npm install

# Iniciar en desarrollo
npm run dev

# Crear tablas
npm run db:init

# Revisar expiraciones
npm run billing:check

# Health check
curl http://localhost:3000/health
```
