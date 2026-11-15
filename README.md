# VozLectura 🎧📖

[![Support on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/javicordara)

**Self-hosted Neural EPUB Reader, Offline Audiobook Generator (M4B & EPUB3 Media Overlay), and Bilingual Study Companion — 100% Local on CPU.**

**[Español más abajo ↓](#vozlectura-en-español)**

---

## English Overview

VozLectura turns any DRM-free `.epub` book into a synchronized, offline read-aloud experience with **zero cloud API fees**, **zero GPU requirement**, and **full privacy**. Run it on your PC (Windows, Linux, macOS, or Docker) and listen on your desktop or Android phone over Wi-Fi or completely offline as an installable PWA.

### Key Features
- **17 Open-License Offline Neural Voices (CPU / ONNX Runtime):**
  - **Kokoro 82M (Apache 2.0):** 8 high-naturalness neural voices across Spanish, US English, and UK English.
  - **Piper TTS (MIT):** 9 ultra-fast local voices in Spanish, US English, and UK English.
  - **Device Fallback:** Native browser Web Speech API when offline on mobile.
- **Word-by-Word & Sentence Highlighting + Auto-Scroll:** Paginated book mode, vertical scroll, customizable typography, themes (`Light`, `Sepia`, `Dark`, `OLED`), and Bluetooth car-audio gap compensation.
- **Portable Audiobook Exports:**
  - Generate standard chapterized **`.m4b`** audiobooks.
  - Generate **EPUB 3 Media Overlay (SMIL)** packages (`book_media_overlay.epub`) and portable **`.vozbook`** bundles.
  - Sync existing external **MP3 / M4B** audiobooks to your EPUB text.
- **Bilingual Study & Reading Habits:**
  - Double-tap or select any word for instant **EN ↔ ES** dictionary lookup & translation.
  - Highlights, quotes, bookmarks, reading heatmap/streaks calendar, and automatic Markdown sync to your **Obsidian** vault.
- **Android Wireless Pairing & Offline PWA:** Install directly to your Android home screen, auto-detect your PC's Wi-Fi IP (`/api/ping`), and cache chapters + AI audio locally to listen anywhere.
- **Bilingual Interface (`ES` / `EN`):** Switch the UI language anytime from the topbar globe button (`🌐`) without altering book text.

### Licensing & Zero-DRM Open-Core Philosophy
Source code in this repository is licensed under the **MIT License**. Only commercially permissive open-source speech engines (**Piper MIT** and **Kokoro 82M Apache 2.0**) are included.

If you prefer not to install Python, Docker, or FFmpeg manually, you can support the project by getting the **1-Click Windows Portable Edition (zero configuration, bundled runtime & FFmpeg, no DRM)** — link available in the Releases / Gumroad page.

---

### Quick Start (Source / Developers)

**Prerequisites:** Python 3.10+ and [`ffmpeg`](https://ffmpeg.org/) (optional `espeak-ng` on Linux for Kokoro).

#### Windows
```bat
start_windows.bat
```

#### Linux / macOS
```bash
chmod +x start_linux.sh
./start_linux.sh
```

#### Docker Compose
```bash
docker compose up -d
```
Then open **`http://localhost:8085`** in your browser. Two bilingual sample EPUB books are seeded automatically on first launch.

---

<a name="vozlectura-en-español"></a>
## VozLectura en Español

VozLectura convierte cualquier libro `.epub` sin DRM en un audiolibro y lector de estudio **100% local**, **sin suscripciones ni costes de API**, **sin necesidad de tarjeta gráfica (solo CPU)** y con privacidad total.

### Características Principales
- **17 voces neuronales offline con licencia comercial permisiva (CPU / ONNX):**
  - **Kokoro 82M (Apache 2.0):** 8 voces expresivas en español neutro, inglés US e inglés UK.
  - **Piper TTS (MIT):** 9 voces locales ultrarrápidas en castellano de España, inglés UK e inglés US.
- **Lectura sincronizada frase a frase:** temas *Claro, Sepia, Noche y OLED*, modo paginado o scroll, atajos de teclado y compensación automática de pausas para Bluetooth de coche.
- **Exportación portátil:** crea audiolibros **`.m4b`** por capítulos, **EPUB 3 Media Overlay (SMIL)**, paquetes **`.vozbook`** o sincroniza audiolibros MP3/M4B que ya tengas con tu EPUB.
- **Diccionario bilingüe, hábitos y Obsidian:** pulsa cualquier palabra para traducir/definir **EN ↔ ES**, registra tu racha de lectura y sincroniza citas y notas en Markdown con tu bóveda local de **Obsidian**.
- **App Offline para Android (PWA Wi-Fi):** accede desde el móvil por Wi-Fi (con autodetección de IP local), descarga capítulos + audio al teléfono y escucha incluso con la pantalla apagada o sin cobertura.
- **Interfaz Bilingüe (`ES` / `EN`):** cambia al instante entre español e inglés desde el botón `🌐` de la barra superior.

### Modelo Sin DRM, Donaciones y Edición Portable
Todo el código fuente es abierto bajo licencia **MIT**. Si *VozLectura* te ahorra tiempo o te resulta útil, puedes apoyar su desarrollo invitando a un café en **[Ko-fi](https://ko-fi.com/javicordara)**. Si no quieres configurar Python ni `ffmpeg` a mano en Windows, también tienes disponible la **Edición Portable Windows 1-Clic** (descomprimir y doble clic, sin DRM y con actualizaciones incluidas).

### Inicio Rápido
- **Windows:** ejecuta `start_windows.bat`
- **Linux / macOS:** ejecuta `./start_linux.sh`
- **Docker:** ejecuta `docker compose up -d`
- Abre **`http://localhost:8085`** (en el primer arranque se crean 2 EPUB de demostración en español e inglés).
