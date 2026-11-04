# Contexto para continuar Club Tonusco en Cloud Code

Actualizado el 2 de noviembre de 2026. Este documento permite retomar el desarrollo sin perder las reglas del negocio ni confundir la carpeta de trabajo con Render o GitHub.

## Instrucción para el siguiente asistente

Lee este archivo y `README.md` antes de editar. Trabaja sobre el repositorio GitHub indicado abajo y conserva su estado de producción. Antes de cambiar archivos, revisa `git status` y trae los cambios de `origin/main` con `git pull --ff-only`. No reemplaces ni borres la base persistente de Render. No cambies los porcentajes ni las reglas sin una instrucción explícita del dueño.

## Proyecto y carpetas

- Nombre mostrado: **Club Tonusco** / **Tarjeta VIP Tonusco**.
- Negocio: Hostería Tonusco Campestre, Santa Fe de Antioquia, Colombia.
- URL pública: <https://tarjeta-de-lealtad-donusco.onrender.com>
- GitHub: <https://github.com/andromeda5292608-cpu/tarjeta-de-lealtad-donusco>
- Rama de producción: `main`.
- Carpeta de trabajo usada por Codex en esta sesión: `C:\Users\mata-\.codex\visualizations\2026\10\30\01a18ab1-c1f0-7cc3-bbb2-62f5300c4173\tonusco-release`.
- Carpeta que el dueño había seleccionado inicialmente: `C:\Users\mata-\Documents\lealtad tonusco`. Para trabajar desde otra herramienta, clona GitHub en una carpeta accesible para esa herramienta y confirma que estás en el repositorio correcto con `git remote -v`.
- Último commit de código funcional verificado como `live` antes de añadir este resumen: `4bc9895` (`Keep unavailable Wallet options disabled`). Este resumen y el README se agregan como documentación, sin cambiar la lógica de la app.

## Arquitectura y archivos

Es una aplicación web móvil sin framework ni dependencias npm externas. Node.js 20 o superior ejecuta un servidor HTTP nativo. Render la empaqueta con Docker; OpenSSL está instalado en la imagen para firmar pases de Apple Wallet.

- `server.js`: servidor web, API pública y de administración, reglas de sellos, persistencia JSON, estadísticas, QR, generación de enlaces JWT para Google Wallet y generación `.pkpass` para Apple Wallet.
- `index.html`: interfaz, estilos y JavaScript del huésped y del administrador.
- `logo-tonusco.jpg`, `icon-tonusco-*.png`, `icon-tonusco.svg`: logo e iconos usados por la web y los pases.
- `manifest.webmanifest`, `service-worker.js`: instalación de la web como PWA y caché.
- `Dockerfile`: contenedor Node 24 Alpine más OpenSSL.
- `render.yaml`: definición del servicio Render, variables y disco persistente.
- `.env.example`: nombres y ejemplos sin secretos.
- `WALLET_SETUP.md`: pasos para crear/configurar las credenciales de Wallet en Render.

Inicio local en Windows: copia `.env.example` a `.env`, asigna una clave segura a `ADMIN_PASSWORD`, ejecuta `npm start` y visita `http://localhost:3000`. No hace falta `npm install`. En local el archivo de datos predeterminado es `data/tonusco.json`.

## Reglas de la tarjeta que deben conservarse

- Son **9 sellos, uno por visita**, en este orden: `5%, 5%, 10%, 10%, 15%, 15%, 20%, 20%, 25%`.
- Fórmula actual: descuento `ceil(sellos / 2) × 5`, con tope de 25%. Los primeros sellos se conceden al final de la visita y habilitan el descuento para la siguiente.
- Al completar el sello 9 (25%), el titular y sus acompañantes reciben una hora de jacuzzi.
- Las tarjetas se crean solo desde el panel de administración; ya no existe inscripción pública (`/registro` solo muestra la consulta por celular). `/sello` registra un sello cuando el cliente confirma su celular. El QR aplica un mínimo interno de 48 horas desde el sello anterior; no se muestra esa restricción en la tarjeta del cliente.
- Administración puede agregar varios sellos o quitar varios de una vez, sin esperar 48 horas. La operación administrativa registra los cambios en el historial.
- Al buscar por celular, el cliente ve la tarjeta y el historial. Administración dispone de búsqueda de huéspedes, historial y dashboard de estadísticas.
- Después de consultar la tarjeta, el huésped puede agregar la PWA a inicio y desplegar la sección plegable **Agregar tarjeta a Wallet**. El enlace pequeño de regreso a la página principal se eliminó.

## Producción en Render

- Servicio web Docker: `tarjeta-de-lealtad-donusco`.
- Service ID: `srv-dbif29cs728c73f39elg`.
- Dashboard: <https://dashboard.render.com/web/srv-dbif29cs728c73f39elg>.
- Workspace ID: `tea-dbiataoae00c73bn5f7g`.
- Render observa `main` y despliega cada commit automáticamente. Health check: `/api/health`.
- Servicio en Virginia, plan `0.5c-512mb`, una instancia.
- Disco persistente: `tonusco-data`, 1 GB, montado en `/data`.
- Archivo real de huéspedes e historial en Render: `/data/tonusco.json`. La app configura `DATA_FILE=/data/tonusco.json`. La base no forma parte del repositorio. No vuelvas a crear una base vacía, borrar el disco, cambiar su ruta ni ejecutar migraciones destructivas sin respaldo y autorización explícita.
- `ADMIN_PASSWORD` se configura en Render Environment. El valor es secreto y no se documenta aquí ni en Git. Las cookies y contraseñas no se deben imprimir en logs.

## Estado de Apple Wallet y Google Wallet

La interfaz y las rutas están publicadas, pero se necesita terminar la configuración externa para activar los pases. Mientras falten las credenciales, los botones aparecen como **próximamente** y no intentan iniciar un flujo fallido.

Variables que deben agregarse en **Render → Environment** (no en GitHub):

- Google Wallet: `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_WALLET_SERVICE_ACCOUNT_PRIVATE_KEY`.
- Apple Wallet: `APPLE_PASS_TYPE_IDENTIFIER`, `APPLE_TEAM_IDENTIFIER`, `APPLE_PASS_CERT_P12_BASE64`, `APPLE_PASS_CERT_PASSWORD`, `APPLE_WWDR_CERT_BASE64`.

Se requieren un emisor y una cuenta de servicio autorizada para Google, y un certificado de Pass Type ID de Apple más el certificado intermedio WWDR. Sigue los pasos en `WALLET_SETUP.md`. El pase incluye el avance al momento de generarlo; la tarjeta web sigue siendo la fuente del historial y avance actual. No copies secretos desde Render a un chat, documento o commit.

## Traspaso seguro al hacer cambios

1. Abre la carpeta clonada desde GitHub, no una copia vieja. Comprueba `git remote -v`, `git branch --show-current` y `git status`.
2. Ejecuta `git pull --ff-only origin main` antes de editar. No hagas `git reset --hard` ni borres cambios del dueño.
3. Mantén datos, `.env`, claves, certificados `.p12` y credenciales fuera de Git. Solo los nombres de variables pertenecen a `render.yaml` y `.env.example`.
4. Después de modificar, verifica la sintaxis de Node con `node --check server.js` y revisa el diff. No publiques una nueva funcionalidad de Wallet hasta completar sus credenciales y confirmar el flujo en un dispositivo real.
5. Para publicar, un commit en `main` inicia Render automáticamente. Confirma en el dashboard que el despliegue quede `live`; no crees otro servicio ni otro disco para una actualización normal.

