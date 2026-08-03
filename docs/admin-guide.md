# Guía de administración — SAP HANA MCP License Server

Esta guía explica cómo administrar licencias del backend: autenticación, listado, revocación y transferencia de licencias entre máquinas.

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

## 6. Verificar que una licencia funciona

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

## 7. Reactivar una licencia revocada

Si revocaste una licencia por error, puedes reactivarla:

```bash
curl -X POST https://licencias-mcp.onrender.com/admin/licenses/BYZX-ZSCJ-WV4D-3FB8/activate \
  -H "X-API-Key: <tu-admin-api-key>"
```

> Nota: reactivar no extiende la fecha de vencimiento. Si la licencia ya venció, sigue estando vencida.

---

## 8. Buenas prácticas

- **Nunca compartas el `ADMIN_API_KEY`.**
- Antes de transferir una licencia, confirma con el cliente que ya no usará la máquina antigua.
- Guarda un registro de las transferencias que hagas (el campo `metadata` de la licencia puede servir para notas internas).
- Monitorea `last_seen_at` para detectar licencias inactivas.
