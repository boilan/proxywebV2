<h1 align="center">Omnitab</h1>

<p align="center">Portal de proxy web autoalojado: escribe una URL o una búsqueda, el sitio se abre
en su propia pestaña con barra de navegación (atrás / adelante / recargar / dirección).</p>

El tráfico se intercepta con un service worker y se transporta cifrado por WebSocket
con <a href="https://github.com/MercuryWorkshop/wisp-js">Wisp</a>, usando
<a href="https://github.com/MercuryWorkshop/libcurl-transport">libcurl-transport</a>
como transporte HTTP.

## Sitios compatibles

Compatible con CAPTCHA. Sitios populares que funcionan:

- [Google](https://google.com)
- [YouTube](https://youtube.com)
- [TikTok](https://www.tiktok.com)
- [Poki](https://poki.com)
- [Instagram](https://instagram.com)
- [Spotify](https://spotify.com)
- [Discord](https://discord.com)
- [Reddit](https://reddit.com)
- [Twitch](https://twitch.tv)
- [GeForce NOW](https://play.geforcenow.com/)

> **Importante:** no alojes esto en una IP de datacenter si necesitas que funcionen los
> CAPTCHA y YouTube. Mucho tráfico desde una sola IP rompe algunos sitios. Valora rotar
> IPs o salir por Wireguard con un proyecto tipo
> <a href="https://github.com/whyvl/wireproxy">wireproxy</a>.

## Instalación

Necesitas Node.js 18+ y Git.

```sh
npm install
npm start
```

El servidor escucha en `PORT` (por defecto `8080`). Abre el portal, escribe una URL o una
búsqueda y pulsa **Ir**.

### Variables de entorno

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `PORT` | `8080` | Puerto HTTP. |
| `OMNITAB_ISOLATION` | activado | Ponlo en `off` para desactivar COOP/COEP si algún recurso externo no se puede cargar. |

### Despliegue en Render

`render.yaml` define un servicio web Node de plan gratuito llamado `omnitab`, con health
check en `/healthz`. Build: `npm install`. Start: `node --max-old-space-size=384 src/index.js`.

## Pruebas

```sh
npm test
```

`test/run-all.mjs` levanta el servidor real en un puerto libre y comprueba:

1. assets, tipos MIME, cabeceras de caché y de aislamiento,
2. que el portal no muestre el branding antiguo y que el prefijo de URL proxied
   (`/go/`) coincida entre cliente y servidor,
3. el endpoint Wisp con un cliente real: DNS + TCP + TLS + HTTP contra
   `example.com`, `www.youtube.com`, `poki.com` y `www.tiktok.com`.

## Estructura

```
src/index.js          servidor Fastify + endpoint Wisp + política de caché
public/index.html     portal
public/index.js       cliente: motor de interceptación, barra de navegación
public/search.js      parser del omnibox (URL vs búsqueda)
public/register-sw.js registro del service worker
public/sw.js          service worker que intercepta las peticiones proxied
public/favicon.svg    icono vectorial
test/                 arnés de pruebas + cliente Wisp
```

## Licencias y atribución

El código del motor de interceptación incluido en `node_modules` y servido desde
`/scram/` es software de terceros bajo **AGPL-3.0**. La licencia y los avisos de
copyright de esos componentes se conservan en `LICENSE` y en la página
`/credits.html`; forma parte de las condiciones de la licencia y no debe eliminarse al
redistribuir el proyecto.
