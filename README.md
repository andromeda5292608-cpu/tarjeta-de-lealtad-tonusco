# Club Tonusco

Aplicación web móvil de lealtad para Hostería Tonusco Campestre. La guía de traspaso para continuar con otro asistente de programación está en [CONTEXTO_CLOUD_CODE.md](CONTEXTO_CLOUD_CODE.md).

## Ejecutar localmente en Windows

1. Usa Node.js 20 o superior y abre PowerShell en la carpeta del repositorio.
2. Copia `.env.example` como `.env` y configura `ADMIN_PASSWORD` con una clave segura.
3. Ejecuta `npm start` y abre `http://localhost:3000`.

La app no necesita instalar paquetes npm. En local guarda los datos en `data/tonusco.json`.

## Programa de lealtad

La tarjeta tiene nueve sellos, uno por visita: **5%, 5%, 10%, 10%, 15%, 15%, 20%, 20% y 25%**. El porcentaje que se gana se usa en la siguiente visita. El 25% final incluye una hora de jacuzzi para el titular y sus acompañantes.

Las tarjetas se crean en recepción: el huésped escanea el QR de inscripción (`/registro`) o, si no puede, la recepcionista la crea desde el panel de administración. No hay inscripción desde el inicio del sitio. Los huéspedes consultan su tarjeta con el celular y solicitan un sello por `/sello` al finalizar la visita. El QR público permite un sello cada 48 horas. Recepción puede buscar clientes e historial, registrar o quitar varios sellos sin esperar ese intervalo, y consultar las estadísticas de lealtad.

## Datos y despliegue

- Repositorio: [tarjeta-de-lealtad-donusco](https://github.com/andromeda5292608-cpu/tarjeta-de-lealtad-donusco), rama `main`.
- Sitio: [tarjeta-de-lealtad-donusco.onrender.com](https://tarjeta-de-lealtad-donusco.onrender.com).
- Render despliega automáticamente los cambios de `main` usando Docker.
- En Render, la base de datos es el archivo `/data/tonusco.json` en un disco persistente montado en `/data`; **no está en GitHub**. Conserva copias de seguridad del disco.
- La clave de administración y credenciales de proveedores viven como variables de entorno en Render; no las agregues al repositorio.

## Apple Wallet y Google Wallet

La interfaz y generación de pases están implementadas. La sección aparece después del registro o de consultar la tarjeta. Los botones permanecen desactivados hasta configurar las cuentas y claves oficiales de cada proveedor. Consulta [WALLET_SETUP.md](WALLET_SETUP.md); no guardes los secretos en GitHub ni en archivos de contexto.
