# Mi Negocio 3.0 — compilación a APK

Este repositorio compila automáticamente `www/index.html` (tu app de POS) en un
APK de Android usando Capacitor + GitHub Actions. No necesitas PC ni Android
Studio: todo corre en los servidores de GitHub.

## Qué contiene

- `www/index.html` — tu app (React + SQLite/IndexedDB, todo en un solo archivo).
- `android-res/` — el ícono de Ferrego ya recortado en todos los tamaños que
  Android necesita (mdpi a xxxhdpi, ícono normal, redondo y adaptativo).
- `.github/workflows/build-apk.yml` — la receta que compila el APK cada vez
  que subes cambios a la rama `main`.
- `capacitor.config.json` — nombre de la app (**Mi Negocio 3.0**) e ID del
  paquete (**com.ferrego.minegocio3**). Cámbialo si querés otro nombre/ID.

## Sobre el funcionamiento sin internet

La app en sí (`index.html`) ya está armada para no depender de internet:
guarda todo en el propio teléfono (SQLite vía WebAssembly + IndexedDB, con
respaldo automático en localStorage) y no llama a ningún servidor propio.

El único punto que necesitaba internet era **React**, que el archivo original
cargaba desde un CDN la primera vez. Para eliminar esa dependencia, el
workflow de compilación descarga React una sola vez —con la conexión del
servidor de GitHub, durante la compilación— y lo empaqueta *dentro* del APK.
Resultado: una vez instalada en el teléfono, la app **no necesita internet
para nada**, ni para abrir ni para funcionar.

## Cómo usarlo (desde el teléfono, sin PC)

1. Creá un repositorio nuevo en GitHub (público o privado, da igual).
2. Subí todos estos archivos y carpetas tal cual están, respetando las rutas
   (podés hacerlo desde la app de GitHub o desde github.com en el navegador
   del teléfono, con "Add file → Upload files").
3. Andá a la pestaña **Actions** del repositorio. Debería arrancar solo un
   flujo llamado "Compilar APK" apenas subas los archivos a `main`. Si no
   arranca, entrá al flujo y tocá **Run workflow**.
4. Esperá unos 5-8 minutos a que termine (ícono verde ✅).
5. Entrá al resultado del flujo y bajá hasta **Artifacts** → descargá
   `PuntoVenta360-APK`. Ahí adentro está el `.apk` listo para instalar.

## Firma release (opcional, recomendado antes de repartir la app)

Sin configurar nada, el flujo genera un APK de **debug** (funciona igual,
pero Android lo marca como app de prueba y puede pedir reinstalar si cambia
la firma). Para un APK firmado de verdad, como el que ya usás en tus otras
apps:

1. Generá un keystore una sola vez (con `keytool`, o pedime que te ayude a
   generarlo).
2. En el repo: **Settings → Secrets and variables → Actions → New repository
   secret**, y cargá:
   - `KEYSTORE_BASE64` (el archivo `.keystore` convertido a base64)
   - `KEYSTORE_PASSWORD`
   - `KEY_ALIAS`
   - `KEY_PASSWORD`
3. Volvé a correr el flujo: automáticamente compilará y firmará el release
   en vez del debug.

## Notas sobre los arreglos hechos al archivo

- Se revisó `index.html` de punta a punta: **no tiene errores de sintaxis**
  (se verificó con un parser de JavaScript) y no depende de ningún CDN salvo
  el *fallback* de React que el propio archivo ya documenta.
- El flujo de compilación descarga React una sola vez (con la conexión del
  servidor de GitHub) y lo deja embebido junto al `index.html` dentro del
  APK, tal como pedían los comentarios del propio archivo — así la app queda
  100% funcional sin internet en el teléfono, sin que tengas que bajar esos
  archivos vos a mano.
