# Wairua Scribe — beta local (v0.3)

Transcripción de audio en el propio navegador con Whisper (Transformers.js 3.8.1 + ONNX Runtime). Prototipo **no validado clínicamente**.

## Publicación (GitHub Pages)

La web se publica desde la rama `main` con GitHub Pages (HTTPS, necesario para WebGPU y el micrófono).

**Acceso:** ahora mismo la beta está **abierta a quien tenga el enlace** (`GATE_ENABLED = false` en `gate.js`). Para volver a pedir código de invitación: pon `true` y restaura en `index.html` el script de bloqueo inicial. Con el código activado, la presentación es pública; el estudio y «En directo» se desbloquean con un código personal (`gate.js` guarda solo hashes SHA-256 con sal). Es un filtro de acceso a la beta, no seguridad real: el audio nunca sale del navegador. Para invalidar un código, borra su hash de `gate.js` y vuelve a publicar. **La lista de códigos no está en el repositorio:** guárdala aparte. La web incluye `noindex` y `robots.txt` para que no aparezca en buscadores.

## Arrancar

**Windows:** doble clic en `iniciar.bat`. Busca Python o Node.js, arranca el servidor y abre el navegador.

**Manual:**

```bash
cd wairua-scribe
python3 -m http.server 8000
```

Abre **http://localhost:8000**. No abras `index.html` con doble clic: con `file://` el navegador bloquea los módulos JavaScript y la transcripción no arranca (ahora la página lo avisa). En otro dispositivo o en el VPS hace falta HTTPS.

## Qué cambia respecto a la v0.1

**Transcripción**
- El motor corre en un **Web Worker** (`worker.js`): la pestaña ya no se congela ni salta el aviso de «página sin respuesta».
- **WebGPU** usa la configuración estable para Whisper (codificador fp32 + decodificador q4). Antes usaba q8 en todo, que en GPU suele fallar. En CPU se mantiene q8.
- Si falla la GPU al cargar o al transcribir, se pasa a CPU automáticamente.
- El audio se divide en **bloques de unos 90 s, cortados en silencios**. Así hay progreso real, el texto aparece a medida que avanza y se usa menos memoria.
- **Filtro de frases fantasma** de Whisper en silencios («Subtítulos realizados por la comunidad de Amara.org», «Gracias por ver el vídeo»…) y de repeticiones en bucle.
- Mensajes de error comprensibles: red, formato, memoria o GPU. El error técnico completo aparece en la consola (F12).
- Idioma por defecto: español. Se añaden catalán y portugués.

**Funciones nuevas**
- Grabación directa desde el micrófono, con vúmetro.
- Arrastrar y soltar archivos.
- Marcas de tiempo, exportación TXT y **SRT**, contador de palabras.
- Botón de cancelar que conserva el texto obtenido hasta ese momento.
- Panel de diagnóstico: origen seguro, WebGPU, núcleos, memoria, caché y borrado de modelos.
- La pantalla no se apaga durante la transcripción (Wake Lock).

**Landing**
- Estética cinematográfica oscura: barras de *letterbox*, grano de película, viñeteado y foco de luz que sigue al cursor.
- Ondas luminosas y notas musicales que reaccionan al cursor o al dedo. Al hacer clic se genera una onda expansiva.
- Respeta «reducir movimiento» y la animación se pausa cuando el hero no está visible.
- Tipografías alojadas en el propio proyecto (Instrument Serif + Inter): no se hacen peticiones a Google Fonts.

## Novedades v0.3

- **Requisitos:** comprobación en vivo del navegador y la GPU, tabla de compatibilidad (Chrome, Edge, Safari, Firefox, Android, Linux) y guía para activar la aceleración en Chrome/Edge y elegir la GPU de alto rendimiento en Windows.
- **Indicador en el estudio:** muestra si se usará GPU o CPU y si cada modelo ya está descargado («✓ ya descargado»). El modo «Automático» ya no intenta usar GPUs emuladas por software.
- **Almacenamiento persistente:** tras la primera transcripción se pide al navegador que no borre los modelos.
- **Biblioteca local:** Transformers.js y ONNX Runtime se sirven desde `vendor/`; jsDelivr queda solo como respaldo. Solo el modelo se descarga de fuera (Hugging Face).
- **Contenido:** evidencia científica con referencias, uso responsable, comparación nube/local, qué es WebGPU, autoría y contacto.
- **Textos legales:** privacidad, cookies (aviso informativo: no se usan cookies), seguridad y aviso legal.

## ⚠ Antes de publicar

- Completar en los textos legales (`index.html`, diálogos `dlg-privacy` y `dlg-legal`): **CIF, domicilio y datos registrales** de Wairua Veterinary Precision Medicine, S.L.U. (marcados como `[pendiente]`).
- Que un asesor legal revise los textos: son una base razonable, no asesoramiento jurídico.

## Subtítulos en directo (sección «En directo» de la web)

Está en la propia web: menú **En directo** o **http://localhost:8000/#live**. Si abres `live.html`, te redirige ahí.

- **Fuentes:** audio de otra pestaña (webinar, YouTube, Meet…), micrófono o un vídeo o audio local reproducido en la propia página.
- **Funcionamiento:** captura con AudioWorklet → filtro y remuestreo a 16 kHz → detector de voz con suelo de ruido adaptativo → transcripción repetida de la ventana actual (texto provisional, en azul) → confirmación de la frase en cada pausa de ~0,55 s o, como máximo, cada 11 s, cortando en el punto más silencioso.
- **Herramientas:** tamaño de letra, pantalla completa, registro con marcas de tiempo, exportación TXT/SRT y métricas de retraso.

## Texto en directo al grabar con el micrófono

En el estudio, pestaña **Grabar**, la opción **«Ver el texto mientras grabo»** (activada por defecto) muestra la transcripción mientras hablas. Al detener la grabación, el texto ya está listo. Si quieres más precisión, «Transcribir» hace una segunda pasada completa sobre la grabación.

Las dos funciones comparten un único motor (`live-engine.js` + `live-worker.js`), así que solo hay un modelo en memoria.

**Modo de prueba sin modelo:** `http://localhost:8000/?mock` simula el motor para comprobar la captura y la interfaz.

## Archivos

| Archivo | Función |
|---|---|
| `index.html` | Landing y estudio de transcripción (ES/EN) |
| `style.css` | Diseño |
| `app.js` | Interfaz, grabadora, decodificación de audio, exportación y diagnóstico |
| `worker.js` | Motor de transcripción (Transformers.js) |
| `soundscape.js` | Animación del hero |
| `logo.png`, `logo-light.png`, `mark.png`, `wordmark.png`, `favicon.png` | Variantes del logotipo con transparencia |
| `fonts/` | Tipografías woff2 (licencia SIL OFL) |
| `vendor/` | Transformers.js 3.8.1 y ONNX Runtime Web (WASM), servidos localmente |
| `iniciar.bat` | Arranque con doble clic en Windows |
| `live.js`, `live.css` | Sección «En directo» |
| `live-engine.js`, `live-worker.js` | Motor compartido de transcripción en directo |

## Privacidad: estado real

El audio se decodifica y se transcribe en el navegador; no se envía a ningún servidor. Pero en el primer uso se descarga el modelo desde **Hugging Face** (la biblioteca ya va incluida en `vendor/`). Hasta que se alojen en el VPS y se configure una CSP, usa solo audios de prueba sin datos personales.

## Pendiente

Alojar los modelos en el VPS (`env.remoteHost` en `worker.js`); CSP; PWA/offline; diarización (veterinario/propietario); vocabulario veterinario mediante *prompt* inicial; pruebas con audio clínico real y de larga duración; autenticación, backend y despliegue.

- Validar los subtítulos en directo y el texto al grabar con audio real (latencia, cortes de frase, alucinaciones).
