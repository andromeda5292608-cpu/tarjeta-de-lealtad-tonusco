# Activar Apple Wallet y Google Wallet

La app ya incluye la sección discreta “Agregar tarjeta a Wallet” después de crear o consultar una tarjeta. También incluye las rutas que generan el pase de Apple Wallet (`.pkpass`) y el enlace firmado de Google Wallet. Los botones se habilitan cuando se completan las credenciales de cada proveedor.

## Google Wallet

1. Crea el emisor de Hostería Tonusco en [Google Wallet Console](https://pay.google.com/business/console).
2. En Google Cloud, habilita Google Wallet API y crea una cuenta de servicio. Autoriza su correo como usuario de la cuenta de emisor y conserva la clave privada JSON.
3. En Render, abre el servicio `tarjeta-de-lealtad-donusco` → **Environment** → **Add Environment Variable** y configura:
   - `GOOGLE_WALLET_ISSUER_ID`: ID numérico del emisor.
   - `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL`: correo de la cuenta de servicio.
   - `GOOGLE_WALLET_SERVICE_ACCOUNT_PRIVATE_KEY`: campo `private_key` del JSON, completo. Render acepta los saltos de línea reales o `\n`.
4. Guarda los cambios. Render reiniciará el servicio; al volver a consultar la tarjeta aparecerá activo **Agregar a Google Wallet**.

La app utiliza la clase `tonuscoLoyalty` y una tarjeta única por socio. Google puede dejar los pases de prueba marcados como `[TEST ONLY]` hasta que el emisor obtenga permiso de publicación.

## Apple Wallet

Se necesita una cuenta del Apple Developer Program con permiso para administrar certificados.

1. En **Certificates, Identifiers & Profiles**, registra un Pass Type ID, por ejemplo `pass.com.tonuscocampestre.lealtad`, y crea su certificado de distribución.
2. Exporta el certificado y su clave privada como `.p12`. Descarga también el certificado intermedio WWDR que corresponda al certificado de Pass Type ID.
3. En Render, agrega estas variables:
   - `APPLE_PASS_TYPE_IDENTIFIER`: el Pass Type ID registrado.
   - `APPLE_TEAM_IDENTIFIER`: Team ID de Apple Developer.
   - `APPLE_PASS_CERT_P12_BASE64`: archivo `.p12` convertido a Base64.
   - `APPLE_PASS_CERT_PASSWORD`: contraseña usada al exportar el `.p12`.
   - `APPLE_WWDR_CERT_BASE64`: certificado WWDR en Base64. Se acepta tanto el certificado `.cer` descargado como el certificado PEM.
4. Guarda los cambios. Render reiniciará el servicio y habilitará **Agregar a Apple Wallet** en la tarjeta.

En Windows se puede convertir cada archivo a Base64 en PowerShell sin cargarlo a GitHub:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\ruta\certificado.p12'))
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\ruta\AppleWWDR.cer'))
```

## Seguridad y uso

- Agrega todos los valores directamente en la sección **Environment** de Render. No los pongas en `server.js`, `index.html`, `.env.example`, GitHub ni en mensajes compartidos.
- El huésped debe abrir su tarjeta o buscarla por su celular antes de tocar el proveedor de Wallet. El pase se sirve usando el acceso seguro de esa tarjeta.
- El pase Wallet muestra los sellos y el descuento disponibles en el momento de añadirlo. La tarjeta web sigue siendo la fuente actualizada del historial y del avance.

Referencias oficiales: [Google Wallet: crear una cuenta de emisor](https://developers.google.com/wallet/retail/loyalty-cards), [Google Wallet: emitir pases desde una web](https://developers.google.com/wallet/retail/loyalty-cards/web), [Apple: crear identificadores y certificados Wallet](https://developer.apple.com/help/account/capabilities/create-wallet-identifiers-and-certificates/) y [Apple: distribuir pases](https://developer.apple.com/documentation/walletpasses/distributing-and-updating-a-pass?changes=_3).
