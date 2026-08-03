# Guía de administración — SAP HANA MCP License Server

Esta guía explica cómo administrar licencias del backend: autenticación, listado, revocación, transferencia y vouchers de activación.

---

## 1. Autenticación como administrador

Todos los endpoints de administración requieren el header:

```http
X-API-Key: <tu-admin-api-key>
```

El valor de `ADMIN_API_KEY` está configurado en las variables de entorno del servidor (Render, Railway, etc.). **No lo compartas con clientes.**

---

## 2. Ver licencias

### Listar todas las licencias

```bash
curl -X GET https://licencias-mcp.onrender.com/admin/licenses \
  -H "X-API-Key: <tu-admin-api-key>"
```

Respuesta:

```json
[
  {
    "id": "9cc450b8-9cfa-4e35-ae75-0abc2a417428",
    "license_key": "BYZX-ZSCJ-WV4D-3FB8",
    "hwid": "da3bebd11be699402cc446adeaa27fbece19b83c0c42a87a08325e966570b928",
    "product_code": "hana-b1",
    "plan": "professional",
    "days": 30,
    "created_at": "2026-08-03T03:34:14.021Z",
    "updated_at": "2026-08-03T03:34:14.021Z",
    "expires_at": "2026-09-02T03:34:14.021Z",
    "is_active": true,
    "revoked": false,
    "last_seen_at": "2026-08-03T04:10:49.000Z"
  }
]
```

### Interpretar el estado

| Campo | Significado |
|---|---|
| `is_active = true` y `revoked = false` y `expires_at > ahora` | Licencia activa y válida. |
| `is_active = false` o `revoked = true` | Licencia deshabilitada/revocada. |
| `expires_at < ahora` | Licencia vencida. |
| `last_seen_at` | Última vez que el MCP se conectó con esa licencia. |

---

## 3. Crear una licencia

Cuando un cliente te envía su hardware ID, creas la licencia así:

```bash
curl -X POST https://licencias-mcp.onrender.com/admin/licenses \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <tu-admin-api-key>" \
  -d '{
    "hwid": "da3bebd11be699402cc446adeaa27fbece19b83c0c42a87a08325e966570b928",
    "days": 30,
    "product_code": "hana-b1",
    "plan": "professional"
  }'
```

Respuesta:

```json
{
  "license_key": "BYZX-ZSCJ-WV4D-3FB8",
  "expires_at": "2026-09-02T03:34:14.021Z"
}
```

Envía la `license_key` al cliente. Él la configura en su MCP:

```bash
HANA_LICENSE_KEY=BYZX-ZSCJ-WV4D-3FB8
HANA_LICENSE_SERVER_URL=https://licencias-mcp.onrender.com
HANA_LICENSE_PRODUCT_CODE=hana-b1
```

---

## 4. Revocar una licencia

Si un cliente cancela, no paga o pierde acceso, revoca su licencia:

```bash
curl -X POST https://licencias-mcp.onrender.com/admin/licenses/BYZX-ZSCJ-WV4D-3FB8/revoke \
  -H "X-API-Key: <tu-admin-api-key>"
```

Respuesta:

```json
{
  "revoked": true,
  "license": { ... }
}
```

La licencia revocada ya no funcionará en el MCP del cliente.

---

## 5. Transferir licencia a otra máquina

### Escenario

El cliente compró una licencia para su máquina A y ahora quiere moverla a la máquina B (por ejemplo, cambió de servidor o reinstaló Windows).

### Proceso

1. El cliente te envía:
   - **HWID antiguo**: el hardware ID de la máquina A.
   - **HWID nuevo**: el hardware ID de la máquina B (obtenido con `node scripts/get-hwid.js`).

2. Tú llamas al endpoint de transferencia. El backend automáticamente:
   - Busca la licencia activa del HWID antiguo.
   - Calcula los días que le quedan.
   - Revoca la licencia antigua.
   - Crea una nueva licencia para el HWID nuevo con **los mismos días restantes**.

```bash
curl -X POST https://licencias-mcp.onrender.com/admin/licenses/transfer \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <tu-admin-api-key>" \
  -d '{
    "old_hwid": "da3bebd11be699402cc446adeaa27fbece19b83c0c42a87a08325e966570b928",
    "new_hwid": "nuevo-hardware-id-del-cliente",
    "product_code": "hana-b1"
  }'
```

Respuesta:

```json
{
  "transferred": true,
  "old_license_key": "BYZX-ZSCJ-WV4D-3FB8",
  "old_hwid": "da3bebd11be699402cc446adeaa27fbece19b83c0c42a87a08325e966570b928",
  "new_license_key": "K2PL-7NMQ-VX9R-4TW6",
  "new_hwid": "nuevo-hardware-id-del-cliente",
  "remaining_days": 18,
  "expires_at": "2026-08-21T12:00:00.000Z",
  "new_license": { ... }
}
```

3. Envías la nueva `license_key` al cliente. Él la configura en la máquina B.
4. La licencia antigua queda revocada y ya no funciona en la máquina A.

### Reglas de transferencia

- Solo se puede transferir una licencia **activa y no vencida**.
- Se preserva el **plan** y los **días restantes**.
- Si no hay licencia activa para el HWID antiguo, el endpoint retorna `404`.
- Si la licencia ya venció, retorna `400`.

---

## 6. Vouchers de activación

Los vouchers permiten que el cliente se active solo sin que tú conozcas su Hardware ID de antemano. Generás un código de un solo uso, se lo envías al cliente y él lo canjea desde el menú de licencias de su máquina.

### Crear vouchers

```bash
curl -X POST https://licencias-mcp.onrender.com/admin/vouchers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <tu-admin-api-key>" \
  -d '{
    "days": 30,
    "count": 5,
    "product_code": "hana-b1",
    "plan": "professional",
    "expires_in_days": 30
  }'
```

Respuesta:

```json
{
  "vouchers": [ ... ],
  "codes": ["ABCD-EFGH-IJKL-MNOP", "WXYZ-1234-ABCD-5678"],
  "count": 2,
  "expires_at": "2026-09-02T12:00:00.000Z"
}
```

- `days`: días de vigencia de la licencia que se generará al canjear.
- `count`: cantidad de vouchers a generar (máximo 100).
- `expires_in_days`: plazo para canjear el voucher (default 30 días).

### Listar vouchers

```bash
curl -X GET https://licencias-mcp.onrender.com/admin/vouchers \
  -H "X-API-Key: <tu-admin-api-key>"
```

### Canjear un voucher (flujo del cliente)

El cliente envía su voucher y HWID al endpoint público:

```bash
curl -X POST https://licencias-mcp.onrender.com/api/license/redeem \
  -H "Content-Type: application/json" \
  -d '{
    "voucher_code": "ABCD-EFGH-IJKL-MNOP",
    "hwid": "hardware-id-del-cliente",
    "product_code": "hana-b1"
  }'
```

Respuesta:

```json
{
  "redeemed": true,
  "license_key": "WXYZ-1234-ABCD-5678",
  "hwid": "hardware-id-del-cliente",
  "product_code": "hana-b1",
  "plan": "professional",
  "days": 30,
  "expires_at": "2026-09-02T12:00:00.000Z"
}
```

### Reglas de los vouchers

- Un voucher se canjea **una sola vez**.
- Queda atado al HWID que lo canjea.
- Si el HWID ya tiene una licencia activa, el canje falla con `409`.
- Si el voucher venció o ya fue usado, el canje falla con `400`.

---

## 8. Knowledge Base remota

El mismo license server puede servir casos de conocimiento a los clientes MCP. Esto permite que todos los clientes se sincronicen automáticamente cuando agregás o actualizás un caso.

### Subir o actualizar un caso

```bash
curl -X POST https://licencias-mcp.onrender.com/admin/kb/cases \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <tu-admin-api-key>" \
  -d '{
    "product_code": "hana-b1",
    "path": "cases/nuevo-diagnostico.md",
    "title": "Nuevo diagnóstico",
    "content": "# Nuevo diagnóstico\n\nDescripción del caso...",
    "version": "1.0"
  }'
```

- `path`: ruta relativa del archivo (ej. `cases/xxx.md`).
- `content`: contenido Markdown completo.
- Si ya existe un caso con el mismo `product_code` + `path`, se actualiza.

### Listar casos

```bash
curl -X GET "https://licencias-mcp.onrender.com/admin/kb/cases?product=hana-b1" \
  -H "X-API-Key: <tu-admin-api-key>"
```

### Obtener un caso completo

```bash
curl -X GET https://licencias-mcp.onrender.com/admin/kb/cases/<id> \
  -H "X-API-Key: <tu-admin-api-key>"
```

### Eliminar un caso

```bash
curl -X DELETE https://licencias-mcp.onrender.com/admin/kb/cases/<id> \
  -H "X-API-Key: <tu-admin-api-key>"
```

### API público que usa el cliente

El MCP se conecta a estos endpoints para sincronizar:

- `GET /api/kb/list?product=hana-b1` — lista de casos activos con checksum y downloadUrl.
- `GET /api/kb/download/cases/xxx.md` — contenido Markdown del caso.

Configuración típica en el `.env` del cliente:

```env
HANA_KB_REMOTE_URL=https://licencias-mcp.onrender.com/api/kb
HANA_KB_SYNC_INTERVAL_HOURS=24
```

---

## 9. Verificar que una licencia funciona

Puedes probar la validación sin necesidad del MCP:

```bash
curl -X POST https://licencias-mcp.onrender.com/api/license/validate \
  -H "Content-Type: application/json" \
  -d '{
    "license_key": "BYZX-ZSCJ-WV4D-3FB8",
    "hwid": "da3bebd11be699402cc446adeaa27fbece19b83c0c42a87a08325e966570b928",
    "product_code": "hana-b1"
  }'
```

Respuesta válida:

```json
{
  "active": true,
  "license_key": "BYZX-ZSCJ-WV4D-3FB8",
  "hwid": "da3bebd11be699402cc446adeaa27fbece19b83c0c42a87a08325e966570b928",
  "product_code": "hana-b1",
  "plan": "professional",
  "features": ["hana", "knowledge-base"],
  "expires_at": "2026-09-02T03:34:14.021Z",
  "message": "License valid"
}
```

---

## 10. Reactivar una licencia revocada

Si revocaste una licencia por error, puedes reactivarla:

```bash
curl -X POST https://licencias-mcp.onrender.com/admin/licenses/BYZX-ZSCJ-WV4D-3FB8/activate \
  -H "X-API-Key: <tu-admin-api-key>"
```

> Nota: reactivar no extiende la fecha de vencimiento. Si la licencia ya venció, sigue estando vencida.

---

## 11. Actualizar el servidor

Cuando actualices el código del license server, revisa si hay migraciones pendientes en `scripts/`.

Por ejemplo, para agregar la tabla de vouchers a una base existente:

```bash
node scripts/migrate-add-vouchers.js
```

Este script requiere la variable de entorno `DATABASE_URL`.

---

## 12. Buenas prácticas

- **Nunca compartas el `ADMIN_API_KEY`.**
- Antes de transferir una licencia, confirma con el cliente que ya no usará la máquina antigua.
- Guarda un registro de las transferencias que hagas (el campo `metadata` de la licencia puede servir para notas internas).
- Monitorea `last_seen_at` para detectar licencias inactivas.
