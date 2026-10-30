# Club Tonusco

Aplicación web móvil para consultar la tarjeta de lealtad y para que recepción administre huéspedes, estadías y descuentos.

## Iniciar en Windows

1. Abre PowerShell en esta carpeta.
2. Ejecuta `npm start` (Node.js 20 o superior).
3. En el navegador de este computador abre `http://localhost:3000`.
4. En **Administración**, inicia sesión con la clave guardada en `.env`.

No hay que instalar dependencias. La app conserva los huéspedes y el historial en `data/tonusco.json`, incluso después de cerrar y volver a iniciar el servidor. Haz copias periódicas de esa carpeta.

## Flujo de las dos tarjetas QR

En Administración aparecen dos códigos distintos:

1. **Inscripción:** abre el formulario de tarjeta VIP. El huésped se inscribe una sola vez con nombre y celular; el servidor normaliza el número, evita duplicados y asigna un número de tarjeta.
2. **Solicitar un sello:** abre la página donde el huésped escribe el celular y confirma. El servidor añade un sello solo si han pasado al menos 48 horas desde el último sello de esa tarjeta. La espera se valida en el servidor, así que cambiar de navegador o dispositivo no la reinicia. La unicidad de la tarjeta se basa en el celular registrado.

La tarjeta progresa por 5%, 10%, 15%, 20% y 25%. El ejemplo físico también anuncia una hora de jacuzzi al alcanzar el 25%; se muestra como premio del quinto sello. El personal puede registrar un sello manualmente desde Administración, pero el intervalo de 48 horas se aplica igual.

**Alcance de la regla:** 48 horas evita varios sellos durante la mayoría de estadías cortas, pero no demuestra por sí solo que haya comenzado una reserva nueva. Si una estadía dura más de 48 horas, o alguien comparte una foto del QR y vuelve a escanear después, puede solicitar otro sello. Para garantizar exactamente un sello por reserva se necesita un código único por reserva o integrar el sistema de reservas.

## Uso de recepción

1. Entra en **Administración** con la clave configurada.
2. Imprime el QR de **Inscripción** y el QR de **Solicitar un sello** por separado.
3. Busca tarjetas por nombre, celular o número. Si un huésped no puede inscribirse por su cuenta, recepción puede ayudarle.
4. El huésped escanea el QR de sellos y confirma su celular; un sello se agrega si el último fue hace 48 horas o más.
5. Usa **+ Sello** para correcciones manuales; también está sujeto al intervalo. Marca si se aplicó el descuento anterior.
6. Usa **Exportar CSV** para descargar el listado de tarjetas.

## Uso del huésped

El huésped escanea el QR de inscripción una sola vez o el QR de sellos en sus visitas posteriores. La tarjeta puede consultarse en la web con el celular registrado. Cada nuevo sello queda disponible al completar el intervalo de 48 horas.

## Publicar en internet

La app ya sirve el sitio y la API desde el mismo servidor, y protege la administración con una clave, sesiones seguras, límite de intentos y cookies HttpOnly. Para que el QR funcione fuera del computador, publica el `Dockerfile` en un proveedor que ofrezca HTTPS y almacenamiento persistente.

En Railway: crea un servicio desde el `Dockerfile`, configura `ADMIN_PASSWORD` como variable secreta y conecta un volumen persistente en `/data`. La imagen ya define `DATA_FILE=/data/tonusco.json`; el servicio escucha el puerto que Railway le asigne. Conserva copias de seguridad del archivo de datos.

No subas `.env` ni `data/` a un repositorio público. Antes de abrir el registro a huéspedes reales, agrega el aviso de privacidad y solicita el consentimiento correspondiente para guardar sus datos de contacto.

## Regla de descuentos

Cada estadía completada otorga un sello. El sello 1 habilita 5% para la siguiente visita; los sellos siguientes habilitan 10%, 15%, 20% y 25%. El máximo queda en 25%. El historial registra la fecha de cada estadía, si se aplicó el descuento anterior y el nuevo descuento ganado.
