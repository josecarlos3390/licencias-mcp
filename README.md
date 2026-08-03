# SAP HANA MCP License Server

Backend independiente para emitir y validar licencias del [SAP HANA MCP Server](https://github.com/hatrigt/hana-mcp-server).

## Qué hace

- Emite claves de licencia cortas y alfanuméricas (`ABCD-EFGH-IJKL-MNOP`) vinculadas a un **hardware ID**.
- Valida online que la clave exista, no esté vencida, no esté revocada y corresponda al HWID.
- Almacena productos, licencias y telemetría en PostgreSQL.
- Diseñado para correr gratis en **Railway** + **Neon**.

## Flujo de uso

1. El cliente ejecuta `npm run hwid` y obtiene su hardware ID.
2. Te envía el HWID.
3. Tú generas la licencia llamando `POST /admin/licenses` con el HWID y los días.
4. Le envías la clave alfanumérica generada.
5. El cliente configura `HANA_LICENSE_KEY=<clave>` en el MCP.
6. El MCP valida la clave contra este servidor en cada arranque.

## Requisitos

- Node.js >= 18
- PostgreSQL (recomendado [Neon](https://neon.tech) gratis)

## Instalación local

```bash
cd sap-hana-mcp-license-server
cp .env.example .env
# Edita .env con tu DATABASE_URL y ADMIN_API_KEY
npm install
npm run db:init
npm run dev
```

## Variables de entorno

| Variable | Descripción | Default |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `DATABASE_URL` | URL de PostgreSQL | — |
| `ADMIN_API_KEY` | API key para endpoints de administración | — |
| `DEFAULT_PRODUCT_CODE` | Código de producto | `hana-b1` |
| `DEFAULT_PLAN` | Plan por defecto | `professional` |
| `DEFAULT_LICENSE_DAYS` | Días por defecto | `30` |
| `NODE_ENV` | Entorno | `production` |

## Endpoints

### Públicos

#### `POST /api/license/validate`

Valida una licencia.

**Body:**
```json
{
  "license_key": "ABCD-EFGH-IJKL-MNOP",
  "hwid": "a1b2c3...",
  "product_code": "hana-b1"
}
```

**Respuesta válida:**
```json
{
  "active": true,
  "license_key": "ABCD-EFGH-IJKL-MNOP",
  "hwid": "a1b2c3...",
  "product_code": "hana-b1",
  "plan": "professional",
  "features": ["hana", "knowledge-base"],
  "expires_at": "2026-08-28T12:00:00.000Z",
  "message": "License valid"
}
```

### Administración (requiere header `X-API-Key`)

#### `POST /admin/licenses`

Crea una licencia.

**Body:**
```json
{
  "hwid": "a1b2c3...",
  "days": 30,
  "product_code": "hana-b1",
  "plan": "professional"
}
```

#### `GET /admin/licenses`

Lista todas las licencias.

#### `POST /admin/licenses/:license_key/revoke`

Revoca una licencia.

#### `POST /admin/licenses/:license_key/activate`

Reactiva una licencia revocada.

## Deploy a Railway

1. Crea un proyecto en Railway.
2. Conecta este repositorio.
3. Configura las variables de entorno (`DATABASE_URL`, `ADMIN_API_KEY`, etc.).
4. Railway detectará el `package.json` y ejecutará `npm start`.

## Deploy a Render (free tier)

1. En Render, crea un **New Web Service** y conecta este repositorio.
2. Configura:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** agrega `DATABASE_URL`, `ADMIN_API_KEY`, `DEFAULT_PRODUCT_CODE`, etc.
3. Render te dará una URL como `https://licencias-mcp.onrender.com`.

### Mantener el servicio despierto en Render

El tier gratuito de Render duerme el servicio tras 15 minutos de inactividad. Para evitarlo, configura un monitor de uptime que haga ping cada 10-14 minutos:

- Endpoint ligero: `GET /ping` → responde `pong`.
- También puedes usar `GET /health` si prefieres JSON.

**UptimeRobot:** crea un monitor tipo `HTTP(s)` apuntando a `https://tu-app.onrender.com/ping` con intervalo de 14 minutos.

## Generar una licencia (ejemplo con curl)

```bash
HWID=$(node scripts/get-hwid.js)
curl -X POST https://tu-app.railway.app/admin/licenses \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -d "{\"hwid\":\"$HWID\",\"days\":30}"
```
