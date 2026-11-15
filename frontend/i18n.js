(() => {
  "use strict";

  const STORAGE_KEY = "vozlectura_ui_lang";

  const EXACT_ES_TO_EN = {
    // Topbar & navigation
    "Biblioteca": "Library",
    "Volver a la biblioteca": "Back to library",
    "Capítulos": "Chapters",
    "Mostrar / ocultar índice de capítulos": "Show / hide table of contents",
    "Emparejar Android con PC (Transferencia Wi-Fi sin cables)": "Pair Android with PC (Wireless Wi-Fi sync)",
    "Notas & Obsidian": "Notes & Obsidian",
    "Gestionar estudio, citas y sincronización con Obsidian de tus libros": "Manage study notes, quotes, and Obsidian sync for your books",
    "Hábitos": "Habits",
    "Calendario de Hábitos de Lectura, Valoraciones, Autores y Resumen Anual": "Reading Habits Calendar, Ratings, Authors, and Annual Summary",
    "Offline": "Offline",
    "Sin conexión": "Offline",
    "📴 Sin conexión": "📴 Offline",
    "📴 Sin conexión al servidor": "📴 Server offline",
    "Guardar libros y audios en la memoria de este móvil/PC para leer y escuchar sin conexión al servidor": "Save books and audio locally on this device to read and listen offline",
    "Cola de Conversión": "Export Queue",
    "Abrir Cola de Conversión de Ficheros (M4B, EPUB3 Media Overlay y Caché)": "Open File Export Queue (M4B, EPUB3 Media Overlay & Cache)",
    "Voces IA": "AI Voices",
    "Gestionar motores y voces TTS (Piper / Kokoro)": "Manage TTS engines and voices (Piper / Kokoro)",
    "Pantalla completa": "Fullscreen",
    "Activar / Salir de Pantalla Completa nativa (Android y PC)": "Toggle native Fullscreen (Android & Desktop)",
    "Salir pantalla completa": "Exit fullscreen",
    "Apariencia": "Appearance",
    "Ajustes de lectura y tema": "Reading and theme settings",

    // Appearance popover
    "Tema de lectura": "Reading theme",
    "Claro": "Light",
    "Sepia": "Sepia",
    "Noche": "Dark",
    "OLED": "OLED",
    "Tipografía": "Typography",
    "Serif (Libro)": "Serif (Book)",
    "Sans (Moderna)": "Sans (Modern)",
    "Modo de lectura": "Reading mode",
    "Desplazamiento vertical": "Vertical scroll",
    "Páginas": "Paginated",
    "Tamaño de fuente": "Font size",
    "Interlineado": "Line height",
    "Sangría e inter-párrafo": "Indentation & spacing",
    "Compacto": "Compact",
    "Normal": "Normal",
    "Amplio": "Wide",
    "Ancho de lectura": "Reading width",
    "Estrecho": "Narrow",
    "Ancho": "Wide",
    "Completo": "Full",
    "Alineación": "Alignment",
    "Justificado": "Justified",
    "Izquierda": "Left",
    "Seguimiento automático al escuchar": "Auto-scroll while listening",
    "Activado": "Enabled",
    "Desactivado": "Disabled",
    "Pausas entre frases": "Pause between sentences",
    "Automático (Coche / Normal)": "Auto (Car / Standard)",
    "Automático": "Auto",
    "Sin pausa (Gapless)": "No pause (Gapless)",
    "Pausa corta": "Short pause",
    "Pausa cómoda": "Comfortable pause",

    // Library view
    "Tu Biblioteca": "Your Library",
    "Sube un libro EPUB o abre uno de los libros de demostración bilingües": "Upload an EPUB book or open one of the bilingual demo books",
    "Subir EPUB": "Upload EPUB",
    "＋ Subir EPUB": "＋ Upload EPUB",
    "Subir archivo .epub": "Upload .epub file",
    "Importar .vozbook": "Import .vozbook",
    "📥 Importar .vozbook": "📥 Import .vozbook",
    "Buscar por título, autor, categoría o notas...": "Search by title, author, category, or notes...",
    "Todos los autores": "All authors",
    "Todas las categorías": "All categories",
    "Todos los estados": "All statuses",
    "📖 Leyendo": "📖 Reading",
    "📋 Pendiente": "📋 To read",
    "✓ Completado": "✓ Completed",
    "Todas las notas": "All ratings",
    "★★★★½ 4.5★ o más": "★★★★½ 4.5★ or higher",
    "★★★★☆ 4 estrellas o más": "★★★★☆ 4 stars or higher",
    "★★★☆☆ 3 estrellas o más": "★★★☆☆ 3 stars or higher",
    "★★☆☆☆ 2 estrellas o más": "★★☆☆☆ 2 stars or higher",
    "★☆☆☆☆ 1 estrella o más": "★☆☆☆☆ 1 star or higher",
    "Con nota (0,5–5 ★)": "Rated (0.5–5 ★)",
    "Sin valorar aún": "Unrated yet",
    "Orden: Último leído": "Sort: Recently read",
    "Orden: Título (A–Z)": "Sort: Title (A–Z)",
    "Orden: Autor (A–Z)": "Sort: Author (A–Z)",
    "Orden: Nota / Valoración": "Sort: Rating",
    "Orden: Progreso (%)": "Sort: Progress (%)",
    "Orden: Fecha añadido": "Sort: Date added",
    "Limpiar filtros": "Clear filters",
    "✕ Limpiar": "✕ Clear",
    "Pulsa para comprobar y actualizar a la última versión del servidor": "Click to check for server updates and reload",
    "☕ Apoyar el proyecto": "☕ Support VozLectura",
    "Apoyar el desarrollo de VozLectura en Ko-fi": "Support VozLectura development on Ko-fi",
    "Abrir": "Open",
    "Leer": "Read",
    "Continuar lectura": "Continue reading",
    "Empezar lectura": "Start reading",
    "Eliminar libro": "Delete book",
    "Borrar": "Delete",
    "🗑 Borrar": "🗑 Delete",
    "Cancelar": "Cancel",

    // Reader & Audio bar
    "Cerrar índice": "Close index",
    "Frase anterior": "Previous sentence",
    "Reproducir / Pausar (Espacio)": "Play / Pause (Space)",
    "Frase siguiente": "Next sentence",
    "Capítulo anterior": "Previous chapter",
    "Capítulo siguiente": "Next chapter",
    "Diccionario y Traducción (toca cualquier palabra en el texto)": "Dictionary & Translation (tap any word in the text)",
    "Diccionario": "Dictionary",
    "Añadir marcador o nota rápida en la frase actual": "Add bookmark or quick note at current sentence",
    "Marcar / Nota": "Bookmark / Note",
    "Lectura inmersiva (ocultar barras)": "Immersive reading (hide toolbars)",
    "Sincronizar audiolibro MP3 / M4B con este EPUB": "Sync an MP3 / M4B audiobook with this EPUB",
    "Audio": "Audio",
    "Velocidad de narración": "Narration speed",
    "Voz de narración": "Narration voice",
    "Listo": "Ready",
    "Cargando audio...": "Loading audio...",
    "Reproduciendo": "Playing",
    "Pausado": "Paused",
    "Toca dos veces una palabra para ver su traducción y definición": "Double-tap or select any word to see its translation and definition",
    "Cerrar": "Close",
    "Escuchar": "Listen",
    "🔊 Escuchar": "🔊 Listen",
    "🇪🇸 Voces en Español (Piper MIT & Kokoro Apache 2.0)": "🇪🇸 Spanish Voices (Piper MIT & Kokoro Apache 2.0)",
    "🇬🇧/🇺🇸 Voces en Inglés (Piper MIT & Kokoro Apache 2.0)": "🇬🇧/🇺🇸 English Voices (Piper MIT & Kokoro Apache 2.0)",
    "📱 Sintetizador Local del Dispositivo (Web Speech)": "📱 Device Built-in Synthesizer (Web Speech)",
    "[Local] Voz del sistema Español (es-ES)": "[Local] System voice Spanish (es-ES)",
    "[Local] Voz del sistema Inglés UK (en-GB)": "[Local] System voice English UK (en-GB)",
    "[Local] Voz del sistema Inglés US (en-US)": "[Local] System voice English US (en-US)",

    // Models modal
    "Motores TTS y Voces Neurales Locales (Piper MIT & Kokoro 82M Apache 2.0)": "Local Neural TTS Engines & Voices (Piper MIT & Kokoro 82M Apache 2.0)",
    "Descarga las voces que prefieras para leer sin conexión y sin costes de API.": "Download any voice models you prefer to listen 100% offline with zero API costs.",
    "Descargar modelo": "Download model",
    "Descargando...": "Downloading...",
    "Reintentar": "Retry",
    "✓ Lista": "✓ Ready",

    // Export queue modal
    "📥 Cola de Conversión y Audiolibros": "📥 Export Queue & Audiobooks",
    "Genera audiolibros portátiles (.m4b y .epub Media Overlay) y pre-genera el audio completo en caché.": "Generate portable audiobooks (.m4b & .epub Media Overlay) and pre-cache full book narration.",
    "Iniciar conversión": "Start conversion",
    "▶ Iniciar conversión": "▶ Start conversion",
    "Pausar": "Pause",
    "⏸ Pausar": "⏸ Pause",
    "Reanudar": "Resume",
    "▶ Reanudar": "▶ Resume",
    "Descargar .m4b": "Download .m4b",
    "Descargar .epub": "Download .epub",

    // Offline modal
    "📲 Almacenamiento Offline y Conexión Wi-Fi": "📲 Offline Storage & Wi-Fi Connection",
    "📥 Descargar libro a la memoria local de este dispositivo": "📥 Download book to this device's local storage",
    "Puedes bajar solo el texto del EPUB (ocupa ~1–2 MB, instantáneo) o incluir también el audio neuronal de los capítulos para escucharlo sin conexión.": "Download just the EPUB text (~1–2 MB, instant) or include neural chapter audio for true offline listening.",
    "🎧 Texto + Audio IA de TODOS los capítulos del libro (Predeterminado)": "🎧 Text + AI Audio for ALL book chapters (Default)",
    "🎧 Texto + Audio IA de los próximos 5 capítulos": "🎧 Text + AI Audio for next 5 chapters",
    "🎧 Texto + Audio IA de los próximos 3 capítulos": "🎧 Text + AI Audio for next 3 chapters",
    "📖 Solo Texto y Notas del libro (Instantáneo, ~1-2 MB)": "📖 Book Text & Notes Only (Instant, ~1-2 MB)",
    "Descargar al dispositivo": "Download to device",
    "⬇ Descargar al dispositivo": "⬇ Download to device",
    "💾 Conectar IP": "💾 Connect IP",
    "🔍 Buscar IP en Wi-Fi": "🔍 Scan Wi-Fi IP",
    "Conectado": "Connected",

    // Study & Habits modals
    "📊 Hábitos de Lectura, Valoraciones y Resumen": "📊 Reading Habits, Ratings & Summary",
    "📊 Hábitos de Lectura, Calendario y Estadísticas": "📊 Reading Habits, Calendar & Stats",
    "📝 Estudio, Citas y Sincronización Obsidian": "📝 Study, Quotes & Obsidian Sync",
    "📓 Cuaderno de Lectura y Conexión en Vivo con Obsidian": "📓 Reading Notebook & Live Obsidian Sync",
    "Guardar nota": "Save note",
    "Sincronizar Obsidian": "Sync Obsidian",
    "📲 Emparejamiento y Transferencia Wi-Fi": "📲 Device Pairing & Wi-Fi Sync",

    // Topbar, library & cards (complete coverage)
    "+ Añadir EPUB": "+ Add EPUB",
    "＋ Añadir EPUB": "＋ Add EPUB",
    "Añadir EPUB": "Add EPUB",
    "Hábitos y Estadísticas": "Habits & Stats",
    "EPUB + Audio": "EPUB + Audio",
    "Notas / Obsidian": "Notes / Obsidian",
    "Emparejar EN/ES": "Pair EN/ES",
    "EN⇄ES Emparejar EN/ES": "EN⇄ES Pair EN/ES",
    "Salir": "Exit",
    "Salir de pantalla completa": "Exit fullscreen",
    "🔍 Filtros y orden": "🔍 Filters & sort",
    "Filtros y orden": "Filters & sort",
    "🕒 Reciente 1º": "🕒 Recent 1st",
    "Reciente 1º": "Recent 1st",
    "Desplegar ▾": "Expand ▾",
    "Contraer ▴": "Collapse ▴",
    "🌍 Todos los idiomas": "🌍 All languages",
    "🇪🇸 Español": "🇪🇸 Spanish",
    "🇬🇧 Inglés": "🇬🇧 English",
    "📚 Todos los estados": "📚 All statuses",
    "📖 Leyendo ahora": "📖 Reading now",
    "🔖 Pendiente / Sin empezar": "🔖 To read / Not started",
    "✅ Terminados": "✅ Completed",
    "⏸ En pausa / Abandonado": "⏸ Paused / Dropped",
    "Todos los géneros": "All genres",
    "⭐ Todas las valoraciones": "⭐ All ratings",
    "⭐⭐⭐⭐⭐ Solo 5 estrellas": "⭐⭐⭐⭐⭐ 5 stars only",
    "⭐⭐⭐⭐½ 4,5 o más estrellas": "⭐⭐⭐⭐½ 4.5+ stars",
    "⭐⭐⭐⭐ 4 o más estrellas": "⭐⭐⭐⭐ 4+ stars",
    "⭐⭐⭐½ 3,5 o más estrellas": "⭐⭐⭐½ 3.5+ stars",
    "Con valoración (0,5–5 ⭐)": "Rated (0.5–5 ⭐)",
    "🔤 Ordenar: Título (A-Z)": "🔤 Sort: Title (A-Z)",
    "🏆 Ordenar: Mejor valorados": "🏆 Sort: Top rated",
    "⏱️ Ordenar: Más tiempo dedicado": "⏱️ Sort: Most time read",
    "📏 Ordenar: Más largos (páginas/palabras)": "📏 Sort: Longest (pages/words)",
    "📐 Ordenar: Más cortos": "📐 Sort: Shortest",
    "📅 Ordenar: Terminados más recientes": "📅 Sort: Recently finished",
    "↕️ Ordenar:": "↕️ Sort:",
    "🇬🇧↔🇪🇸 Pareja bilingüe": "🇬🇧↔🇪🇸 Bilingual pair",
    "Pareja bilingüe": "Bilingual pair",
    "Hace un momento": "Just now",
    "+ Género": "+ Genre",
    "Novela": "Novel",
    "📘 Leído:": "📘 Read:",
    "Leído:": "Read:",
    "Pareja:": "Paired:",
    "🔗 Pareja:": "🔗 Paired:",
    "📖 Abrir y escuchar": "📖 Open & listen",
    "Abrir y escuchar": "Open & listen",
    "📱 Local": "📱 Local",
    "Local": "Local",
    "📓 Notas": "📓 Notes",
    "Notas": "Notes",
    "✅ Terminado": "✅ Completed",
    "Terminado": "Completed",
    "📖 Leyendo": "📖 Reading",
    "Leyendo": "Reading",
    "🔖 Pendiente": "🔖 To read",
    "Pendiente": "To read",
    "⏸ En pausa": "⏸ Paused",
    "En pausa": "Paused",

    // Reader & Appearance extra labels
    "Paginado": "Paginated",
    "Inmersivo": "Immersive",
    "Tema de color": "Color theme",
    "Márgenes / Ancho de texto": "Margins / Text width",
    "Medio": "Medium",
    "Tamaño de letra": "Font size",
    "Sangrado de párrafo": "Paragraph indent",
    "Sin sangría": "No indent",
    "Clásico (1.5em)": "Classic (1.5em)",
    "Amplio (2.5em)": "Wide (2.5em)",
    "Columnas (Pantalla ancha)": "Columns (Wide screen)",
    "1 Columna": "1 Column",
    "2 Columnas": "2 Columns",
    "Alineación de columna": "Text alignment",
    "☰ Justificado": "☰ Justified",
    "☷ Izquierda": "☷ Left",
    "Seguimiento automático de frase": "Auto-scroll sentence tracking",
    "Modo inmersivo (ocultar barra superior al leer)": "Immersive mode (hide topbar while reading)",
    "Pantalla completa automática al abrir libro (App nativa)": "Auto fullscreen on book open (Native app)",
    "Cadencia entre frases / Bluetooth Coche": "Sentence pacing / Car Bluetooth",
    "📖 Modo actual: Normal (Sin recortes)": "📖 Current mode: Normal (No trimming)",
    "🚗 Automático (Normal en app / Recortar en Coche)": "🚗 Auto (Normal in app / Trim in Car)",
    "📖 Normal siempre (Tal cual se genera en la app)": "📖 Always Normal (As generated)",
    "🚗 Modo Coche siempre (Recortes siempre activos)": "🚗 Always Car Mode (Silence trimming on)",
    "← Capítulo anterior": "← Previous chapter",
    "Capítulo siguiente →": "Next chapter →",
    "← Hoja anterior": "← Previous page",
    "Hoja siguiente →": "Next page →",
    "⏸ EN PAUSA — PULSA EN CUALQUIER FRASE O EN PLAY": "⏸ PAUSED — TAP ANY SENTENCE OR PLAY",
    "▶ REPRODUCIENDO": "▶ PLAYING",
    "Listo — Pulsa en cualquier frase o en Play": "Ready — Tap any sentence or Play",
    "📖 Paginado (Hojas)": "📖 Paginated (Pages)",
    "📜 Scroll infinito": "📜 Infinite scroll",

    // Bilingual pairing & extra modals
    "🇬🇧 ↔ 🇪🇸 Lectura Bilingüe Alternada por Capítulos": "🇬🇧 ↔ 🇪🇸 Alternating Bilingual Chapter Reading",
    "1. Selecciona el libro pareja en el otro idioma": "1. Select the paired book in the other language",
    "2. Orden de lectura en cada capítulo": "2. Reading order per chapter",
    "3. Comparador visual y alineación de capítulos": "3. Visual chapter comparator & alignment",
    "Cambiar automáticamente de idioma al terminar cada capítulo": "Automatically switch language at the end of each chapter",
    "Guardar emparejamiento bilingüe": "Save bilingual pairing",
    "Desvincular libros": "Unpair books",
    "📅 Calendario y Hábitos": "📅 Calendar & Habits",
    "🏆 Valoraciones y Listados": "🏆 Ratings & Lists",
    "📈 Autores y Extensión": "📈 Authors & Length",
    "🗓️ Resumen Anual": "🗓️ Annual Summary",
    "🎧 Cola de Conversión de Ficheros (M4B, EPUB3 Media Overlay y Caché)": "🎧 File Export Queue (M4B, EPUB3 Media Overlay & Cache)",
    "⚡ Añadir o iniciar conversión de un libro": "⚡ Add or start book conversion",
    "📲 Libros en Local (Modo Sin Conexión) y Pantalla Apagada en Android": "📲 Local Books (Offline Mode) & Background Playback on Android",
    "🎧 Sincronizar EPUB + Audiolibro (MP3 / M4B / M4A)": "🎧 Sync EPUB + Audiobook (MP3 / M4B / M4A)",
  };

  const REGEX_ES_TO_EN = [
    [/^Capítulo (\d+)(.*)$/i, "Chapter $1$2"],
    [/^Frase (\d+) \/ (\d+)$/i, "Sentence $1 / $2"],
    [/^Frase (\d+) de (\d+)$/i, "Sentence $1 of $2"],
    [
      /^(\d+) libros?\s*·\s*(\d+) parejas? bilingües?$/i,
      (m, b, p) => `${b} ${b === "1" ? "book" : "books"} · ${p} ${p === "1" ? "bilingual pair" : "bilingual pairs"}`,
    ],
    [/^(\d+) libros?$/i, (m, n) => `${n} ${n === "1" ? "book" : "books"}`],
    [/^(\d+) capítulos?$/i, (m, n) => `${n} ${n === "1" ? "chapter" : "chapters"}`],
    [/^(\d+) frases?$/i, (m, n) => `${n} ${n === "1" ? "sentence" : "sentences"}`],
    [/^Cola \((\d+)\)$/i, "Queue ($1)"],
    [/^Notas \((\d+)\)$/i, "Notes ($1)"],
    [/^(🖍️\s*)?Pasajes y Notas \((\d+)\)$/i, (_, p, n) => `${p || ""}Highlights & Notes (${n})`],
    [/^(📚\s*)?Vocabulario \((\d+)\)$/i, (_, p, n) => `${p || ""}Vocabulary (${n})`],
    [/^(📄\s*)?(\d+)\s+págs?\.?$/i, (_, p, n) => `${p || ""}${n} pp.`],
    [/^(📚\s*)?(\d+)\s+cap\.?$/i, (_, p, n) => `${p || ""}${n} ch.`],
    [/^Cap\.\s*(\d+)\/(\d+)$/i, "Ch. $1/$2"],
    [/^(\d+(?:[.,]\d+)?%)\s*\(Cap\.\s*(\d+)\/(\d+)\)$/i, "$1 (Ch. $2/$3)"],
    [/^Pareja:\s*(.+)$/i, "Paired: $1"],
    [/^📖\s*Continuar lectura\s*\(([^)]+)\)$/i, "📖 Continue reading ($1)"],
    [/^✅\s*Terminado\s*\(([^)]+)\)\s*—\s*Abrir libro$/i, "✅ Completed ($1) — Open book"],
    [/^Hace (\d+)\s*(min|minutos?)$/i, "$1 min ago"],
    [/^Hace (\d+)\s*(h|horas?)$/i, "$1 h ago"],
    [/^Hace (\d+)\s*(d|días?)$/i, "$1 d ago"],
    [/^📘\s*Libro:\s*([^%]+%)\s*leído\s*\(Cap\.\s*(\d+)\/(\d+)\)$/i, "📘 Book: $1 read (Ch. $2/$3)"],
    [/^📘\s*([^%]+%)\s*del libro leído\s*\(Cap\.\s*(\d+)\s*de\s*(\d+)\)$/i, "📘 $1 of book read (Ch. $2 of $3)"],
    [/^Hoja (\d+) \/ (\d+)$/i, "Page $1 / $2"],
    [/^Hoja (\d+) de (\d+) • 📘 ([^%]+%) leído$/i, "Page $1 of $2 • 📘 $3 read"],
    [/^Archivo seleccionado: (.+)$/i, "Selected file: $1"],
    [/^Modo CPU \((.+)\)$/, "CPU Mode ($1)"],
    [/^✓ Conectado \((.+)\)$/, "✓ Connected ($1)"],
    [/^Escaneando Wi-Fi (.+)\.\.\.$/, "Scanning Wi-Fi $1..."],
    [/^IP Wi-Fi de este PC: (.+)$/, "This PC Wi-Fi IP: $1"],
    [/^Ej: (.+)$/, "e.g. $1"],
    [/^VozLectura ([^\s]+) \(🔄 Actualizar a ([^)]+)\)$/, "VozLectura $1 (🔄 Update to $2)"],
    [/^Archivos borrados \(([^)]+) MB liberados\)$/, "Files removed ($1 MB freed)"],
  ];

  const TRANSLATED_ATTRS = ["title", "placeholder", "aria-label", "label"];
  const NO_TRANSLATE_SELECTOR = [
    "#chapter-content",
    ".epub-content",
    "#toc-list",
    "#obsidian-preview-box",
    "#obsidian-md-editor",
    "#offline-book-select",
    "#export-book-select",
    "#library-filter-author",
    "#library-filter-genre",
    "#chapter-selector",
    ".book-title",
    ".book-author",
    "textarea",
    "code",
    "pre",
    "script",
    "style",
    "[data-no-i18n]",
  ].join(", ");

  const textOriginals = new WeakMap();
  const attrOriginals = new WeakMap();
  let isApplying = false;

  function detectInitialLang() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "es" || saved === "en") return saved;
    } catch (_) {}
    const navLang = (navigator.language || "es").toLowerCase();
    return navLang.startsWith("en") ? "en" : "es";
  }

  let currentLang = detectInitialLang();

  function translateStringToEn(raw) {
    if (!raw || typeof raw !== "string") return raw;
    const trimmed = raw.trim();
    if (!trimmed) return raw;

    let translated = EXACT_ES_TO_EN[trimmed];
    if (!translated) {
      for (const [pattern, replacement] of REGEX_ES_TO_EN) {
        if (pattern.test(trimmed)) {
          translated =
            typeof replacement === "function"
              ? trimmed.replace(pattern, replacement)
              : trimmed.replace(pattern, replacement);
          break;
        }
      }
    }
    if (!translated) return raw;

    const lead = raw.match(/^\s*/)[0];
    const trail = raw.match(/\s*$/)[0];
    return `${lead}${translated}${trail}`;
  }

  function isExcludedNode(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return true;
    return Boolean(el.closest(NO_TRANSLATE_SELECTOR));
  }

  function processTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    if (isExcludedNode(node)) return;

    if (!textOriginals.has(node)) {
      textOriginals.set(node, node.nodeValue || "");
    }
    const orig = textOriginals.get(node);
    const nextVal = currentLang === "en" ? translateStringToEn(orig) : orig;
    if (node.nodeValue !== nextVal) {
      node.nodeValue = nextVal;
    }
  }

  function processElementAttrs(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (el.closest(NO_TRANSLATE_SELECTOR)) return;

    let map = attrOriginals.get(el);
    if (!map) {
      map = {};
      attrOriginals.set(el, map);
    }

    for (const attr of TRANSLATED_ATTRS) {
      if (attr === "label" && el.tagName !== "OPTGROUP") continue;
      if (!el.hasAttribute(attr)) continue;
      const curVal = el.getAttribute(attr);
      if (!(attr in map)) {
        map[attr] = curVal;
      }
      const orig = map[attr];
      const nextVal = currentLang === "en" ? translateStringToEn(orig) : orig;
      if (curVal !== nextVal) {
        el.setAttribute(attr, nextVal);
      }
    }
  }

  function walkSubtree(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      processTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches && root.matches(NO_TRANSLATE_SELECTOR)) return;

    processElementAttrs(root);
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      null
    );
    let current = walker.nextNode();
    while (current) {
      if (current.nodeType === Node.ELEMENT_NODE) {
        processElementAttrs(current);
      } else if (current.nodeType === Node.TEXT_NODE) {
        processTextNode(current);
      }
      current = walker.nextNode();
    }
  }

  function syncToggleButton() {
    const btn = document.getElementById("btn-lang-toggle");
    if (!btn) return;
    const label = btn.querySelector(".lang-code");
    if (label) {
      label.textContent = currentLang.toUpperCase();
    } else {
      btn.textContent = currentLang.toUpperCase();
    }
    btn.title =
      currentLang === "es"
        ? "Switch interface language to English (ES / EN)"
        : "Cambiar idioma de la interfaz a Español (ES / EN)";
  }

  function applyLanguage() {
    isApplying = true;
    try {
      document.documentElement.lang = currentLang;
      if (document.body) {
        walkSubtree(document.body);
      }
      syncToggleButton();
    } finally {
      isApplying = false;
    }
  }

  function setLang(lang) {
    const next = lang === "en" ? "en" : "es";
    currentLang = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch (_) {}
    applyLanguage();
  }

  function toggleLang() {
    setLang(currentLang === "es" ? "en" : "es");
    return currentLang;
  }

  const observer = new MutationObserver((mutations) => {
    if (isApplying) return;
    isApplying = true;
    try {
      for (const m of mutations) {
        if (m.type === "characterData") {
          const t = m.target;
          if (!isExcludedNode(t)) {
            textOriginals.set(t, t.nodeValue || "");
            processTextNode(t);
          }
        } else if (m.type === "attributes") {
          const el = m.target;
          const attr = m.attributeName;
          if (attr && TRANSLATED_ATTRS.includes(attr) && !el.closest(NO_TRANSLATE_SELECTOR)) {
            if (attr === "label" && el.tagName !== "OPTGROUP") continue;
            let map = attrOriginals.get(el);
            if (!map) {
              map = {};
              attrOriginals.set(el, map);
            }
            if (el.hasAttribute(attr)) {
              map[attr] = el.getAttribute(attr);
            }
            processElementAttrs(el);
          }
        } else if (m.type === "childList") {
          for (const added of m.addedNodes) {
            walkSubtree(added);
          }
        }
      }
    } finally {
      isApplying = false;
    }
  });

  function initI18n() {
    const btn = document.getElementById("btn-lang-toggle");
    if (btn && !btn.dataset.i18nBound) {
      btn.dataset.i18nBound = "1";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleLang();
      });
    }
    applyLanguage();
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: TRANSLATED_ATTRS,
      });
    }
  }

  window.VozLecturaI18n = {
    getLang: () => currentLang,
    setLang,
    toggleLang,
    applyLanguage,
    t: (esText) => (currentLang === "en" ? translateStringToEn(esText) : esText),
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initI18n);
  } else {
    initI18n();
  }
})();
