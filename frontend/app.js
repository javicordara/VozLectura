(() => {
  "use strict";

  const APP_VERSION = "1.1.0";
  const ACTIVE_PORT = (window.location && window.location.port) ? window.location.port : "8085";
  const DEFAULT_STATIC_SERVER_URL = `http://localhost:${ACTIVE_PORT}`;

  const state = {
    books: [],
    archivedBooks: [],
    voices: [],
    currentBook: null,
    currentChapter: null,
    chapterIndex: 0,
    sentenceIndex: 0,
    isPlaying: false,
    isLoadingAudio: false,
    readerUiMode: "reading",
    abShowSubtitle: false,
    sleepTimerMode: "off",
    sleepTimerEndMs: 0,
    ttsUpdatesData: null,
    ttsUpdatesNotified: false,
    selectedVoice: "piper:es_ES-davefx-medium",
    speed: 1.0,
    autoScroll: true,
    fontSize: 19,
    lineHeight: 1.8,
    flowMode: "scroll",
    columns: 1,
    textAlign: "justify",
    textIndent: "normal",
    marginSize: "normal",
    theme: "theme-sepia",
    fontFamily: "font-serif",
    currentPage: 0,
    totalPages: 1,
    pageStride: 0,
    playSessionId: 0,
    exportTargetBook: null,
    currentStudy: null,
    obsidianMarkdown: "",
    studyTargetBook: null,
    activeSession: null,
    isServerOffline: false,
    serverUrl: (
      (window.location.origin && /^https?:\/\//i.test(window.location.origin)
        ? window.location.origin
        : localStorage.getItem("vozlectura_server_url")) || DEFAULT_STATIC_SERVER_URL
    ).replace(/\/+$/, ""),
    swActive: false,
    deferredInstallPrompt: null,
    offlineBooksMap: new Map(),
    offlineDlCancel: false,
    isDownloadingOffline: false,
    lastPlaybackErrorReason: "",
    autoFullscreen: true,
    immersiveReader: false,
    sentenceGapMode: "auto",
    isCarBluetoothDetected: false,
    carBluetoothManualOverride: null,
    carBluetoothCustomName: "",
    carBluetoothDetectedDeviceName: "",
    gapModeAutoMigratedV50: true,
    libFilterSearch: "",
    libFilterAuthor: "all",
    libFilterGenre: "all",
    libFilterStatus: "all",
    libFilterRating: "all",
    libSortBy: "updated_at",
    libSortDir: "desc",
  };

  const nativeFetch = window.fetch.bind(window);
  function resolveApiUrl(url) {
    const str = String(url || "");
    if (str.startsWith("/api/")) {
      const base = (state.serverUrl || window.location.origin).replace(/\/+$/, "");
      return `${base}${str}`;
    }
    return str;
  }

  function fetch(input, init) {
    if (typeof input === "string") {
      return nativeFetch(resolveApiUrl(input), init);
    }
    return nativeFetch(input, init);
  }

  const MARGIN_WIDTHS = {
    narrow: "920px",
    normal: "1320px",
    wide: "1680px",
    full: "98vw",
  };

  const INDENT_VALUES = {
    none: { indent: "0", spacing: "1.1em" },
    normal: { indent: "1.5em", spacing: "0.45em" },
    wide: { indent: "2.5em", spacing: "0.45em" },
  };

  // Caché de blobs de audio pre-generados en el cliente: clave -> Promise<string (blobUrl)>
  const audioBlobCache = new Map();

  // Doble canal de audio (Ping-Pong) para transición sin pausa (Gapless) y compensación de buffer Bluetooth A2DP (coche)
  const audioChannelA = new Audio();
  const audioChannelB = new Audio();
  audioChannelA.preload = "auto";
  audioChannelB.preload = "auto";
  const audioPool = [audioChannelA, audioChannelB];
  let activeAudioIdx = 0;
  let standbyPreparedUrl = null;
  let lastMediaSessionKey = "";
  let lastMediaPositionUpdateAt = 0;

  function clearAudioBlobCache() {
    for (const [, p] of audioBlobCache.entries()) {
      if (p) {
        p.then((url) => url && URL.revokeObjectURL(url)).catch(() => {});
      }
    }
    audioBlobCache.clear();
    standbyPreparedUrl = null;
  }

  function getEffectiveSentenceGapMode() {
    if (state.carBluetoothManualOverride === true) return "car";
    if (state.carBluetoothManualOverride === false) return "normal";
    const mode = state.sentenceGapMode || "auto";
    if (mode === "auto") {
      return state.isCarBluetoothDetected ? "car" : "normal";
    }
    return mode;
  }

  /**
   * Recorta el silencio adaptativo inicial/final por energía RMS y compacta pausas internas largas en Modo Coche.
   * Evita colas de respiración/ruido de sala y alinea la fluidez entre idiomas en Bluetooth A2DP.
   */
  function createTrimmedWavBlobUrl(rawBytes, gapMode = getEffectiveSentenceGapMode()) {
    try {
      const resolvedMode = gapMode === "auto" ? getEffectiveSentenceGapMode() : gapMode;
      if (!rawBytes || rawBytes.byteLength < 64 || resolvedMode === "normal") {
        return URL.createObjectURL(new Blob([rawBytes], { type: "audio/wav" }));
      }
      const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
      // Verificar cabecera RIFF....WAVE
      if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
        return URL.createObjectURL(new Blob([rawBytes], { type: "audio/wav" }));
      }

      let offset = 12;
      let audioFormat = 1;
      let numChannels = 1;
      let sampleRate = 24000;
      let bitsPerSample = 16;
      let dataOffset = -1;
      let dataLength = 0;

      while (offset + 8 <= rawBytes.byteLength) {
        const chunkId = view.getUint32(offset, false);
        const chunkSize = view.getUint32(offset + 4, true);
        const payloadStart = offset + 8;
        if (chunkId === 0x666d7420 && payloadStart + 16 <= rawBytes.byteLength) {
          // "fmt "
          audioFormat = view.getUint16(payloadStart, true);
          numChannels = view.getUint16(payloadStart + 2, true);
          sampleRate = view.getUint32(payloadStart + 4, true);
          bitsPerSample = view.getUint16(payloadStart + 14, true);
        } else if (chunkId === 0x64617461) {
          // "data"
          dataOffset = payloadStart;
          dataLength = Math.min(chunkSize, rawBytes.byteLength - payloadStart);
          break;
        }
        offset = payloadStart + chunkSize + (chunkSize & 1);
      }

      // Solo recortar si es PCM lineal de 16 bits
      if (audioFormat !== 1 || bitsPerSample !== 16 || dataOffset < 0 || dataLength < 4) {
        return URL.createObjectURL(new Blob([rawBytes], { type: "audio/wav" }));
      }

      const bytesPerFrame = Math.max(2, numChannels * 2);
      const totalFrames = Math.floor(dataLength / bytesPerFrame);
      if (totalFrames < sampleRate * 0.12) {
        return URL.createObjectURL(new Blob([rawBytes], { type: "audio/wav" }));
      }

      // Energía RMS por ventanas de 10 ms para distinguir voz real de respiración o ruido de sala
      const winFrames = Math.max(1, Math.floor(sampleRate * 0.01));
      const numWins = Math.floor(totalFrames / winFrames);
      if (numWins < 12) {
        return URL.createObjectURL(new Blob([rawBytes], { type: "audio/wav" }));
      }

      const rms = new Float32Array(numWins);
      const totalSamplesInWin = winFrames * numChannels;
      for (let w = 0; w < numWins; w++) {
        let sumSq = 0;
        const winSampleStart = dataOffset + w * winFrames * bytesPerFrame;
        for (let s = 0; s < totalSamplesInWin; s++) {
          const val = view.getInt16(winSampleStart + s * 2, true);
          sumSq += val * val;
        }
        rms[w] = Math.sqrt(sumSq / totalSamplesInWin);
      }

      const sortedRms = Float32Array.from(rms).sort();
      const p10 = sortedRms[Math.floor(numWins * 0.10)];
      const p85 = sortedRms[Math.floor(numWins * 0.85)];

      // Umbral adaptativo para recortar bordes (ignora respiraciones suaves / suelo de ruido)
      const edgeThresh = Math.max(145, p10 * 2.8, p85 * 0.045);
      let firstWin = -1;
      let lastWin = -1;
      for (let w = 0; w < numWins; w++) {
        if (rms[w] > edgeThresh) {
          if (firstWin < 0) firstWin = w;
          lastWin = w;
        }
      }
      if (firstWin < 0) {
        return URL.createObjectURL(new Blob([rawBytes], { type: "audio/wav" }));
      }

      // Margen de seguridad (en ms) al inicio y al final de cada frase según modo elegido
      const leadPadMs = resolvedMode === "car" ? 10 : 22;
      const trailPadMs = resolvedMode === "car" ? 20 : 58;
      const startFrame = Math.max(0, firstWin * winFrames - Math.floor((sampleRate * leadPadMs) / 1000));
      const endFrame = Math.min(
        totalFrames - 1,
        (lastWin + 1) * winFrames + Math.floor((sampleRate * trailPadMs) / 1000)
      );
      if (endFrame <= startFrame) {
        return URL.createObjectURL(new Blob([rawBytes], { type: "audio/wav" }));
      }

      // Compactar silencios internos largos (>260 ms -> ~150 ms) solo en Modo Coche
      const crossfadeFrames = Math.max(1, Math.floor(sampleRate * 0.01));
      const segments = [];
      if (resolvedMode === "car" && lastWin - firstWin > 32) {
        const interiorSilThresh = Math.max(115, p10 * 2.3, p85 * 0.035);
        const maxPauseWins = 26;
        const keepBeforeWins = 8;
        const keepAfterWins = 7;
        let curSegStart = startFrame;

        let w = firstWin;
        while (w <= lastWin) {
          if (rms[w] < interiorSilThresh) {
            const silStartW = w;
            while (w <= lastWin && rms[w] < interiorSilThresh) {
              w++;
            }
            const silEndW = w;
            if (silEndW - silStartW > maxPauseWins) {
              const segEnd = Math.min(
                endFrame + 1,
                (silStartW + keepBeforeWins) * winFrames + crossfadeFrames
              );
              const nextStart = (silEndW - keepAfterWins) * winFrames;
              if (
                segEnd - curSegStart >= crossfadeFrames * 2 &&
                nextStart >= segEnd &&
                endFrame + 1 - nextStart >= crossfadeFrames * 2
              ) {
                segments.push([curSegStart, segEnd]);
                curSegStart = nextStart;
              }
            }
          } else {
            w++;
          }
        }
        segments.push([curSegStart, endFrame + 1]);
      } else {
        segments.push([startFrame, endFrame + 1]);
      }

      if (segments.length === 1 && segments[0][0] === 0 && segments[0][1] >= totalFrames) {
        return URL.createObjectURL(new Blob([rawBytes], { type: "audio/wav" }));
      }

      let outFrames = 0;
      for (let i = 0; i < segments.length; i++) {
        outFrames += segments[i][1] - segments[i][0];
        if (i > 0) outFrames -= crossfadeFrames;
      }
      if (outFrames <= 0) {
        return URL.createObjectURL(new Blob([rawBytes], { type: "audio/wav" }));
      }

      const keptDataBytes = outFrames * bytesPerFrame;
      const outBuffer = new ArrayBuffer(44 + keptDataBytes);
      const outView = new DataView(outBuffer);
      const outBytes = new Uint8Array(outBuffer);

      // Escribir cabecera WAV estándar de 44 bytes
      outView.setUint32(0, 0x52494646, false); // "RIFF"
      outView.setUint32(4, 36 + keptDataBytes, true);
      outView.setUint32(8, 0x57415645, false); // "WAVE"
      outView.setUint32(12, 0x666d7420, false); // "fmt "
      outView.setUint32(16, 16, true);
      outView.setUint16(20, 1, true); // PCM
      outView.setUint16(22, numChannels, true);
      outView.setUint32(24, sampleRate, true);
      outView.setUint32(28, sampleRate * bytesPerFrame, true);
      outView.setUint16(32, bytesPerFrame, true);
      outView.setUint16(34, 16, true);
      outView.setUint32(36, 0x64617461, false); // "data"
      outView.setUint32(40, keptDataBytes, true);

      // Copiar primer segmento y ensamblar los siguientes con crossfade lineal de 10 ms
      const [seg0Start, seg0End] = segments[0];
      outBytes.set(
        rawBytes.subarray(dataOffset + seg0Start * bytesPerFrame, dataOffset + seg0End * bytesPerFrame),
        44
      );
      let writeFrameCursor = seg0End - seg0Start;

      for (let i = 1; i < segments.length; i++) {
        const [sStart, sEnd] = segments[i];
        const fadeStartFrame = writeFrameCursor - crossfadeFrames;
        for (let cf = 0; cf < crossfadeFrames; cf++) {
          const alpha = (cf + 1) / (crossfadeFrames + 1);
          const outFrameBase = 44 + (fadeStartFrame + cf) * bytesPerFrame;
          const srcFrameBase = dataOffset + (sStart + cf) * bytesPerFrame;
          for (let ch = 0; ch < numChannels; ch++) {
            const prevS = outView.getInt16(outFrameBase + ch * 2, true);
            const nextS = view.getInt16(srcFrameBase + ch * 2, true);
            const mixed = Math.max(
              -32768,
              Math.min(32767, Math.round(prevS * (1 - alpha) + nextS * alpha))
            );
            outView.setInt16(outFrameBase + ch * 2, mixed, true);
          }
        }
        const remFrames = sEnd - sStart - crossfadeFrames;
        if (remFrames > 0) {
          const srcTailStart = dataOffset + (sStart + crossfadeFrames) * bytesPerFrame;
          const dstTailOffset = 44 + writeFrameCursor * bytesPerFrame;
          outBytes.set(
            rawBytes.subarray(srcTailStart, srcTailStart + remFrames * bytesPerFrame),
            dstTailOffset
          );
          writeFrameCursor += remFrames;
        }
      }

      // Micro-fundidos en bordes exteriores (6 ms entrada / 12 ms salida) para evitar clics por ruido de fondo
      const fadeInFrames = Math.min(Math.floor(outFrames / 4), Math.floor(sampleRate * 0.006));
      if (fadeInFrames > 1) {
        for (let f = 0; f < fadeInFrames; f++) {
          const gain = f / fadeInFrames;
          const fBase = 44 + f * bytesPerFrame;
          for (let ch = 0; ch < numChannels; ch++) {
            const smp = outView.getInt16(fBase + ch * 2, true);
            outView.setInt16(fBase + ch * 2, Math.round(smp * gain), true);
          }
        }
      }
      const fadeOutFrames = Math.min(Math.floor(outFrames / 4), Math.floor(sampleRate * 0.012));
      if (fadeOutFrames > 1) {
        for (let f = 0; f < fadeOutFrames; f++) {
          const gain = (fadeOutFrames - 1 - f) / fadeOutFrames;
          const fBase = 44 + (outFrames - fadeOutFrames + f) * bytesPerFrame;
          for (let ch = 0; ch < numChannels; ch++) {
            const smp = outView.getInt16(fBase + ch * 2, true);
            outView.setInt16(fBase + ch * 2, Math.round(smp * gain), true);
          }
        }
      }

      return URL.createObjectURL(new Blob([outBytes], { type: "audio/wav" }));
    } catch (_) {
      return URL.createObjectURL(new Blob([rawBytes], { type: "audio/wav" }));
    }
  }

  // =========================================================================
  // PUENTE DE AUDIO CONTINUO Y WAKELOCK PARA PANTALLA APAGADA EN ANDROID
  // =========================================================================
  const keepAliveAudio = new Audio();
  keepAliveAudio.loop = true;
  keepAliveAudio.preload = "auto";
  let keepAliveWavUrl = null;
  let wakeLockSentinel = null;

  function getOrCreateKeepAliveWavUrl() {
    if (keepAliveWavUrl) return keepAliveWavUrl;
    const sampleRate = 24000;
    const durationSeconds = 12;
    const numSamples = sampleRate * durationSeconds;
    const dataBytes = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataBytes, true);

    // Pulso infrasónico de 1 Hz (totalmente fuera del espectro audible 20Hz-20kHz y a 24kHz nativos)
    // para que el mezclador de Android no cambie de frecuencia de muestreo ni coloree la voz
    for (let i = 0; i < numSamples; i++) {
      const val = i % sampleRate < sampleRate / 2 ? 1 : 0;
      view.setInt16(44 + i * 2, val, true);
    }

    const blob = new Blob([buffer], { type: "audio/wav" });
    keepAliveWavUrl = URL.createObjectURL(blob);
    return keepAliveWavUrl;
  }

  async function startBackgroundKeepAlive() {
    try {
      if (!keepAliveAudio.src) {
        keepAliveAudio.src = getOrCreateKeepAliveWavUrl();
      }
      keepAliveAudio.volume = 0.0001;
      if (keepAliveAudio.paused) {
        await keepAliveAudio.play();
      }
    } catch (_) {}

    if ("wakeLock" in navigator && !wakeLockSentinel) {
      try {
        wakeLockSentinel = await navigator.wakeLock.request("screen");
        wakeLockSentinel.addEventListener("release", () => {
          wakeLockSentinel = null;
        });
      } catch (_) {}
    }
  }

  function stopBackgroundKeepAlive() {
    try {
      keepAliveAudio.pause();
    } catch (_) {}
    if (wakeLockSentinel) {
      try {
        wakeLockSentinel.release();
      } catch (_) {}
      wakeLockSentinel = null;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (state.isPlaying || state.isDownloadingOffline)) {
      startBackgroundKeepAlive();
    }
  });

  // Fetch con tiempo máximo de espera para que la interfaz nunca se bloquee si el móvil pierde conexión con el servidor
  async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  let isCheckingServerOnline = false;
  async function verifyServerOnline({ reloadLibrary = true } = {}) {
    if (isCheckingServerOnline) return !state.isServerOffline;
    isCheckingServerOnline = true;
    try {
      const candidates = [
        ...new Set([
          window.location.origin && /^https?:\/\//i.test(window.location.origin)
            ? window.location.origin.replace(/\/+$/, "")
            : "",
          state.serverUrl,
          DEFAULT_STATIC_SERVER_URL,
        ]),
      ].filter(Boolean);

      for (const base of candidates) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3200);
          const r = await nativeFetch(`${base}/api/ping`, {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
          }).finally(() => clearTimeout(timer));
          if (r && r.ok) {
            if (state.serverUrl !== base) {
              state.serverUrl = base;
              try {
                localStorage.setItem("vozlectura_server_url", base);
              } catch (_) {}
            }
            const wasOffline = state.isServerOffline;
            state.isServerOffline = false;
            if (wasOffline) {
              updateOfflineHeaderBadge();
              if (reloadLibrary) {
                fetchLibrary().catch(() => {});
              }
              syncPendingOfflineSessions().catch(() => {});
              syncPendingOfflineStudyItems().catch(() => {});
            }
            return true;
          }
        } catch (_) {}
      }
      return false;
    } finally {
      isCheckingServerOnline = false;
    }
  }

  async function markServerPotentiallyOffline() {
    const stillOnline = await verifyServerOnline({ reloadLibrary: false });
    if (!stillOnline) {
      state.isServerOffline = true;
      updateOfflineHeaderBadge();
    }
    return !stillOnline;
  }

  // Watchdog automático: si en algún momento el móvil entró en Modo Local por un microcorte Wi-Fi o reposo,
  // comprueba periódicamente si el servidor responde y reconecta solo sin intervención del usuario
  setInterval(() => {
    if (state.isServerOffline && document.visibilityState === "visible") {
      verifyServerOnline().catch(() => {});
    }
  }, 5500);

  // =========================================================================
  // BASE DE DATOS LOCAL INDEXEDDB PARA MODO SIN CONEXIÓN (OFFLINE)
  // =========================================================================
  const OfflineStore = (() => {
    const DB_NAME = "vozlectura_offline_db";
    const DB_VERSION = 1;
    let dbPromise = null;

    function openDb() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        if (!("indexedDB" in window)) {
          reject(new Error("IndexedDB no disponible en este navegador"));
          return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains("books")) {
            db.createObjectStore("books", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("chapter_audio")) {
            const store = db.createObjectStore("chapter_audio", { keyPath: "key" });
            store.createIndex("by_book", "book_id", { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }

    async function listBooks() {
      try {
        const db = await openDb();
        const booksArr = await new Promise((resolve, reject) => {
          const tx = db.transaction("books", "readonly");
          const req = tx.objectStore("books").getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });

        // Auditar la integridad real de cada capítulo descargado en chapter_audio
        // (detecta automáticamente si una descarga anterior se cortó a mitad de capítulo al apagarse la pantalla)
        const audioMetaByBook = new Map();
        await new Promise((resolve) => {
          try {
            const tx = db.transaction("chapter_audio", "readonly");
            const cursorReq = tx.objectStore("chapter_audio").openCursor();
            cursorReq.onsuccess = (e) => {
              const cursor = e.target.result;
              if (!cursor) {
                resolve();
                return;
              }
              const val = cursor.value || {};
              const bId = val.book_id;
              if (bId) {
                if (!audioMetaByBook.has(bId)) audioMetaByBook.set(bId, []);
                const sMap = val.sentences_b64 || {};
                const keys = Object.keys(sMap);
                audioMetaByBook.get(bId).push({
                  chapter_index: Number(val.chapter_index || 0),
                  voice_id: val.voice_id || "",
                  voice_name: val.voice_name || val.voice_id || "",
                  speed: Number(val.speed || 1.0),
                  saved_count: keys.length,
                });
              }
              cursor.continue();
            };
            cursorReq.onerror = () => resolve();
          } catch (_) {
            resolve();
          }
        });

        for (const rec of booksArr) {
          const chList = Array.isArray(rec.chapters) ? rec.chapters : [];
          const chTotalsMap = new Map();
          let bookTotalSents = 0;
          for (const ch of chList) {
            const cIdx = Number(ch.index);
            const cnt = Number(ch.sentence_count || (ch.sentences && ch.sentences.length) || 0);
            chTotalsMap.set(cIdx, cnt);
            bookTotalSents += cnt;
          }
          if (!bookTotalSents && rec.book && rec.book.total_sentences) {
            bookTotalSents = Number(rec.book.total_sentences);
          }

          const rawPacks = rec.audio_packs || {};
          const actualEntries = audioMetaByBook.get(rec.id) || [];
          for (const entry of actualEntries) {
            const vKey = `${entry.voice_id}|${Number(entry.speed).toFixed(2)}`;
            if (!rawPacks[vKey]) {
              rawPacks[vKey] = {
                voice_id: entry.voice_id,
                voice_name: entry.voice_name,
                speed: entry.speed,
                chapters: [],
              };
            }
            const p = rawPacks[vKey];
            if (!p.chapter_stats) p.chapter_stats = {};
            const expectedTotal = chTotalsMap.get(entry.chapter_index) || entry.saved_count || 1;
            const isComplete = entry.saved_count >= expectedTotal && expectedTotal > 0;
            p.chapter_stats[entry.chapter_index] = {
              saved: entry.saved_count,
              total: expectedTotal,
              complete: isComplete,
            };
          }

          for (const p of Object.values(rawPacks)) {
            const statsObj = p.chapter_stats || {};
            const completeChapters = [];
            const partialChapters = [];
            let savedSentencesTotal = 0;
            for (const [chKey, st] of Object.entries(statsObj)) {
              const cIdx = Number(chKey);
              savedSentencesTotal += Number(st.saved || 0);
              if (st.complete) {
                completeChapters.push(cIdx);
              } else if (st.saved > 0) {
                partialChapters.push({
                  chapter_index: cIdx,
                  saved: st.saved,
                  total: st.total,
                });
              }
            }
            completeChapters.sort((a, b) => a - b);
            partialChapters.sort((a, b) => a.chapter_index - b.chapter_index);
            p.complete_chapters = completeChapters;
            p.partial_chapters = partialChapters;
            p.saved_sentences_total = savedSentencesTotal;
            p.book_sentences_total = bookTotalSents;
            p.total_book_chapters = chList.length || (rec.book && rec.book.chapter_count) || 0;
            p.is_fully_downloaded =
              p.total_book_chapters > 0 &&
              completeChapters.length >= p.total_book_chapters &&
              partialChapters.length === 0;
          }
          rec.audio_packs = rawPacks;
        }

        return booksArr;
      } catch (_) {
        return [];
      }
    }

    async function getBookBundle(bookId) {
      try {
        const db = await openDb();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction("books", "readonly");
          const req = tx.objectStore("books").get(bookId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      } catch (_) {
        return null;
      }
    }

    async function saveBookBundle(bundleData) {
      const db = await openDb();
      const existing = await getBookBundle(bundleData.book.id);
      const record = {
        id: bundleData.book.id,
        saved_at: new Date().toISOString(),
        book: bundleData.book,
        chapters: bundleData.chapters || [],
        study: bundleData.study || null,
        obsidian_markdown: bundleData.obsidian_markdown || "",
        audio_packs: existing && existing.audio_packs ? existing.audio_packs : {},
      };
      return new Promise((resolve, reject) => {
        const tx = db.transaction("books", "readwrite");
        tx.objectStore("books").put(record);
        tx.oncomplete = () => resolve(record);
        tx.onerror = () => reject(tx.error);
      });
    }

    async function updateBookProgress(bookId, progressObj, { dirtyOffline = false } = {}) {
      try {
        const existing = await getBookBundle(bookId);
        if (!existing || !existing.book) return;
        const nowSec = Math.floor(Date.now() / 1000);
        const prevProg = existing.book.progress || {};
        const mergedPositions = {
          ...(prevProg.chapter_positions || {}),
          ...((progressObj && progressObj.chapter_positions) || {}),
        };
        if (
          progressObj &&
          progressObj.chapter_index !== undefined &&
          progressObj.sentence_index !== undefined
        ) {
          mergedPositions[String(progressObj.chapter_index)] = Math.max(
            0,
            Number(progressObj.sentence_index || 0)
          );
        }
        existing.book.progress = {
          ...prevProg,
          ...progressObj,
          chapter_positions: mergedPositions,
          updated_at: Number((progressObj && progressObj.updated_at) || nowSec),
          last_read_at: Number(
            (progressObj && (progressObj.last_read_at || progressObj.updated_at)) || nowSec
          ),
          dirty_offline: Boolean(dirtyOffline),
        };
        const memBundle = state.offlineBooksMap.get(bookId);
        if (memBundle && memBundle.book) {
          memBundle.book.progress = existing.book.progress;
        }
        const db = await openDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction("books", "readwrite");
          tx.objectStore("books").put(existing);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (_) {}
    }

    async function updateBookStudy(bookId, studyObj, obsidianMarkdown = null) {
      if (!bookId || !studyObj) return;
      try {
        const existing = await getBookBundle(bookId);
        if (!existing) return;
        existing.study = studyObj;
        if (typeof obsidianMarkdown === "string") {
          existing.obsidian_markdown = obsidianMarkdown;
        }
        const memBundle = state.offlineBooksMap.get(bookId);
        if (memBundle) {
          memBundle.study = studyObj;
          if (typeof obsidianMarkdown === "string") {
            memBundle.obsidian_markdown = obsidianMarkdown;
          }
        }
        const db = await openDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction("books", "readwrite");
          tx.objectStore("books").put(existing);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (_) {}
    }

    async function syncServerBookMeta(serverBook) {
      if (!serverBook || !serverBook.id) return;
      try {
        const existing = await getBookBundle(serverBook.id);
        if (!existing || !existing.book) return;
        const localProg = existing.book.progress || {};
        const srvProg = serverBook.progress || {};
        const keepLocalProg =
          Boolean(localProg.dirty_offline) &&
          Number(localProg.updated_at || 0) > Number(srvProg.updated_at || 0);
        const mergedPositions = {
          ...(srvProg.chapter_positions || {}),
          ...(localProg.chapter_positions || {}),
        };
        if (srvProg.chapter_index !== undefined && srvProg.sentence_index !== undefined) {
          const srvChKey = String(srvProg.chapter_index);
          if (!keepLocalProg || mergedPositions[srvChKey] === undefined) {
            mergedPositions[srvChKey] = Math.max(0, Number(srvProg.sentence_index || 0));
          }
        }
        if (
          keepLocalProg &&
          localProg.chapter_index !== undefined &&
          localProg.sentence_index !== undefined
        ) {
          mergedPositions[String(localProg.chapter_index)] = Math.max(
            0,
            Number(localProg.sentence_index || 0)
          );
        }

        const finalProg = keepLocalProg
          ? { ...srvProg, ...localProg, chapter_positions: mergedPositions }
          : {
              ...localProg,
              ...srvProg,
              chapter_positions: mergedPositions,
              dirty_offline: false,
            };

        existing.book = {
          ...existing.book,
          ...serverBook,
          pairing: serverBook.pairing !== undefined ? serverBook.pairing : existing.book.pairing,
          progress: finalProg,
        };
        const memBundle = state.offlineBooksMap.get(serverBook.id);
        if (memBundle) {
          memBundle.book = existing.book;
        }
        const db = await openDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction("books", "readwrite");
          tx.objectStore("books").put(existing);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (_) {}
    }

    function makeAudioPackKey(bookId, voiceId, speed, chapterIdx) {
      return `${bookId}|${voiceId}|${Number(speed).toFixed(2)}|${chapterIdx}`;
    }

    async function saveChapterAudioPack(
      bookId,
      voiceId,
      speed,
      chapterIdx,
      voiceName,
      sentencesAudioArr,
      expectedTotalSentences = 0
    ) {
      const db = await openDb();
      const key = makeAudioPackKey(bookId, voiceId, speed, chapterIdx);
      const existingPack = await getChapterAudioPack(bookId, voiceId, speed, chapterIdx);
      const sentencesMap =
        existingPack && existingPack.sentences_b64 ? { ...existingPack.sentences_b64 } : {};
      for (const item of sentencesAudioArr || []) {
        sentencesMap[String(item.index)] = item.wav_b64;
      }
      const savedCount = Object.keys(sentencesMap).length;
      const totalSents = Math.max(
        Number(expectedTotalSentences || 0),
        Number((existingPack && existingPack.total_sentences) || 0),
        savedCount
      );
      const updatedPackObj = {
        key,
        book_id: bookId,
        chapter_index: chapterIdx,
        voice_id: voiceId,
        voice_name: voiceName,
        speed: Number(speed),
        saved_count: savedCount,
        total_sentences: totalSents,
        sentences_b64: sentencesMap,
      };
      await new Promise((resolve, reject) => {
        const tx = db.transaction("chapter_audio", "readwrite");
        tx.objectStore("chapter_audio").put(updatedPackObj);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      if (cachedLocalChapterPack && cachedLocalChapterPack.key === key) {
        cachedLocalChapterPack = updatedPackObj;
      }

      const existing = await getBookBundle(bookId);
      if (existing) {
        const vKey = `${voiceId}|${Number(speed).toFixed(2)}`;
        if (!existing.audio_packs) existing.audio_packs = {};
        const info = existing.audio_packs[vKey] || {
          voice_id: voiceId,
          voice_name: voiceName,
          speed: Number(speed),
          chapters: [],
          chapter_stats: {},
        };
        if (!info.chapter_stats) info.chapter_stats = {};
        const isComplete = savedCount >= totalSents && totalSents > 0;
        info.chapter_stats[chapterIdx] = {
          saved: savedCount,
          total: totalSents,
          complete: isComplete,
        };
        if (!info.chapters.includes(chapterIdx)) {
          info.chapters.push(chapterIdx);
          info.chapters.sort((a, b) => a - b);
        }
        existing.audio_packs[vKey] = info;
        await new Promise((resolve, reject) => {
          const tx = db.transaction("books", "readwrite");
          tx.objectStore("books").put(existing);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
      return { savedCount, totalSents, isComplete: savedCount >= totalSents && totalSents > 0 };
    }

    async function getChapterAudioPack(bookId, voiceId, speed, chapterIdx) {
      try {
        const db = await openDb();
        const key = makeAudioPackKey(bookId, voiceId, speed, chapterIdx);
        return await new Promise((resolve, reject) => {
          const tx = db.transaction("chapter_audio", "readonly");
          const req = tx.objectStore("chapter_audio").get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      } catch (_) {
        return null;
      }
    }

    async function deleteBook(bookId) {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(["books", "chapter_audio"], "readwrite");
        tx.objectStore("books").delete(bookId);
        const idx = tx.objectStore("chapter_audio").index("by_book");
        const cursorReq = idx.openCursor(IDBKeyRange.only(bookId));
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    function base64ToBlobUrl(b64) {
      const binStr = atob(b64);
      const len = binStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      return createTrimmedWavBlobUrl(bytes, getEffectiveSentenceGapMode());
    }

    async function exportFullBookArchive(bookId) {
      const db = await openDb();
      const bookRecord = await getBookBundle(bookId);
      if (!bookRecord) {
        throw new Error("El libro no se encontró en la memoria local");
      }
      const chapterAudioRecords = await new Promise((resolve, reject) => {
        const tx = db.transaction("chapter_audio", "readonly");
        const idx = tx.objectStore("chapter_audio").index("by_book");
        const req = idx.getAll(IDBKeyRange.only(bookId));
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      return {
        format: "vozlectura_offline_book_v1",
        exported_at: new Date().toISOString(),
        book_record: bookRecord,
        chapter_audio_records: chapterAudioRecords,
      };
    }

    async function importFullBookArchive(archiveData) {
      if (
        !archiveData ||
        !archiveData.book_record ||
        !archiveData.book_record.id ||
        !archiveData.book_record.book
      ) {
        throw new Error("Archivo .vozbook no válido o incompleto");
      }
      const db = await openDb();
      const bookRec = archiveData.book_record;
      const audioRecs = Array.isArray(archiveData.chapter_audio_records)
        ? archiveData.chapter_audio_records
        : [];
      await new Promise((resolve, reject) => {
        const tx = db.transaction(["books", "chapter_audio"], "readwrite");
        tx.objectStore("books").put(bookRec);
        const audioStore = tx.objectStore("chapter_audio");
        for (const ar of audioRecs) {
          if (ar && ar.key) {
            audioStore.put(ar);
          }
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return bookRec;
    }

    return {
      listBooks,
      getBookBundle,
      saveBookBundle,
      updateBookProgress,
      updateBookStudy,
      syncServerBookMeta,
      saveChapterAudioPack,
      getChapterAudioPack,
      deleteBook,
      base64ToBlobUrl,
      exportFullBookArchive,
      importFullBookArchive,
    };
  })();

  // Referencias DOM
  const els = {
    libraryView: document.getElementById("library-view"),
    readerView: document.getElementById("reader-view"),
    booksGrid: document.getElementById("books-grid"),
    libraryCount: document.getElementById("library-count"),
    dropZone: document.getElementById("drop-zone"),
    fileInput: document.getElementById("epub-file-input"),
    btnSelectEpub: document.getElementById("btn-select-epub"),
    btnTopbarAddBook: document.getElementById("btn-topbar-add-book"),
    btnBackLibrary: document.getElementById("btn-back-library"),
    btnToggleToc: document.getElementById("btn-toggle-toc"),
    btnCloseToc: document.getElementById("btn-close-toc"),
    tocSidebar: document.getElementById("toc-sidebar"),
    tocList: document.getElementById("toc-list"),
    brandLogo: document.getElementById("brand-logo"),
    currentBookTitle: document.getElementById("current-book-title"),
    chapterBadge: document.getElementById("chapter-badge"),
    btnSwitchPaired: document.getElementById("btn-switch-paired"),
    btnToggleFlow: document.getElementById("btn-toggle-flow"),
    pageCounter: document.getElementById("page-counter"),
    sentenceCounter: document.getElementById("sentence-counter"),
    chapterViewportWrap: document.getElementById("chapter-viewport-wrap"),
    chapterViewport: document.getElementById("chapter-viewport"),
    chapterContent: document.getElementById("chapter-content"),
    btnPagePrev: document.getElementById("btn-page-prev"),
    btnPageNext: document.getElementById("btn-page-next"),
    paginationFooter: document.getElementById("pagination-footer"),
    paginationFooterLabel: document.getElementById("pagination-footer-label"),
    btnFooterPagePrev: document.getElementById("btn-footer-page-prev"),
    btnFooterPageNext: document.getElementById("btn-footer-page-next"),
    chapterNavFooter: document.getElementById("chapter-nav-footer"),
    btnPrevChapter: document.getElementById("btn-prev-chapter"),
    btnNextChapter: document.getElementById("btn-next-chapter"),
    btnPrevSentence: document.getElementById("btn-prev-sentence"),
    btnNextSentence: document.getElementById("btn-next-sentence"),
    btnPlayPause: document.getElementById("btn-play-pause"),
    iconPlay: document.getElementById("icon-play"),
    iconPause: document.getElementById("icon-pause"),
    iconLoading: document.getElementById("icon-loading"),
    playerProgressFill: document.getElementById("player-progress-fill"),
    statusIndicator: document.getElementById("tts-status-indicator"),
    statusText: document.getElementById("tts-status-text"),
    activeSentencePreview: document.getElementById("active-sentence-preview"),
    selectVoice: document.getElementById("select-voice"),
    selectSpeed: document.getElementById("select-speed"),
    btnOpenAppearance: document.getElementById("btn-open-appearance"),
    appearancePopover: document.getElementById("appearance-popover"),
    btnFontDec: document.getElementById("btn-font-dec"),
    btnFontInc: document.getElementById("btn-font-inc"),
    fontSizeLabel: document.getElementById("font-size-label"),
    btnLhDec: document.getElementById("btn-lh-dec"),
    btnLhInc: document.getElementById("btn-lh-inc"),
    lineHeightLabel: document.getElementById("line-height-label"),
    chkAutoscroll: document.getElementById("chk-autoscroll"),
    btnOpenModels: document.getElementById("btn-open-models"),
    btnCloseModels: document.getElementById("btn-close-models"),
    modelsModal: document.getElementById("models-modal"),
    modelsList: document.getElementById("models-list"),
    gpuStatusBadge: document.getElementById("gpu-status-badge"),
    btnOpenExports: document.getElementById("btn-open-exports"),
    exportsQueueBadge: document.getElementById("exports-queue-badge"),
    libraryQueueBanner: document.getElementById("library-queue-banner"),
    libraryQueueTitle: document.getElementById("library-queue-title"),
    libraryQueueSubtitle: document.getElementById("library-queue-subtitle"),
    libraryQueueBarFill: document.getElementById("library-queue-bar-fill"),
    btnBannerOpenQueue: document.getElementById("btn-banner-open-queue"),
    btnLibraryOpenQueue: document.getElementById("btn-library-open-queue"),
    libraryQueueCount: document.getElementById("library-queue-count"),
    btnCloseExports: document.getElementById("btn-close-exports"),
    exportsModal: document.getElementById("exports-modal"),
    exportBookSelect: document.getElementById("export-book-select"),
    exportVoiceSelect: document.getElementById("export-voice-select"),
    exportSpeedSelect: document.getElementById("export-speed-select"),
    chkExportM4b: document.getElementById("chk-export-m4b"),
    chkExportEpub: document.getElementById("chk-export-epub"),
    chkExportFilterBook: document.getElementById("chk-export-filter-book"),
    btnStartExport: document.getElementById("btn-start-export"),
    exportJobBox: document.getElementById("export-job-box"),
    exportJobPhase: document.getElementById("export-job-phase"),
    exportJobPct: document.getElementById("export-job-pct"),
    exportBarFill: document.getElementById("export-bar-fill"),
    exportJobCounts: document.getElementById("export-job-counts"),
    btnCancelExport: document.getElementById("btn-cancel-export"),
    btnDeleteActiveExport: document.getElementById("btn-delete-active-export"),
    exportsList: document.getElementById("exports-list"),
    btnOpenPairing: document.getElementById("btn-open-pairing"),
    btnOpenPairingLabel: document.getElementById("btn-open-pairing-label"),
    pairingModal: document.getElementById("pairing-modal"),
    btnClosePairing: document.getElementById("btn-close-pairing"),
    pairSourceTitle: document.getElementById("pair-source-title"),
    pairPartnerSelect: document.getElementById("pair-partner-select"),
    pairPrimarySelect: document.getElementById("pair-primary-select"),
    pairChSource: document.getElementById("pair-ch-source"),
    pairChTarget: document.getElementById("pair-ch-target"),
    pairOffsetHint: document.getElementById("pair-offset-hint"),
    chkPairAutoswitch: document.getElementById("chk-pair-autoswitch"),
    btnUnpairBooks: document.getElementById("btn-unpair-books"),
    btnSavePairing: document.getElementById("btn-save-pairing"),
    dictPopover: document.getElementById("dict-popover"),
    dictWordTitle: document.getElementById("dict-word-title"),
    dictPhonetic: document.getElementById("dict-phonetic"),
    btnDictSpeak: document.getElementById("btn-dict-speak"),
    btnCloseDict: document.getElementById("btn-close-dict"),
    dictBody: document.getElementById("dict-body"),
    dictVocabNote: document.getElementById("dict-vocab-note"),
    btnDictUnderline: document.getElementById("btn-dict-underline"),
    dictVocabStatus: document.getElementById("dict-vocab-status"),
    selectionToolbar: document.getElementById("selection-toolbar"),
    btnSelectionNote: document.getElementById("btn-selection-note"),
    btnOpenStudy: document.getElementById("btn-open-study"),
    btnOpenStudyLabel: document.getElementById("btn-open-study-label"),
    studyModal: document.getElementById("study-modal"),
    btnCloseStudy: document.getElementById("btn-close-study"),
    studyBookTitle: document.getElementById("study-book-title"),
    btnDownloadObsidianTop: document.getElementById("btn-download-obsidian-top"),
    studyCountHighlights: document.getElementById("study-count-highlights"),
    studyCountVocab: document.getElementById("study-count-vocab"),
    studyStatus: document.getElementById("study-status"),
    studyStartedAt: document.getElementById("study-started-at"),
    studyFinishedAt: document.getElementById("study-finished-at"),
    studyTimesRead: document.getElementById("study-times-read"),
    studyRating: document.getElementById("study-rating"),
    studyGenre: document.getElementById("study-genre"),
    studyPublishedDate: document.getElementById("study-published-date"),
    libFilterSearch: document.getElementById("lib-filter-search"),
    libFilterAuthor: document.getElementById("lib-filter-author"),
    libFilterGenre: document.getElementById("lib-filter-genre"),
    libFilterStatus: document.getElementById("lib-filter-status"),
    libFilterRating: document.getElementById("lib-filter-rating"),
    libSortBy: document.getElementById("lib-sort-by"),
    btnLibSortDir: document.getElementById("btn-lib-sort-dir"),
    libSortDirIcon: document.getElementById("lib-sort-dir-icon"),
    libSortDirLabel: document.getElementById("lib-sort-dir-label"),
    btnLibResetFilters: document.getElementById("btn-lib-reset-filters"),
    chkStudyAutoUnderline: document.getElementById("chk-study-auto-underline"),
    studyBookNotes: document.getElementById("study-book-notes"),
    studyTotalStats: document.getElementById("study-total-stats"),
    btnSaveStudyMeta: document.getElementById("btn-save-study-meta"),
    btnAddManualSession: document.getElementById("btn-add-manual-session"),
    studySessionsList: document.getElementById("study-sessions-list"),
    studyHighlightsList: document.getElementById("study-highlights-list"),
    studyVocabList: document.getElementById("study-vocab-list"),
    studyObsidianPreview: document.getElementById("study-obsidian-preview"),
    btnCopyObsidianMd: document.getElementById("btn-copy-obsidian-md"),
    btnDownloadObsidianMd: document.getElementById("btn-download-obsidian-md"),
    btnOpenOffline: document.getElementById("btn-open-offline"),
    btnOpenOfflineLabel: document.getElementById("btn-open-offline-label"),
    offlineStatusBadge: document.getElementById("offline-status-badge"),
    offlineModal: document.getElementById("offline-modal"),
    btnCloseOffline: document.getElementById("btn-close-offline"),
    offlineBookSelect: document.getElementById("offline-book-select"),
    offlineModeSelect: document.getElementById("offline-mode-select"),
    offlineVoiceRow: document.getElementById("offline-voice-row"),
    offlineVoiceSelect: document.getElementById("offline-voice-select"),
    offlineSpeedSelect: document.getElementById("offline-speed-select"),
    btnStartOfflineDl: document.getElementById("btn-start-offline-dl"),
    offlineDlBox: document.getElementById("offline-dl-box"),
    offlineDlPhase: document.getElementById("offline-dl-phase"),
    offlineDlPct: document.getElementById("offline-dl-pct"),
    offlineDlBar: document.getElementById("offline-dl-bar"),
    offlineDlDetail: document.getElementById("offline-dl-detail"),
    btnCancelOfflineDl: document.getElementById("btn-cancel-offline-dl"),
    offlineBooksList: document.getElementById("offline-books-list"),
    androidSwWarningBanner: document.getElementById("android-sw-warning-banner"),
    btnBannerActivateSw: document.getElementById("btn-banner-activate-sw"),
    offlineConnectionBanner: document.getElementById("offline-connection-banner"),
    offlineBannerTitle: document.getElementById("offline-banner-title"),
    offlineBannerSubtitle: document.getElementById("offline-banner-subtitle"),
    btnBannerScanIp: document.getElementById("btn-banner-scan-ip"),
    btnBannerOpenOffline: document.getElementById("btn-banner-open-offline"),
    swStatusBadge: document.getElementById("sw-status-badge"),
    swStatusDesc: document.getElementById("sw-status-desc"),
    swActivateStepsBox: document.getElementById("sw-activate-steps-box"),
    btnCopyAppOrigin: document.getElementById("btn-copy-app-origin"),
    btnCopyChromeFlag: document.getElementById("btn-copy-chrome-flag"),
    btnInstallPwaApp: document.getElementById("btn-install-pwa-app"),
    serverConnBadge: document.getElementById("server-conn-badge"),
    offlineServerUrlInput: document.getElementById("offline-server-url-input"),
    btnSaveServerUrl: document.getElementById("btn-save-server-url"),
    btnScanServerIp: document.getElementById("btn-scan-server-ip"),
    serverScanStatus: document.getElementById("server-scan-status"),
    vozbookFileInput: document.getElementById("vozbook-file-input"),
    btnImportVozbook: document.getElementById("btn-import-vozbook"),
    btnToggleFullscreen: document.getElementById("btn-toggle-fullscreen"),
    btnToggleFullscreenLabel: document.getElementById("btn-toggle-fullscreen-label"),
    iconFsEnter: document.getElementById("icon-fs-enter"),
    iconFsExit: document.getElementById("icon-fs-exit"),
    chkAutoFullscreen: document.getElementById("chk-auto-fullscreen"),
    chkImmersiveReader: document.getElementById("chk-immersive-reader"),
    selectSentenceGap: document.getElementById("select-sentence-gap"),
    carBtAutoPanel: document.getElementById("car-bt-auto-panel"),
    carBtStatusBadge: document.getElementById("car-bt-status-badge"),
    btnDetectCarBt: document.getElementById("btn-detect-car-bt"),
    inputCarBtName: document.getElementById("input-car-bt-name"),
    carBtDevicesList: document.getElementById("car-bt-devices-list"),
    btnQuickCarMode: document.getElementById("btn-quick-car-mode"),
    carModeQuickIcon: document.getElementById("car-mode-quick-icon"),
    carModeQuickLabel: document.getElementById("car-mode-quick-label"),
    btnToggleImmersive: document.getElementById("btn-toggle-immersive"),
    btnExitImmersive: document.getElementById("btn-exit-immersive"),
    btnOpenAudiobookSync: document.getElementById("btn-open-audiobook-sync"),
    btnOpenAudiobookSyncFromExports: document.getElementById("btn-open-audiobook-sync-from-exports"),
    audiobookSyncModal: document.getElementById("audiobook-sync-modal"),
    btnCloseAudiobookSync: document.getElementById("btn-close-audiobook-sync"),
    syncTargetMode: document.getElementById("sync-target-mode"),
    syncNewEpubBox: document.getElementById("sync-new-epub-box"),
    syncExistingBookBox: document.getElementById("sync-existing-book-box"),
    syncEpubInput: document.getElementById("sync-epub-input"),
    btnPickSyncEpub: document.getElementById("btn-pick-sync-epub"),
    syncEpubFilename: document.getElementById("sync-epub-filename"),
    syncExistingBookSelect: document.getElementById("sync-existing-book-select"),
    syncAudioInput: document.getElementById("sync-audio-input"),
    btnPickSyncAudio: document.getElementById("btn-pick-sync-audio"),
    syncAudioFilenames: document.getElementById("sync-audio-filenames"),
    syncAudiobookLabel: document.getElementById("sync-audiobook-label"),
    chkSyncBuildEpub: document.getElementById("chk-sync-build-epub"),
    chkSyncBuildM4b: document.getElementById("chk-sync-build-m4b"),
    syncUploadProgressBox: document.getElementById("sync-upload-progress-box"),
    syncUploadPhase: document.getElementById("sync-upload-phase"),
    syncUploadPct: document.getElementById("sync-upload-pct"),
    syncUploadBar: document.getElementById("sync-upload-bar"),
    btnStartAudiobookSync: document.getElementById("btn-start-audiobook-sync"),
    ttsPlayerBar: document.getElementById("tts-player-bar"),
    miniPlayerBookBar: document.getElementById("mini-player-book-bar"),
    miniPlayerOpenBook: document.getElementById("mini-player-open-book"),
    miniPlayerCover: document.getElementById("mini-player-cover"),
    miniPlayerCoverFallback: document.getElementById("mini-player-cover-fallback"),
    miniPlayerTitle: document.getElementById("mini-player-title"),
    miniPlayerChapter: document.getElementById("mini-player-chapter"),
    btnMiniOpenAudiobook: document.getElementById("btn-mini-open-audiobook"),
    btnMiniOpenReading: document.getElementById("btn-mini-open-reading"),
    btnMiniClosePlayer: document.getElementById("btn-mini-close-player"),
    btnToggleAudiobookMode: document.getElementById("btn-toggle-audiobook-mode"),
    btnPlayerAudiobookToggle: document.getElementById("btn-player-audiobook-toggle"),
    playerSleepBadge: document.getElementById("player-sleep-badge"),
    audiobookPlayerView: document.getElementById("audiobook-player-view"),
    abBtnBackLibrary: document.getElementById("ab-btn-back-library"),
    abBtnBackReading: document.getElementById("ab-btn-back-reading"),
    abBtnSwitchPaired: document.getElementById("ab-btn-switch-paired"),
    abBtnOpenToc: document.getElementById("ab-btn-open-toc"),
    abCoverWrap: document.getElementById("ab-cover-wrap"),
    abCoverImg: document.getElementById("ab-cover-img"),
    abCoverFallback: document.getElementById("ab-cover-fallback"),
    abBookTitle: document.getElementById("ab-book-title"),
    abBookAuthor: document.getElementById("ab-book-author"),
    abChapterBtn: document.getElementById("ab-chapter-btn"),
    abChapterTitle: document.getElementById("ab-chapter-title"),
    abSubtitleBox: document.getElementById("ab-subtitle-box"),
    abSubtitleText: document.getElementById("ab-subtitle-text"),
    abChapterSlider: document.getElementById("ab-chapter-slider"),
    abChapterProgressMeta: document.getElementById("ab-chapter-progress-meta"),
    abBookProgressMeta: document.getElementById("ab-book-progress-meta"),
    abStatusDot: document.getElementById("ab-status-dot"),
    abStatusText: document.getElementById("ab-status-text"),
    abBtnBackFast: document.getElementById("ab-btn-back-fast"),
    abBtnPrevSent: document.getElementById("ab-btn-prev-sent"),
    abBtnPlayPause: document.getElementById("ab-btn-play-pause"),
    abIconPlay: document.getElementById("ab-icon-play"),
    abIconPause: document.getElementById("ab-icon-pause"),
    abIconLoading: document.getElementById("ab-icon-loading"),
    abBtnNextSent: document.getElementById("ab-btn-next-sent"),
    abBtnFwdFast: document.getElementById("ab-btn-fwd-fast"),
    abBtnPrevChapter: document.getElementById("ab-btn-prev-chapter"),
    abBtnToggleSubtitle: document.getElementById("ab-btn-toggle-subtitle"),
    abBtnNextChapter: document.getElementById("ab-btn-next-chapter"),
    abSpeedPill: document.getElementById("ab-speed-pill"),
    abSpeedLabel: document.getElementById("ab-speed-label"),
    abSelectSpeed: document.getElementById("ab-select-speed"),
    abSleepPill: document.getElementById("ab-sleep-pill"),
    abSleepLabel: document.getElementById("ab-sleep-label"),
    abSelectSleepTimer: document.getElementById("ab-select-sleep-timer"),
    abSleepCountdown: document.getElementById("ab-sleep-countdown"),
    abBtnCarMode: document.getElementById("ab-btn-car-mode"),
    abCarModeValue: document.getElementById("ab-car-mode-value"),
    abVoiceLabel: document.getElementById("ab-voice-label"),
    abSelectVoice: document.getElementById("ab-select-voice"),
    ttsUpdatesBadge: document.getElementById("tts-updates-badge"),
    ttsUpdatesPanel: document.getElementById("tts-updates-panel"),
    ttsUpdatesSummary: document.getElementById("tts-updates-summary"),
    ttsUpdatesList: document.getElementById("tts-updates-list"),
    btnCheckTtsUpdates: document.getElementById("btn-check-tts-updates"),
    toast: document.getElementById("toast"),
  };

  let toastTimer = null;
  function showToast(msg, duration = 3400) {
    els.toast.textContent = msg;
    els.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), duration);
  }

  // Cargar preferencias visuales guardadas
  function loadAppearancePrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem("vozlectura_prefs") || "{}");
      if (saved.theme) state.theme = saved.theme;
      if (saved.fontFamily) state.fontFamily = saved.fontFamily;
      if (saved.fontSize) state.fontSize = Number(saved.fontSize);
      if (saved.lineHeight) state.lineHeight = Number(saved.lineHeight);
      if (saved.flowMode === "paginated" || saved.flowMode === "scroll") state.flowMode = saved.flowMode;
      if (saved.columns) state.columns = Number(saved.columns);
      if (saved.textAlign === "justify" || saved.textAlign === "left") state.textAlign = saved.textAlign;
      if (saved.textIndent && INDENT_VALUES[saved.textIndent]) state.textIndent = saved.textIndent;
      if (saved.marginSize) state.marginSize = saved.marginSize;
      if (typeof saved.autoScroll === "boolean") state.autoScroll = saved.autoScroll;
      if (typeof saved.autoFullscreen === "boolean") state.autoFullscreen = saved.autoFullscreen;
      if (typeof saved.immersiveReader === "boolean") state.immersiveReader = saved.immersiveReader;
      if (saved.readerUiMode === "audiobook" || saved.readerUiMode === "reading") {
        state.readerUiMode = saved.readerUiMode;
      }
      if (!saved.abCleanMigratedV59) {
        state.abShowSubtitle = false;
      } else if (typeof saved.abShowSubtitle === "boolean") {
        state.abShowSubtitle = saved.abShowSubtitle;
      }
      if (typeof saved.carBluetoothCustomName === "string") {
        state.carBluetoothCustomName = saved.carBluetoothCustomName;
      }
      if (!saved.gapModeAutoMigratedV50) {
        state.sentenceGapMode = "auto";
        state.gapModeAutoMigratedV50 = true;
        saveAppearancePrefs();
      } else if (
        saved.sentenceGapMode === "auto" ||
        saved.sentenceGapMode === "car" ||
        saved.sentenceGapMode === "tight" ||
        saved.sentenceGapMode === "normal"
      ) {
        state.sentenceGapMode = saved.sentenceGapMode;
      }
    } catch (_) {}
    applyAppearance();
    evaluateCarBluetoothConnection({ notifyChange: false });
  }

  function saveAppearancePrefs() {
    localStorage.setItem(
      "vozlectura_prefs",
      JSON.stringify({
        theme: state.theme,
        fontFamily: state.fontFamily,
        fontSize: state.fontSize,
        lineHeight: state.lineHeight,
        flowMode: state.flowMode,
        columns: state.columns,
        textAlign: state.textAlign,
        textIndent: state.textIndent,
        marginSize: state.marginSize,
        autoScroll: state.autoScroll,
        autoFullscreen: state.autoFullscreen,
        immersiveReader: state.immersiveReader,
        readerUiMode: state.readerUiMode,
        abShowSubtitle: state.abShowSubtitle,
        abCleanMigratedV59: true,
        sentenceGapMode: state.sentenceGapMode,
        carBluetoothCustomName: state.carBluetoothCustomName || "",
        gapModeAutoMigratedV50: true,
      })
    );
  }

  const DEFAULT_CAR_BT_KEYWORDS = [
    "coche",
    "car",
    "auto",
    "handsfree",
    "hands-free",
    "uconnect",
    "sync",
    "mmi",
    "r-link",
    "medianav",
    "mbux",
    "idrive",
    "carplay",
    "android auto",
    "mycar",
    "bt-car",
    "seat",
    "vw",
    "volkswagen",
    "toyota",
    "kia",
    "hyundai",
    "peugeot",
    "renault",
    "ford",
    "bmw",
    "audi",
    "mercedes",
    "mazda",
    "nissan",
    "skoda",
    "citroen",
    "opel",
    "dacia",
    "fiat",
    "volvo",
    "tesla",
    "mg",
    "byd",
    "cupra",
    "suzuki",
    "honda",
    "mitsubishi",
    "subaru",
    "lexus",
    "jeep",
    "pioneer",
    "kenwood",
    "alpine",
    "jvc",
  ];

  const HEADPHONE_EXCLUSION_KEYWORDS = [
    "airpods",
    "buds",
    "wh-",
    "wf-",
    "bose",
    "sennheiser",
    "soundcore",
    "jabra",
    "shokz",
    "beats",
    "nothing",
    "headphone",
    "auricular",
    "cascos",
  ];

  const BUILTIN_PHONE_DEVICE_KEYWORDS = [
    "speakerphone",
    "earpiece",
    "teléfono",
    "telefono",
    "altavoz",
    "auricular integrado",
    "micrófono integrado",
    "microfono integrado",
    "built-in",
    "internal",
    "camcorder",
  ];

  function isDeviceLabelMatchingCar(label) {
    const clean = String(label || "").trim().toLowerCase();
    if (!clean || clean === "default" || clean === "communications") return false;
    if (BUILTIN_PHONE_DEVICE_KEYWORDS.some((k) => clean.includes(k))) return false;

    const customRaw = String(state.carBluetoothCustomName || "").trim().toLowerCase();
    if (customRaw) {
      const customParts = customRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (customParts.length > 0) {
        return customParts.some((kw) => clean.includes(kw));
      }
    }

    if (HEADPHONE_EXCLUSION_KEYWORDS.some((hk) => clean.includes(hk))) {
      return false;
    }
    return DEFAULT_CAR_BT_KEYWORDS.some((ck) => clean.includes(ck));
  }

  function updateCarModeUi() {
    const effective = getEffectiveSentenceGapMode();
    const isCarActive = effective === "car";
    if (els.selectSentenceGap) {
      els.selectSentenceGap.value = state.sentenceGapMode || "auto";
    }
    if (els.inputCarBtName && document.activeElement !== els.inputCarBtName) {
      els.inputCarBtName.value = state.carBluetoothCustomName || "";
    }
    if (els.carBtAutoPanel) {
      els.carBtAutoPanel.classList.toggle("hidden", state.sentenceGapMode !== "auto");
    }
    if (els.carBtStatusBadge) {
      els.carBtStatusBadge.classList.toggle("is-car-active", isCarActive);
      if (state.carBluetoothManualOverride === true) {
        els.carBtStatusBadge.textContent = "🚗 Modo Coche fijado manualmente (Recortes activos)";
      } else if (state.carBluetoothManualOverride === false) {
        els.carBtStatusBadge.textContent = "📖 Modo Normal fijado manualmente (Sin recortes)";
      } else if (isCarActive) {
        const devLabel = state.carBluetoothDetectedDeviceName
          ? ` (${state.carBluetoothDetectedDeviceName})`
          : "";
        els.carBtStatusBadge.textContent = `🚗 Coche detectado${devLabel} — Recortes activos`;
      } else {
        els.carBtStatusBadge.textContent = "📖 Modo actual: Normal (Tal cual se genera en la app)";
      }
    }
    if (els.btnQuickCarMode) {
      els.btnQuickCarMode.classList.toggle("is-car-active", isCarActive);
      if (els.carModeQuickLabel) {
        els.carModeQuickLabel.textContent = isCarActive ? "Coche" : "Normal";
      }
      if (els.carModeQuickIcon) {
        els.carModeQuickIcon.textContent = isCarActive ? "🚗" : "📖";
      }
      els.btnQuickCarMode.title = isCarActive
        ? "Modo Coche ACTIVO (Recortes de pausas activados). Pulsa para volver al audio original sin recortes."
        : "Modo Normal ACTIVO (Audiolibro tal cual se genera en la app, sin recortes). Pulsa para activar los recortes de Modo Coche.";
    }
    if (els.abBtnCarMode) {
      els.abBtnCarMode.classList.toggle("is-car-active", isCarActive);
    }
    if (els.abCarModeValue) {
      els.abCarModeValue.textContent = isCarActive ? "🚗 Coche" : "🚗";
    }
  }

  async function evaluateCarBluetoothConnection({ notifyChange = true, renderList = false } = {}) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
      updateCarModeUi();
      return;
    }
    try {
      const prevEffective = getEffectiveSentenceGapMode();
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevs = devices.filter(
        (d) => (d.kind === "audiooutput" || d.kind === "audioinput") && d.label && d.label.trim()
      );

      let matchedName = "";
      for (const dev of audioDevs) {
        if (isDeviceLabelMatchingCar(dev.label)) {
          matchedName = dev.label.trim();
          break;
        }
      }

      const detectedNow = Boolean(matchedName);
      const changedDetection = state.isCarBluetoothDetected !== detectedNow;
      state.isCarBluetoothDetected = detectedNow;
      state.carBluetoothDetectedDeviceName = matchedName;

      // Si cambia la conexión física del coche, liberar cualquier override manual temporal
      if (changedDetection) {
        state.carBluetoothManualOverride = null;
      }

      const nextEffective = getEffectiveSentenceGapMode();
      updateCarModeUi();

      if (renderList && els.carBtDevicesList) {
        renderDetectedAudioDevicesChips(audioDevs);
      }

      if (prevEffective !== nextEffective) {
        standbyPreparedUrl = null;
        if (state.isPlaying) {
          prefetchNextSentences(state.sentenceIndex);
        }
        if (notifyChange && state.sentenceGapMode === "auto") {
          if (nextEffective === "car") {
            showToast(
              `🚗 Bluetooth del coche detectado (${matchedName || "Coche"}) — Recortes de pausas activados automáticamente`,
              4500
            );
          } else {
            showToast(
              "📖 Bluetooth del coche desconectado — Audiolibro original sin recortes restaurado",
              4200
            );
          }
        }
      }
    } catch (_) {
      updateCarModeUi();
    }
  }

  function renderDetectedAudioDevicesChips(audioDevs) {
    if (!els.carBtDevicesList) return;
    els.carBtDevicesList.innerHTML = "";
    const uniqueLabels = [];
    const seen = new Set();
    for (const d of audioDevs || []) {
      const lbl = String(d.label || "").trim();
      const low = lbl.toLowerCase();
      if (
        !lbl ||
        low === "default" ||
        low === "communications" ||
        BUILTIN_PHONE_DEVICE_KEYWORDS.some((k) => low.includes(k)) ||
        seen.has(low)
      ) {
        continue;
      }
      seen.add(low);
      uniqueLabels.push(lbl);
    }

    els.carBtDevicesList.classList.remove("hidden");
    if (uniqueLabels.length === 0) {
      els.carBtDevicesList.innerHTML = `<span style="font-size:0.72rem;color:var(--text-secondary)">✓ Permiso activo. Conecta ahora el Bluetooth de tu coche o escribe su nombre arriba (ej: SEAT, Kia, My Car).</span>`;
      return;
    }

    for (const lbl of uniqueLabels) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "car-bt-device-chip";
      chip.textContent = `🚗 Usar «${lbl}»`;
      chip.addEventListener("click", () => {
        state.carBluetoothCustomName = lbl;
        if (els.inputCarBtName) els.inputCarBtName.value = lbl;
        saveAppearancePrefs();
        evaluateCarBluetoothConnection({ notifyChange: true, renderList: false });
        showToast(`✅ Guardado «${lbl}» como el Bluetooth de tu coche`);
      });
      els.carBtDevicesList.appendChild(chip);
    }
  }

  async function requestCarBluetoothPermissionAndScan() {
    if (!navigator.mediaDevices) {
      showToast("Tu navegador no expone la lista de dispositivos de audio");
      return;
    }
    try {
      if (typeof navigator.mediaDevices.getUserMedia === "function") {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      }
    } catch (_) {}
    await evaluateCarBluetoothConnection({ notifyChange: true, renderList: true });
  }

  function isFullscreenActive() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  }

  async function enterFullscreenIfAllowed() {
    if (isFullscreenActive()) return;
    const docEl = document.documentElement;
    try {
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen({ navigationUI: "hide" });
      } else if (docEl.webkitRequestFullscreen) {
        docEl.webkitRequestFullscreen();
      }
    } catch (_) {}
    updateFullscreenUiState();
  }

  async function toggleNativeFullscreen() {
    if (isFullscreenActive()) {
      try {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      } catch (_) {}
    } else {
      await enterFullscreenIfAllowed();
    }
    updateFullscreenUiState();
  }

  function updateFullscreenUiState() {
    const active = isFullscreenActive();
    if (els.iconFsEnter) els.iconFsEnter.classList.toggle("hidden", active);
    if (els.iconFsExit) els.iconFsExit.classList.toggle("hidden", !active);
    if (els.btnToggleFullscreenLabel) {
      els.btnToggleFullscreenLabel.textContent = active ? "Salir" : "Pantalla completa";
    }
    if (state.flowMode === "paginated") {
      setTimeout(() => updatePaginationLayout(true), 120);
    }
  }

  document.addEventListener("fullscreenchange", updateFullscreenUiState);
  document.addEventListener("webkitfullscreenchange", updateFullscreenUiState);

  function applyAppearance() {
    const isReaderOpen = els.readerView && !els.readerView.classList.contains("hidden");
    const isAudiobook = isReaderOpen && state.readerUiMode === "audiobook";
    const isPaginated = isReaderOpen && !isAudiobook && state.flowMode === "paginated";
    const showMiniPlayer = !isReaderOpen && Boolean(state.currentBook);

    document.body.classList.remove(
      "theme-light",
      "theme-sepia",
      "theme-dark",
      "font-serif",
      "font-sans",
      "cols-1",
      "cols-2",
      "mode-scroll",
      "mode-paginated"
    );
    document.body.classList.add(
      state.theme,
      state.fontFamily,
      `cols-${state.columns}`,
      isPaginated ? "mode-paginated" : "mode-scroll"
    );
    document.documentElement.style.setProperty("--reader-font-size", `${state.fontSize}px`);
    document.documentElement.style.setProperty("--reader-line-height", `${state.lineHeight.toFixed(2)}`);
    document.documentElement.style.setProperty(
      "--reader-max-width",
      MARGIN_WIDTHS[state.marginSize] || MARGIN_WIDTHS.normal
    );

    const alignVal = state.textAlign === "left" ? "left" : "justify";
    document.documentElement.style.setProperty("--reader-text-align", alignVal);
    document.documentElement.style.setProperty("--reader-hyphens", alignVal === "justify" ? "auto" : "none");

    const indentCfg = INDENT_VALUES[state.textIndent] || INDENT_VALUES.normal;
    document.documentElement.style.setProperty("--reader-text-indent", indentCfg.indent);
    document.documentElement.style.setProperty("--reader-para-spacing", indentCfg.spacing);

    els.fontSizeLabel.textContent = `${state.fontSize}px`;
    if (els.lineHeightLabel) {
      els.lineHeightLabel.textContent = state.lineHeight.toFixed(2);
    }
    els.chkAutoscroll.checked = state.autoScroll;
    if (els.chkAutoFullscreen) els.chkAutoFullscreen.checked = state.autoFullscreen;
    if (els.chkImmersiveReader) els.chkImmersiveReader.checked = state.immersiveReader;
    if (els.selectSentenceGap) els.selectSentenceGap.value = state.sentenceGapMode || "auto";
    updateCarModeUi();

    document.body.classList.toggle("reader-open", isReaderOpen);
    document.body.classList.toggle("mode-audiobook", isAudiobook);
    document.body.classList.toggle("has-mini-player", showMiniPlayer);
    if (els.ttsPlayerBar) {
      els.ttsPlayerBar.classList.toggle("hidden", !state.currentBook || isAudiobook);
    }
    if (els.miniPlayerBookBar) {
      els.miniPlayerBookBar.classList.toggle("hidden", !showMiniPlayer);
    }
    if (els.audiobookPlayerView) {
      els.audiobookPlayerView.classList.toggle("hidden", !isAudiobook);
    }

    const showImmersive = isReaderOpen && !isAudiobook && state.immersiveReader;
    document.body.classList.toggle("immersive-reader", showImmersive);
    if (els.btnExitImmersive) {
      els.btnExitImmersive.classList.toggle("hidden", !showImmersive);
    }

    if (els.btnToggleFlow) {
      els.btnToggleFlow.textContent =
        state.flowMode === "paginated" ? "📜 Scroll" : "📖 Paginado";
    }
    if (els.pageCounter) els.pageCounter.classList.toggle("hidden", !isPaginated);
    if (els.btnPagePrev) els.btnPagePrev.classList.toggle("hidden", !isPaginated);
    if (els.btnPageNext) els.btnPageNext.classList.toggle("hidden", !isPaginated);
    if (els.paginationFooter) els.paginationFooter.classList.toggle("hidden", !isPaginated);
    if (els.chapterNavFooter) els.chapterNavFooter.classList.toggle("hidden", isPaginated);

    document.querySelectorAll(".theme-chip").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.theme === state.theme);
    });
    const btnQuickTheme = document.getElementById("btn-quick-theme");
    if (btnQuickTheme) {
      if (state.theme === "theme-dark") {
        btnQuickTheme.textContent = "☀️ Claro";
        btnQuickTheme.title = "Tema actual: Noche (Pulsa para cambiar a Claro)";
      } else if (state.theme === "theme-light") {
        btnQuickTheme.textContent = "📜 Sepia";
        btnQuickTheme.title = "Tema actual: Claro (Pulsa para cambiar a Sepia)";
      } else {
        btnQuickTheme.textContent = "🌙 Noche";
        btnQuickTheme.title = "Tema actual: Sepia (Pulsa para cambiar a Noche)";
      }
    }
    document.querySelectorAll(".font-chip").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.font === state.fontFamily);
    });
    document.querySelectorAll(".flow-chip").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.flow === state.flowMode);
    });
    document.querySelectorAll(".col-chip").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.cols) === state.columns);
    });
    document.querySelectorAll(".align-chip").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.align === state.textAlign);
    });
    document.querySelectorAll(".indent-chip").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.indent === state.textIndent);
    });
    document.querySelectorAll(".margin-chip").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.margin === state.marginSize);
    });

    if (isReaderOpen && !isAudiobook) {
      requestAnimationFrame(() => updatePaginationLayout(true));
    }
    syncAudiobookAndMiniPlayerUi();
  }

  // Cargar catálogo de voces desde el servidor (con respaldo instantáneo en localStorage para uso sin conexión)
  async function fetchVoices() {
    try {
      const cached = JSON.parse(localStorage.getItem("vozlectura_cached_voices") || "[]");
      if (cached.length > 0 && state.voices.length === 0) {
        state.voices = cached;
        renderVoiceSelector(state.currentBook ? state.currentBook.language : null);
      }
    } catch (_) {}

    try {
      const res = await fetchWithTimeout("/api/voices", {}, 2600);
      if (!res.ok) throw new Error("Servidor sin respuesta");
      const data = await res.json();
      state.voices = data.voices || [];
      try {
        localStorage.setItem("vozlectura_cached_voices", JSON.stringify(state.voices));
      } catch (_) {}
      if (data.gpu && els.gpuStatusBadge) {
        if (data.gpu.cuda_available) {
          els.gpuStatusBadge.textContent = `⚡ GPU Activa: ${data.gpu.device_name} (${data.gpu.vram_gb} GB VRAM)`;
          els.gpuStatusBadge.style.color = "#16a34a";
          els.gpuStatusBadge.style.borderColor = "#16a34a";
        } else {
          els.gpuStatusBadge.textContent = `Modo CPU (${data.gpu.device_name})`;
        }
      }
      renderVoiceSelector(state.currentBook ? state.currentBook.language : null);
      renderModelsModal();
    } catch (err) {
      renderVoiceSelector(state.currentBook ? state.currentBook.language : null);
    }
  }

  function getEngineBadgeLabel(v) {
    if (v.engine === "kokoro") return "[Kokoro IA]";
    return "[Piper]";
  }

  function renderVoiceSelector(preferredLang = null) {
    const currentVal = state.selectedVoice;
    els.selectVoice.innerHTML = "";

    if (
      (state.currentBook && state.currentBook.has_imported_audiobook) ||
      currentVal === "audiobook:original"
    ) {
      const abGroup = document.createElement("optgroup");
      abGroup.label = "🎧 Audiolibro Original Sincronizado (MP3 / M4B)";
      const abOpt = document.createElement("option");
      abOpt.value = "audiobook:original";
      const abName =
        (state.currentBook && state.currentBook.imported_audiobook_name) ||
        "🎧 Audiolibro Original (Sincronizado)";
      abOpt.textContent = `${abName} (✓)`;
      abGroup.appendChild(abOpt);
      els.selectVoice.appendChild(abGroup);
    }

    const langPrefix = preferredLang ? preferredLang.slice(0, 2).toLowerCase() : null;

    const esVoices = state.voices.filter((v) => v.language.startsWith("es"));
    const enVoices = state.voices.filter((v) => v.language.startsWith("en"));

    const groups = [];
    if (langPrefix === "en") {
      groups.push(
        { label: "🇬🇧/🇺🇸 Voces en Inglés (Piper MIT & Kokoro Apache 2.0)", items: enVoices },
        { label: "🇪🇸 Voces en Español (Piper MIT & Kokoro Apache 2.0)", items: esVoices }
      );
    } else {
      groups.push(
        { label: "🇪🇸 Voces en Español (Piper MIT & Kokoro Apache 2.0)", items: esVoices },
        { label: "🇬🇧/🇺🇸 Voces en Inglés (Piper MIT & Kokoro Apache 2.0)", items: enVoices }
      );
    }

    for (const grp of groups) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = grp.label;
      for (const v of grp.items) {
        const opt = document.createElement("option");
        opt.value = v.id;
        const badge = getEngineBadgeLabel(v);
        const readyMark = v.downloaded ? "✓" : "↓";
        opt.textContent = `${badge} ${v.name} (${readyMark})`;
        optgroup.appendChild(opt);
      }
      els.selectVoice.appendChild(optgroup);
    }

    // Opción adicional de voz nativa del navegador (Web Speech API) para uso sin conexión
    const localGroup = document.createElement("optgroup");
    localGroup.label = "📱 Sintetizador Local del Dispositivo (Web Speech)";
    for (const item of [
      { id: "browser:es-ES", label: "[Local] Voz del sistema Español (es-ES)" },
      { id: "browser:en-GB", label: "[Local] Voz del sistema Inglés UK (en-GB)" },
      { id: "browser:en-US", label: "[Local] Voz del sistema Inglés US (en-US)" },
    ]) {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.label;
      localGroup.appendChild(opt);
    }
    els.selectVoice.appendChild(localGroup);

    if ([...els.selectVoice.options].some((o) => o.value === currentVal)) {
      els.selectVoice.value = currentVal;
    }
    if (els.abSelectVoice) {
      els.abSelectVoice.innerHTML = els.selectVoice.innerHTML;
      els.abSelectVoice.value = els.selectVoice.value;
    }
  }

  // ============================================================================
  // ACTUALIZACIONES DE MOTORES TTS, MODO AUDIOLIBRO, SLEEP TIMER Y MINI-PLAYER
  // ============================================================================
  function renderTtsUpdatesPanel() {
    const data = state.ttsUpdatesData;
    const updCount = Number((data && data.updates_count) || 0);
    if (els.ttsUpdatesBadge) {
      if (updCount > 0) {
        els.ttsUpdatesBadge.textContent = `↑${updCount}`;
        els.ttsUpdatesBadge.classList.remove("hidden");
        els.ttsUpdatesBadge.title = `Hay ${updCount} actualización(es) disponible(s) en motores TTS`;
      } else {
        els.ttsUpdatesBadge.classList.add("hidden");
      }
    }
    if (!els.ttsUpdatesPanel || !els.ttsUpdatesList || !els.ttsUpdatesSummary) return;

    if (!data || !Array.isArray(data.engines)) {
      els.ttsUpdatesPanel.classList.remove("has-updates");
      els.ttsUpdatesSummary.textContent = "Pulsa «Comprobar ahora» para verificar versiones en PyPI.";
      els.ttsUpdatesList.innerHTML = "";
      return;
    }

    els.ttsUpdatesPanel.classList.toggle("has-updates", updCount > 0);
    const checkedDateStr = data.checked_at
      ? new Date(data.checked_at * 1000).toLocaleString("es-ES", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    if (updCount > 0) {
      els.ttsUpdatesSummary.textContent = `🆕 Hay ${updCount} motor(es) TTS con nueva versión disponible (revisado ${checkedDateStr}).`;
    } else if (data.network_ok === false) {
      els.ttsUpdatesSummary.textContent = "Sin conexión a PyPI para comprobar actualizaciones ahora mismo.";
    } else {
      els.ttsUpdatesSummary.textContent = `✓ Todos los motores TTS están al día (revisado ${checkedDateStr}).`;
    }

    els.ttsUpdatesList.innerHTML = "";
    for (const eng of data.engines) {
      const card = document.createElement("div");
      card.className = `tts-update-card${eng.has_update ? " is-updatable" : ""}`;

      let pillClass = "muted";
      let pillText = "No instalado";
      if (eng.status === "update_available") {
        pillClass = "new";
        pillText = "Nueva versión";
      } else if (eng.status === "up_to_date") {
        pillClass = "ok";
        pillText = "Al día";
      } else if (eng.status === "error") {
        pillClass = "muted";
        pillText = "Sin comprobar";
      }

      const instStr = eng.installed_version ? `v${eng.installed_version}` : "—";
      const latStr = eng.latest_version ? `v${eng.latest_version}` : "—";
      const verLine = eng.has_update
        ? `<strong>${escapeHtml(instStr)} → ${escapeHtml(latStr)}</strong>`
        : `Instalada: <strong>${escapeHtml(instStr)}</strong>`;

      card.innerHTML = `
        <div class="tts-update-card-top">
          <strong>${escapeHtml(eng.name || eng.package)}</strong>
          <span class="tts-update-status-pill ${pillClass}">${pillText}</span>
        </div>
        <div class="tts-update-ver-row">
          <span>${verLine}</span>
          ${
            eng.release_url
              ? `<a href="${escapeHtml(eng.release_url)}" target="_blank" rel="noopener" class="tts-update-link">PyPI ↗</a>`
              : ""
          }
        </div>
      `;
      els.ttsUpdatesList.appendChild(card);
    }
  }

  async function checkTtsEngineUpdates({ force = false, notifyToast = false } = {}) {
    if (state.isServerOffline) return null;
    if (els.btnCheckTtsUpdates) {
      els.btnCheckTtsUpdates.disabled = true;
      els.btnCheckTtsUpdates.textContent = "Comprobando...";
    }
    try {
      const url = force ? "/api/tts/updates?force=true" : "/api/tts/updates";
      const res = await fetchWithTimeout(url, {}, force ? 12000 : 7500);
      if (!res.ok) return null;
      const data = await res.json();
      state.ttsUpdatesData = data;
      renderTtsUpdatesPanel();
      if (notifyToast && data.has_updates && !state.ttsUpdatesNotified) {
        state.ttsUpdatesNotified = true;
        const names = (data.engines || [])
          .filter((e) => e.has_update)
          .map((e) => `${e.name} (${e.latest_version})`)
          .join(", ");
        if (names) {
          showToast(`🆕 Actualización TTS disponible: ${names} — revisa en «Voces IA»`, 6500);
        }
      } else if (force) {
        if (data.has_updates) {
          showToast(`🆕 ${data.updates_count} actualización(es) de motor TTS disponible(s)`, 4500);
        } else if (data.network_ok) {
          showToast("✓ Todos los motores TTS están en su última versión");
        } else {
          showToast("⚠️ No se pudo conectar con PyPI para comprobar actualizaciones");
        }
      }
      return data;
    } catch (_) {
      return null;
    } finally {
      if (els.btnCheckTtsUpdates) {
        els.btnCheckTtsUpdates.disabled = false;
        els.btnCheckTtsUpdates.textContent = "Comprobar ahora";
      }
    }
  }

  let sleepTimerInterval = null;

  function formatSleepRemaining(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function updateSleepTimerUi() {
    let label = "";
    let active = false;
    if (state.sleepTimerMode === "chapter") {
      active = true;
      label = "Fin cap.";
    } else if (state.sleepTimerMode === "minutes" && state.sleepTimerEndMs > 0) {
      const rem = state.sleepTimerEndMs - Date.now();
      if (rem <= 0) {
        clearSleepTimer();
        if (state.isPlaying) {
          stopPlayback();
        }
        showToast("🌙 Temporizador de apagado finalizado — Reproducción detenida", 5000);
        return;
      }
      active = true;
      label = formatSleepRemaining(rem);
    }

    if (els.abSleepCountdown) {
      els.abSleepCountdown.textContent = active ? label : "";
      els.abSleepCountdown.classList.toggle("hidden", !active);
    }
    if (els.abSleepPill) {
      els.abSleepPill.classList.toggle("is-active", active);
    }
    if (els.abSleepLabel) {
      els.abSleepLabel.textContent = active ? `🌙 ${label}` : "🌙";
    }
    if (els.playerSleepBadge) {
      els.playerSleepBadge.textContent = active ? `🌙 ${label}` : "";
      els.playerSleepBadge.classList.toggle("hidden", !active);
    }
    if (els.abSelectSleepTimer && !active && els.abSelectSleepTimer.value !== "off") {
      els.abSelectSleepTimer.value = "off";
    }
  }

  function clearSleepTimer() {
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }
    state.sleepTimerMode = "off";
    state.sleepTimerEndMs = 0;
    if (els.abSelectSleepTimer) els.abSelectSleepTimer.value = "off";
    updateSleepTimerUi();
  }

  function setSleepTimer(value) {
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }
    const val = String(value || "off");
    if (val === "off") {
      state.sleepTimerMode = "off";
      state.sleepTimerEndMs = 0;
      showToast("🌙 Temporizador de apagado desactivado");
    } else if (val === "chapter") {
      state.sleepTimerMode = "chapter";
      state.sleepTimerEndMs = 0;
      showToast("🌙 La reproducción se detendrá al terminar este capítulo");
    } else {
      const mins = Math.max(1, Number(val) || 15);
      state.sleepTimerMode = "minutes";
      state.sleepTimerEndMs = Date.now() + mins * 60 * 1000;
      sleepTimerInterval = setInterval(updateSleepTimerUi, 1000);
      showToast(`🌙 Temporizador activado: apagado en ${mins} min`);
    }
    if (els.abSelectSleepTimer) els.abSelectSleepTimer.value = val;
    updateSleepTimerUi();
  }

  function formatEstimatedTimeLeft(sentencesRemaining) {
    const s = Math.max(0, Number(sentencesRemaining || 0));
    const speed = Math.max(0.5, Number(state.speed || 1.0));
    // Media aproximada de ~4.3s por frase a 1.0x
    const totalSec = Math.round((s * 4.3) / speed);
    if (totalSec < 60) return "< 1 min";
    const totalMin = Math.round(totalSec / 60);
    if (totalMin < 60) return `~${totalMin} min`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `~${h} h ${m} min` : `~${h} h`;
  }

  function syncAudiobookAndMiniPlayerUi() {
    const book = state.currentBook;
    const ch = state.currentChapter;
    const totalSents = ch ? Number(ch.sentence_count || 0) : 0;
    const curIdx = Number(state.sentenceIndex || 0);
    const coverSrc = book && book.cover_url ? resolveApiUrl(book.cover_url) : "";

    // 1. Mini-reproductor persistente (visible en Biblioteca cuando hay libro cargado)
    if (book) {
      if (els.miniPlayerTitle) els.miniPlayerTitle.textContent = book.title || "";
      if (els.miniPlayerChapter) {
        const chTitle = (ch && ch.title) || `Capítulo ${state.chapterIndex + 1}`;
        const stats = computeBookProgressStats(book, state.chapterIndex, curIdx);
        els.miniPlayerChapter.textContent = `${chTitle} • ${stats.percentStr}`;
      }
      if (els.miniPlayerCover && els.miniPlayerCoverFallback) {
        if (coverSrc) {
          if (els.miniPlayerCover.dataset.bookId !== book.id) {
            els.miniPlayerCover.dataset.bookId = book.id;
            els.miniPlayerCover.src = coverSrc;
            els.miniPlayerCover.onload = () => {
              els.miniPlayerCover.classList.remove("hidden");
              els.miniPlayerCoverFallback.classList.add("hidden");
            };
            els.miniPlayerCover.onerror = () => {
              els.miniPlayerCover.classList.add("hidden");
              els.miniPlayerCoverFallback.classList.remove("hidden");
            };
          }
        } else {
          els.miniPlayerCover.classList.add("hidden");
          els.miniPlayerCoverFallback.classList.remove("hidden");
        }
      }
    }

    // 2. Vista dedicada de Reproductor de Audiolibros
    if (!book) return;
    if (els.abBookTitle) els.abBookTitle.textContent = book.title || "";
    if (els.abBookAuthor) els.abBookAuthor.textContent = book.author || "";
    if (els.abChapterTitle) {
      const rawChTitle = ch && ch.title ? String(ch.title).trim() : "";
      els.abChapterTitle.textContent = rawChTitle
        ? /^\d+$/.test(rawChTitle)
          ? `Capítulo ${rawChTitle}`
          : rawChTitle
        : `Capítulo ${state.chapterIndex + 1} de ${book.chapter_count || 1}`;
    }
    if (els.abCoverWrap) {
      els.abCoverWrap.classList.toggle("is-playing", Boolean(state.isPlaying && !state.isLoadingAudio));
    }
    if (els.abCoverImg && els.abCoverFallback) {
      if (coverSrc) {
        if (els.abCoverImg.dataset.bookId !== book.id) {
          els.abCoverImg.dataset.bookId = book.id;
          els.abCoverImg.src = coverSrc;
          els.abCoverImg.onload = () => {
            els.abCoverImg.classList.remove("hidden");
            els.abCoverFallback.classList.add("hidden");
          };
          els.abCoverImg.onerror = () => {
            els.abCoverImg.classList.add("hidden");
            els.abCoverFallback.classList.remove("hidden");
          };
        }
      } else {
        els.abCoverImg.classList.add("hidden");
        els.abCoverFallback.classList.remove("hidden");
      }
    }

    if (els.abSubtitleBox) {
      els.abSubtitleBox.classList.toggle("hidden", !state.abShowSubtitle);
    }
    if (els.abBtnToggleSubtitle) {
      els.abBtnToggleSubtitle.classList.toggle("is-active", Boolean(state.abShowSubtitle));
    }
    if (els.abSubtitleText) {
      const sentText = getSentenceText(curIdx);
      els.abSubtitleText.textContent = sentText || "Pulsa Play para comenzar la narración.";
    }

    if (els.abChapterSlider) {
      const maxVal = Math.max(0, totalSents - 1);
      els.abChapterSlider.max = String(maxVal);
      if (document.activeElement !== els.abChapterSlider) {
        els.abChapterSlider.value = String(Math.min(curIdx, maxVal));
      }
    }

    const stats = computeBookProgressStats(book, state.chapterIndex, curIdx);
    const chRemSents = Math.max(0, totalSents - (curIdx + 1));
    const bookRemSents = Math.max(0, Number(stats.totalSentences || 0) - Number(stats.sentencesRead || 0));
    if (els.abChapterProgressMeta) {
      els.abChapterProgressMeta.textContent = `Quedan ${formatEstimatedTimeLeft(chRemSents)} cap.`;
    }
    if (els.abBookProgressMeta) {
      els.abBookProgressMeta.textContent = `${stats.percentStr} • ${formatEstimatedTimeLeft(bookRemSents)} libro`;
    }

    if (els.abIconPlay) els.abIconPlay.classList.toggle("hidden", state.isPlaying || state.isLoadingAudio);
    if (els.abIconPause) els.abIconPause.classList.toggle("hidden", !state.isPlaying || state.isLoadingAudio);
    if (els.abIconLoading) els.abIconLoading.classList.toggle("hidden", !state.isLoadingAudio);

    if (els.abStatusDot) {
      els.abStatusDot.classList.toggle("playing", state.isPlaying && !state.isLoadingAudio);
      els.abStatusDot.classList.toggle("loading", state.isLoadingAudio);
    }
    if (els.abStatusText && els.statusText) {
      els.abStatusText.textContent = els.statusText.textContent || "";
    }

    const speedNum = Number(state.speed || 1);
    if (els.abSelectSpeed && els.selectSpeed) {
      els.abSelectSpeed.value = els.selectSpeed.value;
    }
    if (els.abSpeedLabel) {
      els.abSpeedLabel.textContent = `${speedNum.toFixed(2).replace(/\.00$/, ".0").replace(/(\.\d)0$/, "$1")}×`;
    }
    if (els.abSpeedPill) {
      els.abSpeedPill.classList.toggle("is-active", Math.abs(speedNum - 1) > 0.01);
    }
    if (els.abSelectVoice && els.selectVoice) {
      if (els.abSelectVoice.options.length !== els.selectVoice.options.length) {
        els.abSelectVoice.innerHTML = els.selectVoice.innerHTML;
      }
      els.abSelectVoice.value = els.selectVoice.value;
      if (els.abVoiceLabel) {
        const selOpt = els.selectVoice.options[els.selectVoice.selectedIndex];
        const rawName = selOpt ? selOpt.textContent || "" : "";
        const cleanName = rawName
          .replace(/\[[^\]]*\]/g, "")
          .replace(/🎧/g, "")
          .replace(/\((?:✓|↓)\)/g, "")
          .replace(/\([^)]*\)/g, "")
          .replace(/\s+/g, " ")
          .trim();
        els.abVoiceLabel.textContent = `🎙️ ${cleanName || "Voz"}`;
      }
    }
    if (els.abBtnPrevChapter) {
      els.abBtnPrevChapter.disabled = state.chapterIndex <= 0;
    }
    if (els.abBtnNextChapter) {
      const hasPair = Boolean(book.pairing && book.pairing.paired_book_id && book.pairing.auto_switch_chapters);
      els.abBtnNextChapter.disabled = !hasPair && state.chapterIndex >= (book.chapter_count || 1) - 1;
    }
    if (els.abBtnSwitchPaired) {
      const freshBook = state.books.find((b) => b.id === book.id) || book;
      const pairObj =
        freshBook.pairing && freshBook.pairing.paired_book_id
          ? freshBook.pairing
          : book.pairing && book.pairing.paired_book_id
          ? book.pairing
          : null;
      if (pairObj) {
        const partnerIsEs = (pairObj.paired_book_lang || "").toLowerCase().startsWith("es");
        els.abBtnSwitchPaired.textContent = partnerIsEs ? "🇪🇸 ES" : "🇬🇧 EN";
        els.abBtnSwitchPaired.classList.remove("hidden");
      } else {
        els.abBtnSwitchPaired.classList.add("hidden");
      }
    }
  }

  function setReaderUiMode(mode) {
    const nextMode = mode === "audiobook" ? "audiobook" : "reading";
    state.readerUiMode = nextMode;
    saveAppearancePrefs();
    applyAppearance();
    if (nextMode === "reading" && state.currentChapter) {
      requestAnimationFrame(() => {
        highlightCurrentSentence(true);
      });
    }
  }

  async function jumpBySentences(delta) {
    if (!state.currentChapter || !state.currentBook) return;
    const total = Number(state.currentChapter.sentence_count || 0);
    const target = state.sentenceIndex + delta;
    if (target >= 0 && target < total) {
      jumpToSentence(target);
      return;
    }
    const wasPlaying = state.isPlaying;
    if (target < 0 && state.chapterIndex > 0) {
      stopPlayback();
      await loadChapter(state.chapterIndex - 1, -1, wasPlaying);
    } else if (target >= total && state.chapterIndex < (state.currentBook.chapter_count || 1) - 1) {
      stopPlayback();
      await loadChapter(state.chapterIndex + 1, 0, wasPlaying);
    } else {
      jumpToSentence(Math.min(Math.max(0, target), Math.max(0, total - 1)));
    }
  }

  function returnToActiveBookView(preferredMode = null) {
    if (!state.currentBook) return;
    if (preferredMode === "audiobook" || preferredMode === "reading") {
      state.readerUiMode = preferredMode;
      saveAppearancePrefs();
    }
    els.libraryView.classList.add("hidden");
    els.readerView.classList.remove("hidden");
    els.btnBackLibrary.classList.remove("hidden");
    els.btnToggleToc.classList.remove("hidden");
    if (els.btnTopbarAddBook) els.btnTopbarAddBook.classList.add("hidden");
    if (els.btnOpenStudy) els.btnOpenStudy.classList.remove("hidden");
    if (els.btnOpenExports) els.btnOpenExports.classList.remove("hidden");
    if (els.btnOpenPairing) els.btnOpenPairing.classList.remove("hidden");
    els.brandLogo.classList.add("hide-mobile");
    els.currentBookTitle.textContent = state.currentBook.title || "";
    els.currentBookTitle.title = state.currentBook.title || "";
    applyAppearance();
    if (state.readerUiMode !== "audiobook") {
      requestAnimationFrame(() => highlightCurrentSentence(true));
    }
  }

  async function closeMiniPlayerAndStop() {
    stopPlayback();
    clearSleepTimer();
    if (state.currentBook && state.currentChapter) {
      await saveReadingProgress({ immediate: true });
    }
    await flushActiveReadingSession();
    state.currentBook = null;
    state.currentChapter = null;
    els.currentBookTitle.textContent = "";
    els.currentBookTitle.title = "";
    applyAppearance();
  }

  function renderModelsModal() {
    els.modelsList.innerHTML = "";
    for (const v of state.voices) {
      const row = document.createElement("div");
      row.className = "model-row";

      const engineClass = `engine-${v.engine}`;
      const langFlag = v.language.startsWith("es") ? "🇪🇸 es-ES" : `🇬🇧/🇺🇸 ${v.language}`;

      let actionHtml = "";
      if (v.downloaded) {
        actionHtml = `
          <div style="display:flex;gap:6px;align-items:center">
            <span class="badge-pill" style="color:#16a34a;border-color:#16a34a">✓ Lista</span>
            <button class="delete-book-btn btn-del-downloaded-voice" data-voice="${v.id}" data-name="${escapeHtml(v.name)}" title="Borrar archivos descargados de este modelo" style="padding:5px 9px;font-size:0.78rem">🗑 Borrar</button>
          </div>
        `;
      } else {
        actionHtml = `<button class="primary-btn btn-dl-voice" data-voice="${v.id}" style="padding:7px 14px;font-size:0.82rem">Descargar modelo</button>`;
      }

      row.innerHTML = `
        <div class="model-info">
          <h4>
            <span class="engine-badge ${engineClass}">${v.engine}</span>
            ${escapeHtml(v.name)} <small style="color:var(--text-secondary)">(${langFlag})</small>
          </h4>
          <p>${escapeHtml(v.description)}</p>
        </div>
        <div>${actionHtml}</div>
      `;
      els.modelsList.appendChild(row);
    }

    els.modelsList.querySelectorAll(".btn-dl-voice").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = btn.dataset.voice;
        btn.disabled = true;
        btn.textContent = "Descargando...";
        try {
          const res = await fetch("/api/voices/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ voice_id: vid }),
          });
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Fallo en la descarga");
          }
          showToast("Modelo descargado y listo en el servidor");
          await fetchVoices();
        } catch (err) {
          showToast(`Error: ${err.message}`);
          btn.disabled = false;
          btn.textContent = "Reintentar";
        }
      });
    });

    els.modelsList.querySelectorAll(".btn-del-downloaded-voice").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = btn.dataset.voice;
        const vname = btn.dataset.name || vid;
        if (!confirm(`¿Borrar del disco los archivos descargados de "${vname}"?\n(Podrás volver a descargarla cuando quieras)`)) return;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/voices/downloaded/${encodeURIComponent(vid)}`, {
            method: "DELETE",
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.detail || "No se pudo borrar el modelo");
          }
          showToast(`Archivos borrados (${data.freed_mb || 0} MB liberados)`);
          await fetchVoices();
        } catch (err) {
          showToast(`Error: ${err.message}`);
          btn.disabled = false;
        }
      });
    });
  }

  async function refreshOfflineMap() {
    const records = await OfflineStore.listBooks();
    state.offlineBooksMap.clear();
    for (const r of records) {
      state.offlineBooksMap.set(r.id, r);
    }
    updateOfflineHeaderBadge();
  }

  function updateOfflineHeaderBadge() {
    const count = state.offlineBooksMap.size;
    if (els.btnOpenOfflineLabel) {
      els.btnOpenOfflineLabel.textContent = state.isServerOffline ? "📴 Sin conexión" : "Offline";
    }
    if (els.offlineStatusBadge) {
      if (state.isServerOffline) {
        els.offlineStatusBadge.textContent = count > 0 ? `📴${count}` : "📴";
        els.offlineStatusBadge.classList.remove("hidden", "active-running");
      } else if (count > 0) {
        els.offlineStatusBadge.textContent = String(count);
        els.offlineStatusBadge.classList.add("active-running");
        els.offlineStatusBadge.classList.remove("hidden");
      } else {
        els.offlineStatusBadge.classList.add("hidden");
      }
    }
    if (els.offlineConnectionBanner) {
      els.offlineConnectionBanner.classList.toggle("hidden", !state.isServerOffline);
    }
    if (els.serverConnBadge) {
      if (state.isServerOffline) {
        els.serverConnBadge.textContent = "📴 Sin conexión al servidor";
        els.serverConnBadge.style.color = "#f59e0b";
        els.serverConnBadge.style.borderColor = "#f59e0b";
      } else {
        els.serverConnBadge.textContent = `✓ Conectado (${state.serverUrl.replace(/^https?:\/\//, "")})`;
        els.serverConnBadge.style.color = "#16a34a";
        els.serverConnBadge.style.borderColor = "#16a34a";
      }
    }
    updateSwStatusUi();
  }

  let selectedBrowserGuide = "brave";
  let browserGuideDetectedOnce = false;

  const BROWSER_OFFLINE_GUIDES = {
    brave: {
      name: "Brave",
      flagUrl: "brave://flags/#unsafely-treat-insecure-origin-as-secure",
      copyBtnLabel: "📋 2. Copiar enlace brave://flags",
      copyToastMsg:
        "📋 Copiado brave://flags/... Pégalo en la barra superior de Brave, añade la IP de la app y pulsa Enabled → Relaunch",
      renderHtml: (origin) => `
        <strong>🦁 En Brave (Android y PC) — Solo una vez (15 segundos):</strong><br/>
        1️⃣ Pulsa <strong>«📋 1. Copiar dirección de esta App»</strong> abajo (<code>${escapeHtml(origin)}</code>).<br/>
        2️⃣ Pulsa <strong>«📋 2. Copiar enlace brave://flags»</strong>, pégalo en la barra de direcciones superior de <strong>Brave</strong> y entra.<br/>
        3️⃣ En el ajuste resaltado <em>«Insecure origins treated as secure»</em>, pega la dirección de la App, cambia el desplegable de <em>Disabled</em> a <strong>Enabled</strong> y pulsa <strong>Relaunch</strong> abajo.<br/>
        4️⃣ <strong>Escudos de Brave (🦁):</strong> No actives «Borrar datos al salir» para esta IP y, si deseas instalarla como App en tu pantalla de inicio de Android, abre el menú <code>⋮</code> de Brave → <strong>«Instalar aplicación»</strong> (o <em>Añadir a pantalla de inicio</em>).<br/>
        <small style="color:var(--text-secondary)">💡 <em>Truco si cambiaste de IP:</em> Puedes poner varias IPs separadas por coma (ej. <code>http://192.168.1.50:8085,http://192.168.1.60:8085</code>).</small>
      `,
    },
    chrome: {
      name: "Google Chrome",
      flagUrl: "chrome://flags/#unsafely-treat-insecure-origin-as-secure",
      copyBtnLabel: "📋 2. Copiar enlace chrome://flags",
      copyToastMsg:
        "📋 Copiado chrome://flags/... Pégalo en la barra superior de Chrome, añade la IP de la app y pulsa Enabled → Relaunch",
      renderHtml: (origin) => `
        <strong>🌐 En Google Chrome (Android y PC) — Solo una vez (15 segundos):</strong><br/>
        1️⃣ Pulsa <strong>«📋 1. Copiar dirección de esta App»</strong> abajo (<code>${escapeHtml(origin)}</code>).<br/>
        2️⃣ Pulsa <strong>«📋 2. Copiar enlace chrome://flags»</strong>, pégalo en la barra de direcciones de <strong>Chrome</strong> y entra.<br/>
        3️⃣ En el cuadro resaltado <em>«Insecure origins treated as secure»</em>, pega la dirección de la App, cámbialo a <strong>Enabled</strong> y pulsa <strong>Relaunch</strong>.<br/>
        4️⃣ Al reiniciar, abre el menú <code>⋮</code> de Chrome → <strong>«Instalar aplicación»</strong> para tenerla como App nativa en Android.
      `,
    },
    edge: {
      name: "Microsoft Edge",
      flagUrl: "edge://flags/#unsafely-treat-insecure-origin-as-secure",
      copyBtnLabel: "📋 2. Copiar enlace edge://flags",
      copyToastMsg:
        "📋 Copiado edge://flags/... Pégalo en la barra superior de Edge, añade la IP de la app y pulsa Enabled → Reiniciar",
      renderHtml: (origin) => `
        <strong>🌊 En Microsoft Edge (Android y PC) — Solo una vez:</strong><br/>
        1️⃣ Pulsa <strong>«📋 1. Copiar dirección de esta App»</strong> abajo (<code>${escapeHtml(origin)}</code>).<br/>
        2️⃣ Pulsa <strong>«📋 2. Copiar enlace edge://flags»</strong>, pégalo en la barra superior de <strong>Edge</strong> y entra.<br/>
        3️⃣ En <em>«Insecure origins treated as secure»</em>, pega la dirección de la App, selecciona <strong>Enabled</strong> y pulsa <strong>Reiniciar / Relaunch</strong>.
      `,
    },
    firefox: {
      name: "Mozilla Firefox",
      flagUrl: "dom.serviceWorkers.testing.enabled",
      copyBtnLabel: "📋 2. Copiar ajuste dom.serviceWorkers...",
      copyToastMsg:
        "📋 Ajuste copiado. Abre about:config en Firefox, pega dom.serviceWorkers.testing.enabled y ponlo en true",
      renderHtml: (origin) => `
        <strong>🦊 En Firefox (PC y Firefox Android / Nightly / Fennec):</strong><br/>
        1️⃣ Escribe <code>about:config</code> en la barra de direcciones de Firefox y entra.<br/>
        2️⃣ Pulsa <strong>«📋 2. Copiar ajuste dom.serviceWorkers...»</strong> abajo y pégalo en el buscador de <code>about:config</code>.<br/>
        3️⃣ Pulsa sobre <code>dom.serviceWorkers.testing.enabled</code> para cambiarlo a <strong><code>true</code></strong> y recarga esta página (<code>${escapeHtml(origin)}</code>).<br/>
        <small style="color:var(--text-secondary)">Nota: En Firefox estándar de Android, si <code>about:config</code> está restringido, escribe <code>chrome://geckoview/content/config.xhtml</code> en la barra de direcciones para abrirlo.</small>
      `,
    },
    other: {
      name: "Vivaldi / Opera / Samsung",
      flagUrl: "vivaldi://flags/#unsafely-treat-insecure-origin-as-secure",
      copyBtnLabel: "📋 2. Copiar enlace #unsafely-treat-insecure...",
      copyToastMsg:
        "📋 Enlace copiado. Pégalo en la barra de tu navegador (cambiando el prefijo a opera://flags o vivaldi://flags si es necesario)",
      renderHtml: (origin) => `
        <strong>🧭 En Vivaldi, Opera, Kiwi Browser o Samsung Internet:</strong><br/>
        • <strong>Vivaldi:</strong> Entra en <code>vivaldi://flags/#unsafely-treat-insecure-origin-as-secure</code>, pega <code>${escapeHtml(origin)}</code> → <strong>Enabled</strong>.<br/>
        • <strong>Opera:</strong> Entra en <code>opera://flags/#unsafely-treat-insecure-origin-as-secure</code>, pega <code>${escapeHtml(origin)}</code> → <strong>Enabled</strong>.<br/>
        • <strong>Samsung Internet:</strong> Entra en <code>internet://flags</code> o usa la opción <strong>«💾 Archivo .vozbook»</strong> arriba para guardar tus libros directamente en la carpeta Descargas del teléfono.
      `,
    },
  };

  async function detectBrowserGuideDefault() {
    if (browserGuideDetectedOnce) return;
    browserGuideDetectedOnce = true;
    try {
      if (navigator.brave && typeof navigator.brave.isBrave === "function") {
        const isBrave = await navigator.brave.isBrave();
        if (isBrave) {
          selectedBrowserGuide = "brave";
          renderBrowserGuideUi();
          return;
        }
      }
    } catch (_) {}
    const ua = navigator.userAgent || "";
    if (/Brave/i.test(ua)) {
      selectedBrowserGuide = "brave";
    } else if (/Firefox|FxiOS/i.test(ua)) {
      selectedBrowserGuide = "firefox";
    } else if (/EdgA?|EdgiOS/i.test(ua)) {
      selectedBrowserGuide = "edge";
    } else if (/Vivaldi|OPR|Opera|SamsungBrowser/i.test(ua)) {
      selectedBrowserGuide = "other";
    } else {
      selectedBrowserGuide = "brave";
    }
    renderBrowserGuideUi();
  }

  function renderBrowserGuideUi() {
    const guide = BROWSER_OFFLINE_GUIDES[selectedBrowserGuide] || BROWSER_OFFLINE_GUIDES.brave;
    const contentEl = document.getElementById("browser-guide-content");
    if (contentEl) {
      contentEl.innerHTML = guide.renderHtml(window.location.origin);
    }
    if (els.btnCopyChromeFlag) {
      els.btnCopyChromeFlag.textContent = guide.copyBtnLabel;
    }
    document.querySelectorAll(".browser-guide-tab").forEach((btn) => {
      const isAct = btn.dataset.browser === selectedBrowserGuide;
      btn.classList.toggle("active", isAct);
      btn.style.borderColor = isAct ? "var(--accent)" : "";
      btn.style.fontWeight = isAct ? "700" : "";
    });
  }

  function updateSwStatusUi() {
    const isSecure = Boolean(window.isSecureContext);
    const hasSwApi = "serviceWorker" in navigator;
    const isSwReady = Boolean(state.swActive || (hasSwApi && navigator.serviceWorker.controller));

    if (els.swStatusBadge) {
      if (isSwReady || (isSecure && hasSwApi)) {
        els.swStatusBadge.textContent = "✓ Modo App Offline Activo";
        els.swStatusBadge.style.color = "#16a34a";
        els.swStatusBadge.style.borderColor = "#16a34a";
      } else {
        els.swStatusBadge.textContent = "⚙️ Ver cómo activar por navegador";
        els.swStatusBadge.style.color = "#f59e0b";
        els.swStatusBadge.style.borderColor = "#f59e0b";
      }
    }
    if (els.btnInstallPwaApp) {
      els.btnInstallPwaApp.classList.toggle("hidden", !state.deferredInstallPrompt);
    }
    detectBrowserGuideDefault();
    renderBrowserGuideUi();
  }

  // Cargar lista de libros de la biblioteca (Instantáneo desde IndexedDB local + actualización desde el servidor con timeout corto)
  async function fetchLibrary() {
    await refreshOfflineMap();

    // 1. Mostrar inmediatamente (0 ms) los libros descargados en este dispositivo sin esperar a la red
    if (state.offlineBooksMap.size > 0 && state.books.length === 0) {
      state.books = [...state.offlineBooksMap.values()].map((r) => r.book);
      renderLibrary();
    }

    try {
      let res = await fetchWithTimeout("/api/books", {}, 8000).catch(() => null);
      if (!res || !res.ok) {
        // Si la primera petición falló o tardó, reintentar con el origen actual de la web y las IPs conocidas
        const fallbacks = [
          ...new Set([
            window.location.origin.replace(/\/+$/, ""),
            state.serverUrl,
            DEFAULT_STATIC_SERVER_URL,
            `http://localhost:${ACTIVE_PORT}`,
            `http://127.0.0.1:${ACTIVE_PORT}`,
          ]),
        ];
        for (const fb of fallbacks) {
          if (fb) {
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 5000);
              const fbRes = await nativeFetch(`${fb}/api/books`, { signal: controller.signal }).finally(() =>
                clearTimeout(timer)
              );
              if (fbRes && fbRes.ok) {
                state.serverUrl = fb;
                localStorage.setItem("vozlectura_server_url", fb);
                res = fbRes;
                break;
              }
            } catch (_) {}
          }
        }
      }
      if (!res || !res.ok) throw new Error("Servidor no disponible");
      const data = await res.json();
      state.isServerOffline = false;
      const srvBooks = data.books || [];
      const srvIds = new Set(srvBooks.map((b) => b.id));

      // Si algún libro se leyó sin conexión y tiene progreso pendiente (dirty_offline), sincronizarlo al servidor;
      // en caso contrario, actualizar la copia local IndexedDB con el emparejamiento (chapter_map) y progreso del servidor.
      for (const b of srvBooks) {
        const localRec = state.offlineBooksMap.get(b.id);
        if (localRec && localRec.book) {
          const localProg = localRec.book.progress || {};
          const srvProg = b.progress || {};
          const localUpd = Number(localProg.updated_at || 0);
          const srvUpd = Number(srvProg.updated_at || 0);
          const mergedPositions = {
            ...(srvProg.chapter_positions || {}),
            ...(localProg.chapter_positions || {}),
          };
          if (localProg.dirty_offline && localUpd > srvUpd) {
            b.progress = {
              ...srvProg,
              ...localProg,
              chapter_positions: mergedPositions,
            };
            b.last_read_at = Math.max(Number(b.last_read_at || 0), localUpd);
            b.updated_at = b.last_read_at;
            fetch(`/api/books/${b.id}/progress`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chapter_index: b.progress.chapter_index || 0,
                sentence_index: b.progress.sentence_index || 0,
                voice_id: b.progress.voice_id,
                speed: b.progress.speed,
                chapter_positions: mergedPositions,
              }),
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((resData) => {
                if (resData && resData.progress) {
                  b.progress = resData.progress;
                }
                OfflineStore.syncServerBookMeta(b);
              })
              .catch(() => {});
          } else {
            if (b.progress) {
              b.progress.chapter_positions = {
                ...(localProg.chapter_positions || {}),
                ...(srvProg.chapter_positions || {}),
                ...(srvProg.chapter_index !== undefined
                  ? { [String(srvProg.chapter_index)]: Math.max(0, Number(srvProg.sentence_index || 0)) }
                  : {}),
              };
            }
            OfflineStore.syncServerBookMeta(b);
          }
        }
      }

      // Sincronizar en segundo plano todas las sesiones de lectura acumuladas mientras se leía en modo Offline
      syncPendingOfflineSessions().catch(() => {});

      // Conservar también en la lista cualquier libro que exista en la memoria local del teléfono aunque no esté en el servidor
      for (const [localId, localRec] of state.offlineBooksMap.entries()) {
        if (!srvIds.has(localId) && localRec && localRec.book) {
          srvBooks.unshift(localRec.book);
        }
      }

      state.books = srvBooks;
      const activeIds = new Set(srvBooks.map((b) => b.id));
      state.archivedBooks = (Array.isArray(data.archived_books) ? data.archived_books : [])
        .filter((b) => b && !activeIds.has(b.id))
        .map((b) => ({ ...b, is_archived: true }));
      try {
        localStorage.setItem("vozlectura_catalog_cache", JSON.stringify(srvBooks));
        localStorage.setItem("vozlectura_archived_cache", JSON.stringify(state.archivedBooks));
      } catch (_) {}
      updateOfflineHeaderBadge();
      renderLibrary();
    } catch (err) {
      const isTrulyOffline = await markServerPotentiallyOffline();
      let offlineBooks = [...state.offlineBooksMap.values()].map((r) => r.book);
      try {
        const cachedCatalog = JSON.parse(localStorage.getItem("vozlectura_catalog_cache") || "[]");
        if (Array.isArray(cachedCatalog) && cachedCatalog.length > 0) {
          const catMap = new Map(cachedCatalog.map((b) => [b.id, b]));
          offlineBooks = offlineBooks.map((ob) => {
            const cat = catMap.get(ob.id);
            return cat ? { ...cat, ...ob, genre: ob.genre || cat.genre, genres: ob.genres || cat.genres, rating: ob.rating ?? cat.rating, reading_status: ob.reading_status || cat.reading_status, estimated_pages: ob.estimated_pages || cat.estimated_pages, published_date: ob.published_date || cat.published_date, published_year: ob.published_year || cat.published_year } : ob;
          });
          if (!isTrulyOffline && offlineBooks.length === 0) {
            offlineBooks = cachedCatalog;
          }
        }
      } catch (_) {}
      try {
        const cachedArchived = JSON.parse(localStorage.getItem("vozlectura_archived_cache") || "[]");
        if (Array.isArray(cachedArchived)) {
          const activeOffIds = new Set(offlineBooks.map((b) => b.id));
          state.archivedBooks = cachedArchived
            .filter((b) => b && !activeOffIds.has(b.id))
            .map((b) => ({ ...b, is_archived: true }));
        }
      } catch (_) {}
      state.books = offlineBooks;
      updateOfflineHeaderBadge();
      renderLibrary();
      if (isTrulyOffline) {
        if (state.books.length > 0) {
          showToast("📴 Modo Sin Conexión activo: mostrando tus libros guardados en este dispositivo", 4500);
        } else {
          showToast("📴 Sin conexión al servidor (pulsa «Buscar nueva IP del servidor» si cambió de IP)", 5000);
        }
      }
    }
  }

  // Calcula el porcentaje exacto leído del libro hasta la fecha según el capítulo y frase actual
  function computeBookProgressStats(bookObj, overrideChIdx = null, overrideSentIdx = null) {
    if (!bookObj) {
      return { percent: 0, percentStr: "0%", sentencesRead: 0, totalSentences: 1, isCompleted: false };
    }

    const analyticsMatch =
      analyticsDataCache && Array.isArray(analyticsDataCache.books)
        ? analyticsDataCache.books.find((x) => x.book_id === bookObj.id)
        : null;
    const isMarkedCompleted =
      bookObj.reading_status === "completed" ||
      (state.currentBook &&
        state.currentBook.id === bookObj.id &&
        state.currentStudy &&
        state.currentStudy.reading_status === "completed") ||
      (analyticsMatch && analyticsMatch.reading_status === "completed");
    if (isMarkedCompleted) {
      const tot = Math.max(1, Number(bookObj.total_sentences) || 1);
      return {
        percent: 100,
        percentStr: "100%",
        sentencesRead: tot,
        totalSentences: tot,
        isCompleted: true,
      };
    }

    const prog = bookObj.progress || { chapter_index: 0, sentence_index: 0 };
    const chIdx = Math.max(0, Number(overrideChIdx !== null ? overrideChIdx : prog.chapter_index || 0));
    const sentIdx = Math.max(0, Number(overrideSentIdx !== null ? overrideSentIdx : prog.sentence_index || 0));

    let totalSentences = Number(bookObj.total_sentences || 0);
    let sentencesBeforeChapter = 0;

    if (Array.isArray(bookObj.chapters) && bookObj.chapters.length > 0) {
      let sumAll = 0;
      for (const ch of bookObj.chapters) {
        const sc = Number(ch.sentence_count || 0);
        sumAll += sc;
        if (Number(ch.index) < chIdx) {
          sentencesBeforeChapter += sc;
        }
      }
      if (totalSentences <= 0) totalSentences = sumAll;
    } else {
      const chCount = Math.max(1, Number(bookObj.chapter_count || 1));
      if (totalSentences <= 0) totalSentences = chCount * 100;
      sentencesBeforeChapter = Math.round((chIdx / chCount) * totalSentences);
    }

    totalSentences = Math.max(1, totalSentences);
    const hasStarted = chIdx > 0 || sentIdx > 0;
    const sentencesRead = hasStarted
      ? Math.min(totalSentences, sentencesBeforeChapter + sentIdx + 1)
      : 0;
    const rawPct = (sentencesRead / totalSentences) * 100;
    const boundedPct = hasStarted ? Math.min(100, Math.max(0.1, rawPct)) : 0;
    const roundedIntPct =
      boundedPct === 0
        ? 0
        : boundedPct >= 99.95
        ? 100
        : Math.min(99, Math.max(1, Math.round(boundedPct)));
    const formatted = `${roundedIntPct}%`;

    return {
      percent: boundedPct,
      percentStr: formatted,
      sentencesRead,
      totalSentences,
      isCompleted: boundedPct >= 99.95,
    };
  }

  const READING_STATUS_META = {
    reading: { label: "📖 Leyendo", cls: "status-reading" },
    completed: { label: "✅ Terminado", cls: "status-completed" },
    wishlist: { label: "🔖 Pendiente", cls: "status-wishlist" },
    paused: { label: "⏸ En pausa", cls: "status-paused" },
  };

  function getBookEffectiveStatus(book) {
    if (book.reading_status) return book.reading_status;
    const progStats = computeBookProgressStats(book);
    if (progStats.isCompleted) return "completed";
    const prog = book.progress || { chapter_index: 0, sentence_index: 0 };
    if ((prog.chapter_index || 0) > 0 || (prog.sentence_index || 0) > 0) return "reading";
    return "reading";
  }

  function normalizeHalfStarRating(val) {
    const num = Number(val || 0);
    if (Number.isNaN(num) || num <= 0) return 0;
    return Math.round(Math.max(0, Math.min(5, num)) * 2) / 2;
  }

  function formatRatingValueEs(val) {
    const r = normalizeHalfStarRating(val);
    if (r <= 0) return "0";
    return Number.isInteger(r) ? String(r) : r.toFixed(1).replace(".", ",");
  }

  function formatStarsText(val) {
    const r = normalizeHalfStarRating(val);
    if (r <= 0) return "☆☆☆☆☆ (0/5)";
    const full = Math.floor(r);
    const hasHalf = r - full >= 0.49;
    const empty = Math.max(0, 5 - full - (hasHalf ? 1 : 0));
    return `${"★".repeat(full)}${hasHalf ? "½" : ""}${"☆".repeat(empty)} (${formatRatingValueEs(r)}/5)`;
  }

  function formatStarsEmoji(val) {
    const r = normalizeHalfStarRating(val);
    if (r <= 0) return "Sin valorar";
    const full = Math.floor(r);
    const hasHalf = r - full >= 0.49;
    return `${"⭐".repeat(full)}${hasHalf ? "½" : ""} (${formatRatingValueEs(r)}/5)`;
  }

  function computeNextStarRatingFromClick(currentRating, starIndex, clickEvent = null) {
    const cur = normalizeHalfStarRating(currentRating);
    const s = Number(starIndex || 1);
    const halfVal = Math.max(0.5, s - 0.5);

    // Si ya tiene exactamente S estrellas completas, un segundo toque baja media estrella (S - 0.5)
    if (cur === s) {
      return halfVal;
    }
    // Si ya tiene S - 0.5 estrellas, un toque adicional en la misma estrella quita la nota (0)
    if (cur === halfVal) {
      return 0;
    }
    // En escritorio con ratón: si pulsa claramente en la mitad izquierda de la estrella, asigna directamente media estrella (S - 0.5)
    if (clickEvent && clickEvent.currentTarget && typeof clickEvent.clientX === "number" && clickEvent.clientX > 0) {
      const rect = clickEvent.currentTarget.getBoundingClientRect();
      if (rect && rect.width > 12) {
        const relX = clickEvent.clientX - rect.left;
        if (relX >= 0 && relX < rect.width * 0.42) {
          return halfVal;
        }
      }
    }
    return s;
  }

  function getBookEffectiveRating(book) {
    return normalizeHalfStarRating(book && book.rating);
  }

  function getBookEffectivePages(book) {
    if (Number(book.estimated_pages) > 0) return Number(book.estimated_pages);
    const sents = Number(book.total_sentences || 0);
    return Math.max(1, Math.round((sents * 17) / 250));
  }

  function getBookEffectiveGenre(book) {
    if (book.genre && String(book.genre).trim()) return String(book.genre).trim();
    if (Array.isArray(book.genres) && book.genres.length > 0 && book.genres[0]) {
      return String(book.genres[0]).trim();
    }
    return "";
  }

  function formatShortDateEs(tsOrStr) {
    if (!tsOrStr) return "";
    if (typeof tsOrStr === "number" && tsOrStr > 100000) {
      const d = new Date(tsOrStr * 1000);
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yyyy = d.getFullYear();
      return `${dd}/${mm}/${yyyy}`;
    }
    const s = String(tsOrStr).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return s;
  }

  function getBookLastReadTimestamp(book) {
    if (!book) return 0;
    const prog = book.progress || {};
    const progUpd = Number(prog.last_read_at || prog.updated_at || 0);
    const explicitLastRead = Number(book.last_read_at || 0);
    const hasProgress =
      Number(prog.chapter_index || 0) > 0 ||
      Number(prog.sentence_index || 0) > 0;
    if (explicitLastRead > 0 || hasProgress) {
      return Math.max(explicitLastRead, hasProgress ? progUpd : 0);
    }
    if (book.reading_status === "completed") {
      return Math.max(Number(book.finished_at || 0), progUpd);
    }
    return 0;
  }

  function formatElapsedSinceLastRead(lastReadTs) {
    const ts = Number(lastReadTs || 0);
    if (!ts || ts <= 100000) return "Sin lectura reciente";
    const nowSec = Math.floor(Date.now() / 1000);
    const diffSec = Math.max(0, nowSec - ts);
    if (diffSec < 60) return "Hace un momento";
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `Hace ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Hace ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "Ayer";
    if (days < 30) return `Hace ${days} días`;
    const months = Math.floor(days / 30);
    if (months < 12) return `Hace ${months} ${months === 1 ? "mes" : "meses"}`;
    return formatShortDateEs(ts);
  }

  function populateLibraryFilterDropdowns() {
    const allCatalogBooks = [...state.books, ...(state.archivedBooks || [])];
    if (els.libFilterAuthor) {
      const prevAuthor = state.libFilterAuthor || "all";
      const authorCounts = new Map();
      for (const b of allCatalogBooks) {
        const a = String(b.author || "Autor desconocido").trim() || "Autor desconocido";
        authorCounts.set(a, (authorCounts.get(a) || 0) + 1);
      }
      const sortedAuthors = [...authorCounts.entries()].sort((a, b) =>
        a[0].localeCompare(b[0], "es", { sensitivity: "base" })
      );
      els.libFilterAuthor.innerHTML = `<option value="all">Todos los autores (${sortedAuthors.length})</option>`;
      for (const [authorName, count] of sortedAuthors) {
        const opt = document.createElement("option");
        opt.value = authorName;
        opt.textContent = `${authorName} (${count})`;
        els.libFilterAuthor.appendChild(opt);
      }
      if ([...authorCounts.keys()].includes(prevAuthor)) {
        els.libFilterAuthor.value = prevAuthor;
      } else {
        state.libFilterAuthor = "all";
        els.libFilterAuthor.value = "all";
      }
    }

    if (els.libFilterGenre) {
      const prevGenre = state.libFilterGenre || "all";
      const genreCounts = new Map();
      let unassignedCount = 0;
      for (const b of allCatalogBooks) {
        const gList =
          Array.isArray(b.genres) && b.genres.length > 0
            ? b.genres
            : b.genre
            ? [b.genre]
            : [];
        if (gList.length === 0) {
          unassignedCount++;
        } else {
          const seen = new Set();
          for (const rawG of gList) {
            const g = String(rawG || "").trim();
            if (!g || seen.has(g)) continue;
            seen.add(g);
            genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
          }
        }
      }
      const sortedGenres = [...genreCounts.entries()].sort((a, b) =>
        a[0].localeCompare(b[0], "es", { sensitivity: "base" })
      );
      els.libFilterGenre.innerHTML = `<option value="all">Todos los géneros</option>`;
      for (const [genreName, count] of sortedGenres) {
        const opt = document.createElement("option");
        opt.value = genreName;
        opt.textContent = `${genreName} (${count})`;
        els.libFilterGenre.appendChild(opt);
      }
      if (unassignedCount > 0) {
        const optUn = document.createElement("option");
        optUn.value = "__unassigned__";
        optUn.textContent = `Sin género asignado (${unassignedCount})`;
        els.libFilterGenre.appendChild(optUn);
      }
      if (
        prevGenre === "__unassigned__" ||
        [...genreCounts.keys()].includes(prevGenre)
      ) {
        els.libFilterGenre.value = prevGenre;
      } else {
        state.libFilterGenre = "all";
        els.libFilterGenre.value = "all";
      }
    }
  }

  function hasActiveLibraryFilters() {
    return Boolean(
      (state.libFilterSearch && state.libFilterSearch.trim()) ||
        state.libFilterAuthor !== "all" ||
        state.libFilterGenre !== "all" ||
        state.libFilterStatus !== "all" ||
        state.libFilterRating !== "all"
    );
  }

  function getFilteredAndSortedLibraryBooks() {
    const q = (state.libFilterSearch || "").trim().toLowerCase();
    const fAuthor = state.libFilterAuthor || "all";
    const fGenre = state.libFilterGenre || "all";
    const fStatus = state.libFilterStatus || "all";
    const fRating = state.libFilterRating || "all";

    const sourceBooks =
      fStatus === "archived"
        ? state.archivedBooks || []
        : hasActiveLibraryFilters()
        ? [...state.books, ...(state.archivedBooks || [])]
        : state.books;

    const filtered = sourceBooks.filter((book) => {
      const titleStr = String(book.title || "").toLowerCase();
      const authorStr = String(book.author || "Autor desconocido").trim();
      const genreStr = getBookEffectiveGenre(book);
      const allGenres = Array.isArray(book.genres)
        ? book.genres.map((x) => String(x || "").trim())
        : genreStr
        ? [genreStr]
        : [];
      const status = getBookEffectiveStatus(book);
      const rating = getBookEffectiveRating(book);

      if (q) {
        const hay = `${titleStr} ${authorStr.toLowerCase()} ${allGenres.join(" ").toLowerCase()}`;
        if (!hay.includes(q)) return false;
      }

      if (fAuthor !== "all" && authorStr !== fAuthor) {
        return false;
      }

      if (fGenre !== "all") {
        if (fGenre === "__unassigned__") {
          if (allGenres.length > 0 && allGenres[0]) return false;
        } else if (!allGenres.includes(fGenre) && genreStr !== fGenre) {
          return false;
        }
      }

      if (fStatus !== "all" && fStatus !== "archived" && status !== fStatus) {
        return false;
      }

      if (fRating !== "all") {
        if (fRating === "5" && rating < 5) return false;
        if ((fRating === "4.5+" || fRating === "4.5plus") && rating < 4.5) return false;
        if ((fRating === "4+" || fRating === "4plus") && rating < 4) return false;
        if ((fRating === "3.5+" || fRating === "3.5plus") && rating < 3.5) return false;
        if ((fRating === "3+" || fRating === "3plus") && rating < 3) return false;
        if (fRating === "2+" && rating < 2) return false;
        if (fRating === "1+" && rating < 1) return false;
        if (fRating === "rated" && rating <= 0) return false;
        if (fRating === "unrated" && rating > 0) return false;
        if (fRating === "1_2" && (rating < 0.5 || rating > 2)) return false;
      }

      return true;
    });

    const sortBy = state.libSortBy || "updated_at";
    const dirMult = state.libSortDir === "asc" ? 1 : -1;

    filtered.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "estimated_pages") {
        cmp = getBookEffectivePages(a) - getBookEffectivePages(b);
      } else if (sortBy === "author") {
        cmp = String(a.author || "").localeCompare(String(b.author || ""), "es", {
          sensitivity: "base",
        });
        if (cmp === 0) {
          cmp = String(a.title || "").localeCompare(String(b.title || ""), "es", {
            sensitivity: "base",
          });
        }
      } else if (sortBy === "title") {
        cmp = String(a.title || "").localeCompare(String(b.title || ""), "es", {
          sensitivity: "base",
        });
      } else if (sortBy === "published_date") {
        const pubA = String(a.published_date || (a.published_year ? `${a.published_year}-01-01` : "") || "");
        const pubB = String(b.published_date || (b.published_year ? `${b.published_year}-01-01` : "") || "");
        // Los libros sin fecha de publicación van al final tanto en asc como en desc
        if (!pubA && pubB) return 1;
        if (pubA && !pubB) return -1;
        cmp = pubA.localeCompare(pubB);
      } else if (sortBy === "added_at") {
        const addA = Number(a.added_at || a.updated_at || 0);
        const addB = Number(b.added_at || b.updated_at || 0);
        cmp = addA - addB;
      } else if (sortBy === "rating") {
        const rA = getBookEffectiveRating(a);
        const rB = getBookEffectiveRating(b);
        if (rA === 0 && rB > 0) return 1;
        if (rA > 0 && rB === 0) return -1;
        cmp = rA - rB;
      } else if (sortBy === "progress_pct") {
        const pA = computeBookProgressStats(a).percent;
        const pB = computeBookProgressStats(b).percent;
        cmp = pA - pB;
      } else {
        // updated_at: ordenar de menor a mayor tiempo transcurrido desde la última lectura
        // (el último libro que se ha estado leyendo aparece siempre en primer lugar)
        const uA = getBookLastReadTimestamp(a);
        const uB = getBookLastReadTimestamp(b);
        if (uA > 0 && uB === 0) return -1;
        if (uA === 0 && uB > 0) return 1;
        if (uA === 0 && uB === 0) {
          const addA = Number(a.added_at || 0);
          const addB = Number(b.added_at || 0);
          if (addA !== addB) return addB - addA;
        }
        cmp = uA - uB;
      }

      if (cmp === 0) {
        return String(a.title || "").localeCompare(String(b.title || ""), "es", {
          sensitivity: "base",
        });
      }
      return cmp * dirMult;
    });

    return filtered;
  }

  async function quickRateBookFromCard(book, starVal, clickEvent = null) {
    if (!book || !book.id) return;
    const currentRating = getBookEffectiveRating(book);
    const targetRating = computeNextStarRatingFromClick(currentRating, starVal, clickEvent);
    book.rating = targetRating;
    renderLibrary();

    try {
      const payload = { rating: targetRating };
      // Si el usuario le pone nota por primera vez y el libro ya estaba al 100%, marcar como terminado
      const progStats = computeBookProgressStats(book);
      if (targetRating > 0 && progStats.isCompleted && book.reading_status !== "completed") {
        payload.reading_status = "completed";
        book.reading_status = "completed";
      }
      const res = await fetch(`/api/books/${encodeURIComponent(book.id)}/study/meta`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        showToast(
          targetRating > 0
            ? `⭐ Valoración de «${book.title}»: ${formatStarsText(targetRating)}`
            : `Valoración eliminada en «${book.title}»`
        );
        fetchReadingAnalytics().catch(() => {});
      }
    } catch (_) {}
  }

  function updateSortDirButtonUi() {
    if (!els.btnLibSortDir) return;
    const isAsc = state.libSortDir === "asc";
    const isLastReadSort = (state.libSortBy || "updated_at") === "updated_at";
    if (isLastReadSort) {
      // En "Tiempo desde última lectura", state.libSortDir === "desc" ordena de menor a mayor tiempo transcurrido (el más reciente 1º)
      els.btnLibSortDir.textContent = isAsc
        ? "⬇️ Mayor a menor (Antiguo 1º)"
        : "⬆️ Menor a mayor (Reciente 1º)";
      return;
    }
    if (els.libSortDirIcon && els.libSortDirLabel) {
      els.libSortDirIcon.textContent = isAsc ? "⬆️" : "⬇️";
      els.libSortDirLabel.textContent = isAsc ? "Ascendente" : "Descendente";
    } else {
      els.btnLibSortDir.textContent = isAsc ? "⬆️ Ascendente" : "⬇️ Descendente";
    }
  }

  function updateLibFiltersCollapseUi() {
    const bar = document.getElementById("library-filters-bar");
    const body = document.getElementById("library-filters-body");
    const toggleBtn = document.getElementById("btn-toggle-lib-filters");
    const toggleLabel = document.getElementById("lib-filters-toggle-label");
    const summaryBadge = document.getElementById("lib-filters-summary-badge");
    if (!bar || !body) return;

    const isCollapsed = state.libFiltersCollapsed !== false;
    bar.classList.toggle("is-collapsed", isCollapsed);
    body.classList.toggle("hidden", isCollapsed);
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-expanded", String(!isCollapsed));
    }
    if (toggleLabel) {
      toggleLabel.textContent = isCollapsed ? "Desplegar ▾" : "Contraer ▴";
    }
    if (summaryBadge) {
      const sortLabels = {
        updated_at: state.libSortDir === "asc" ? "🕒 Antiguo 1º" : "🕒 Reciente 1º",
        added_at: "📥 Fecha adición",
        rating: "⭐ Nota",
        estimated_pages: "📄 Páginas",
        author: "✍️ Autor",
        published_date: "📅 Publicación",
        title: "🔤 Título",
        progress_pct: "📈 % Leído",
      };
      const sortSummary = sortLabels[state.libSortBy || "updated_at"] || "🕒 Reciente 1º";
      let activeCount = 0;
      if (state.libFilterSearch && state.libFilterSearch.trim()) activeCount++;
      if (state.libFilterAuthor && state.libFilterAuthor !== "all") activeCount++;
      if (state.libFilterGenre && state.libFilterGenre !== "all") activeCount++;
      if (state.libFilterStatus && state.libFilterStatus !== "all") activeCount++;
      if (state.libFilterRating && state.libFilterRating !== "all") activeCount++;

      summaryBadge.classList.toggle("has-active-filters", activeCount > 0);
      summaryBadge.textContent =
        activeCount > 0
          ? `${sortSummary} • ${activeCount} ${activeCount === 1 ? "filtro" : "filtros"}`
          : sortSummary;
    }
  }

  function renderLibrary() {
    populateLibraryFilterDropdowns();
    updateSortDirButtonUi();
    updateLibFiltersCollapseUi();

    const filteredBooks = getFilteredAndSortedLibraryBooks();
    const totalCount = state.books.length;
    const shownCount = filteredBooks.length;
    const hasFilters = hasActiveLibraryFilters();

    if (els.btnLibResetFilters) {
      els.btnLibResetFilters.classList.toggle("hidden", !hasFilters);
    }

    // Agrupar libros enlazados (inglés ↔ castellano) en una sola tarjeta bilingüe
    state.pairedCardActiveBookId = state.pairedCardActiveBookId || {};
    const consumedIds = new Set();
    const visualEntries = [];
    let pairedGroupsCount = 0;

    for (const candidateBook of filteredBooks) {
      if (consumedIds.has(candidateBook.id)) continue;

      const pairing = candidateBook.pairing;
      const partnerId = pairing && pairing.paired_book_id ? pairing.paired_book_id : null;
      const partnerBook = partnerId
        ? state.books.find((b) => b.id === partnerId) || null
        : null;

      if (partnerBook && partnerBook.id !== candidateBook.id) {
        consumedIds.add(candidateBook.id);
        consumedIds.add(partnerBook.id);
        pairedGroupsCount++;

        const pairKey = [candidateBook.id, partnerBook.id].sort().join("__");
        const primaryId = pairing.primary_book_id || "";
        let tabBooks = [candidateBook, partnerBook];
        if (primaryId === partnerBook.id) {
          tabBooks = [partnerBook, candidateBook];
        } else if (primaryId !== candidateBook.id) {
          const candIsEs = (candidateBook.language || "").toLowerCase().startsWith("es");
          const partIsEs = (partnerBook.language || "").toLowerCase().startsWith("es");
          if (candIsEs && !partIsEs) {
            tabBooks = [partnerBook, candidateBook];
          }
        }

        const savedActiveId = state.pairedCardActiveBookId[pairKey];
        const activeBook =
          savedActiveId === partnerBook.id
            ? partnerBook
            : savedActiveId === candidateBook.id
            ? candidateBook
            : candidateBook;
        state.pairedCardActiveBookId[pairKey] = activeBook.id;
        const inactiveBook = activeBook.id === candidateBook.id ? partnerBook : candidateBook;

        visualEntries.push({
          isPaired: true,
          pairKey,
          tabBooks,
          activeBook,
          inactiveBook,
        });
      } else {
        consumedIds.add(candidateBook.id);
        visualEntries.push({
          isPaired: false,
          pairKey: candidateBook.id,
          tabBooks: [candidateBook],
          activeBook: candidateBook,
          inactiveBook: null,
        });
      }
    }

    const pairNote =
      pairedGroupsCount > 0
        ? ` • ${pairedGroupsCount} ${pairedGroupsCount === 1 ? "pareja bilingüe" : "parejas bilingües"}`
        : "";

    const archCount = (state.archivedBooks || []).length;
    if (hasFilters) {
      els.libraryCount.textContent =
        state.libFilterStatus === "archived"
          ? `Archivo histórico: ${shownCount} ${shownCount === 1 ? "libro borrado" : "libros borrados"}`
          : `Mostrando ${shownCount} de ${totalCount} ${totalCount === 1 ? "libro" : "libros"}${pairNote}${state.isServerOffline ? " (En memoria local)" : ""}`;
    } else {
      els.libraryCount.textContent = `${totalCount} ${totalCount === 1 ? "libro" : "libros"}${pairNote}${state.isServerOffline ? " (En memoria local)" : ""}`;
    }

    if (els.libraryCount && els.libraryCount.parentElement) {
      let archToggleBtn = document.getElementById("btn-toggle-archived-library");
      if (archCount > 0 || state.libFilterStatus === "archived") {
        if (!archToggleBtn) {
          archToggleBtn = document.createElement("button");
          archToggleBtn.id = "btn-toggle-archived-library";
          archToggleBtn.type = "button";
          archToggleBtn.className = "lib-archived-link";
          archToggleBtn.addEventListener("click", () => {
            state.libFilterStatus = state.libFilterStatus === "archived" ? "all" : "archived";
            if (els.libFilterStatus) els.libFilterStatus.value = state.libFilterStatus;
            renderLibrary();
          });
          els.libraryCount.insertAdjacentElement("afterend", archToggleBtn);
        }
        const isShowingArchived = state.libFilterStatus === "archived";
        archToggleBtn.classList.toggle("is-active", isShowingArchived);
        archToggleBtn.textContent = isShowingArchived
          ? "✕ Volver a libros activos"
          : `🗄️ ${archCount} en archivo histórico`;
        archToggleBtn.title = isShowingArchived
          ? "Volver a mostrar tus libros activos en el servidor"
          : "Consultar libros borrados del servidor (historial, calificación y notas conservados)";
        archToggleBtn.classList.remove("hidden");
      } else if (archToggleBtn) {
        archToggleBtn.classList.add("hidden");
      }
    }

    els.booksGrid.innerHTML = "";

    if (shownCount === 0 && (totalCount > 0 || archCount > 0)) {
      const emptyBox = document.createElement("div");
      emptyBox.className = "library-empty-filter-state";
      emptyBox.innerHTML = `
        <p>${
          state.libFilterStatus === "archived"
            ? "🗄️ No hay ningún libro en el archivo histórico."
            : "🔍 Ningún libro coincide con los filtros seleccionados."
        }</p>
        <button type="button" class="secondary-btn" id="btn-empty-clear-filters">✖ Limpiar filtros y mostrar los ${totalCount} libros activos</button>
      `;
      emptyBox.querySelector("#btn-empty-clear-filters").addEventListener("click", () => {
        resetLibraryFilters();
      });
      els.booksGrid.appendChild(emptyBox);
      return;
    }

    for (const entry of visualEntries) {
      const book = entry.activeBook;
      const inactiveBook = entry.inactiveBook;
      const isArchivedCard = Boolean(book.is_archived);
      const card = document.createElement("div");
      card.className = isArchivedCard
        ? "book-card is-archived-card"
        : entry.isPaired
        ? "book-card is-bilingual-card"
        : "book-card";

      const isEs = (book.language || "").startsWith("es");
      const langBadge = isEs ? "🇪🇸 ES" : `🇬🇧 ${String(book.language || "EN").toUpperCase()}`;
      const prog = book.progress || { chapter_index: 0, sentence_index: 0 };
      const progStats = computeBookProgressStats(book);
      const effStatus = getBookEffectiveStatus(book);
      const chNum =
        effStatus === "completed" || progStats.isCompleted
          ? Math.max(1, Number(book.chapter_count || 1))
          : (prog.chapter_index || 0) + 1;
      const pairing = book.pairing;

      let bilingualSwitcherHtml = "";
      let pairBadgeHtml = "";
      if (entry.isPaired && inactiveBook) {
        const tabsHtml = entry.tabBooks
          .map((tb) => {
            const tbIsEs = (tb.language || "").toLowerCase().startsWith("es");
            const tbFlag = tbIsEs ? "🇪🇸" : "🇬🇧";
            const tbLangShort = tbIsEs ? "ES" : String(tb.language || "EN").toUpperCase().slice(0, 2);
            const tbStats = computeBookProgressStats(tb);
            const tbHasLocal = state.offlineBooksMap.has(tb.id);
            const isActiveTab = tb.id === book.id;
            return `
              <button
                type="button"
                class="bilingual-lang-tab ${isActiveTab ? "active" : ""}"
                data-switch-book-id="${tb.id}"
                title="Ver ficha y acciones de «${escapeHtml(tb.title)}» (${tbFlag} ${tbLangShort})"
              >
                <span class="bilingual-tab-lang">${tbFlag} ${tbLangShort}</span>
                <span class="bilingual-tab-meta">${tbStats.percentStr}${tbHasLocal ? " 📲" : ""}</span>
              </button>
            `;
          })
          .join("");

        bilingualSwitcherHtml = `
          <div class="bilingual-card-switcher">
            <span class="bilingual-pair-badge" title="Ediciones enlazadas: pulsa en 🇬🇧 EN o 🇪🇸 ES para cambiar de libro en esta misma tarjeta">🇬🇧↔🇪🇸 Pareja bilingüe</span>
            <div class="bilingual-tabs-wrap">${tabsHtml}</div>
          </div>
        `;

        const inactIsEs = (inactiveBook.language || "").toLowerCase().startsWith("es");
        const inactFlag = inactIsEs ? "🇪🇸" : "🇬🇧";
        const inactStats = computeBookProgressStats(inactiveBook);
        const inactProg = inactiveBook.progress || { chapter_index: 0, sentence_index: 0 };
        const inactStatus = getBookEffectiveStatus(inactiveBook);
        const inactChNum =
          inactStatus === "completed" || inactStats.isCompleted
            ? Math.max(1, Number(inactiveBook.chapter_count || 1))
            : (inactProg.chapter_index || 0) + 1;
        const inactLocal = state.offlineBooksMap.has(inactiveBook.id) ? " • 📲 Local" : "";

        pairBadgeHtml = `
          <div
            class="bilingual-partner-summary-bar"
            data-switch-book-id="${inactiveBook.id}"
            title="Pulsa para conmutar la tarjeta a «${escapeHtml(inactiveBook.title)}»"
          >
            <span class="bilingual-partner-title">🔗 Pareja: <strong>${inactFlag} ${escapeHtml(inactiveBook.title)}</strong></span>
            <span class="bilingual-partner-stats">📘 ${inactStats.percentStr} (Cap. ${inactChNum}/${inactiveBook.chapter_count})${inactLocal} ⇄</span>
          </div>
        `;
      } else if (pairing && pairing.paired_book_id) {
        pairBadgeHtml = `<div style="margin-top:4px;font-size:0.74rem;color:var(--accent);font-weight:600">🔗 Emparejado: ${escapeHtml(pairing.paired_book_title)}</div>`;
      }

      const statusMeta = READING_STATUS_META[effStatus] || READING_STATUS_META.reading;
      const effGenre = getBookEffectiveGenre(book);
      const effPages = getBookEffectivePages(book);
      const effRating = getBookEffectiveRating(book);
      const pubYear = book.published_year || (book.published_date ? String(book.published_date).slice(0, 4) : "");
      const addedDateStr = formatShortDateEs(book.added_at || book.updated_at);

      const genrePillHtml = effGenre
        ? `<span class="catalog-pill genre-pill btn-card-edit-meta" title="Tipo / género del libro (pulsa para cambiar)">🏷️ ${escapeHtml(effGenre)}</span>`
        : `<span class="catalog-pill genre-pill unassigned btn-card-edit-meta" title="Pulsa para asignar tipo de libro (Terror, Ciencia Ficción, etc.)">🏷️ + Género</span>`;

      const pubPillHtml = pubYear
        ? `<span class="catalog-pill meta-pill btn-card-edit-meta" title="Fecha de publicación: ${escapeHtml(book.published_date || String(pubYear))}">📅 ${escapeHtml(String(pubYear))}</span>`
        : "";

      const addedPillHtml = addedDateStr
        ? `<span class="catalog-pill meta-pill" title="Fecha de adición: ${escapeHtml(addedDateStr)}">📥 ${escapeHtml(addedDateStr)}</span>`
        : "";
      const lastReadTs = getBookLastReadTimestamp(book);
      const lastReadElapsedStr = formatElapsedSinceLastRead(lastReadTs);
      const lastReadPillHtml =
        lastReadTs > 0
          ? `<span class="catalog-pill meta-pill" style="color:var(--accent);font-weight:600" title="Tiempo transcurrido desde la última lectura (${escapeHtml(formatShortDateEs(lastReadTs))})">🕒 ${escapeHtml(lastReadElapsedStr)}</span>`
          : "";

      let starsBtnsHtml = "";
      for (let s = 1; s <= 5; s++) {
        const isFull = effRating >= s;
        const isHalf = !isFull && effRating >= s - 0.5;
        const stateCls = isFull ? "active" : isHalf ? "half" : "";
        starsBtnsHtml += `<button type="button" class="card-star-btn ${stateCls}" data-star="${s}" title="Pulsa 1 vez para ${s} ★ o 2 veces para ${formatRatingValueEs(s - 0.5)} ★">★</button>`;
      }
      if (effRating > 0) {
        starsBtnsHtml += `<span class="card-rating-num">${formatRatingValueEs(effRating)}</span>`;
      }

      const offlineRec = state.offlineBooksMap.get(book.id);
      let offlineBadgeHtml = "";
      if (offlineRec) {
        const packs = Object.values(offlineRec.audio_packs || {});
        const totalBookCh = Number(book.chapter_count || (offlineRec.chapters && offlineRec.chapters.length) || 0);
        if (packs.length === 0) {
          offlineBadgeHtml = `<div style="margin-top:3px;font-size:0.74rem;color:#16a34a;font-weight:600">📲 Local (Solo texto)</div>`;
        } else {
          const p = packs[0];
          const completeCnt = Array.isArray(p.complete_chapters)
            ? p.complete_chapters.length
            : (p.chapters && p.chapters.length) || 0;
          const partials = Array.isArray(p.partial_chapters) ? p.partial_chapters : [];
          if (partials.length > 0) {
            const firstPart = partials[0];
            offlineBadgeHtml = `<div style="margin-top:3px;font-size:0.74rem;color:#f59e0b;font-weight:600" title="Pulsa en 📲 Local para reanudar desde el punto exacto">⚠️ Local incompleto: ${completeCnt}/${totalBookCh} cap. (Cap. ${firstPart.chapter_index + 1}: ${firstPart.saved}/${firstPart.total})</div>`;
          } else if (totalBookCh > 0 && completeCnt < totalBookCh) {
            offlineBadgeHtml = `<div style="margin-top:3px;font-size:0.74rem;color:#0284c7;font-weight:600">📲 Local (${completeCnt}/${totalBookCh} cap. con audio IA)</div>`;
          } else {
            offlineBadgeHtml = `<div style="margin-top:3px;font-size:0.74rem;color:#16a34a;font-weight:600">📲 Local (✅ ${completeCnt}/${totalBookCh} cap. con audio IA)</div>`;
          }
        }
      }

      const mediaOverlayBadgeHtml = book.has_embedded_media_overlay
        ? `<div style="margin-top:3px;font-size:0.74rem;color:#a855f7;font-weight:600">🎧 EPUB Media Overlay (${book.embedded_media_overlay_sentences || book.total_sentences} frases)</div>`
        : book.has_synced_audiobook
        ? `<div style="margin-top:3px;font-size:0.74rem;color:#0284c7;font-weight:600">🎧 Audiolibro sincronizado (${escapeHtml(book.synced_audiobook_name || "Original")})</div>`
        : "";

      const coverHtml = book.cover_url
        ? `<img src="${resolveApiUrl(book.cover_url)}" alt="Portada" loading="lazy" />`
        : `<span>${book.title.slice(0, 28)}</span>`;

      card.innerHTML = `
        ${bilingualSwitcherHtml}
        <div class="book-card-top">
          <div class="book-cover-box">${coverHtml}</div>
          <div class="book-meta">
            <div class="book-meta-header">
              <div class="book-meta-header-left">
                <span class="lang-tag" title="Idioma del libro">${langBadge}</span>
                <span class="catalog-pill ${statusMeta.cls} btn-card-edit-meta" title="Estado de lectura (pulsa para cambiar)">${statusMeta.label}</span>
                ${isArchivedCard ? `<span class="catalog-pill archived-pill" title="Archivos EPUB y audios borrados del servidor para ahorrar espacio. Si vuelves a añadir el EPUB recuperará su ficha automáticamente.">🗄️ Archivado</span>` : ""}
              </div>
              <div class="card-stars-group" title="Valoración: ${effRating > 0 ? `${formatRatingValueEs(effRating)}/5 ★ (pulsa de nuevo en una estrella para media estrella)` : "Pulsa en las estrellas para puntuar (saltos de 0,5 ★)"}">${starsBtnsHtml}</div>
            </div>
            <h3 class="book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</h3>
            <p class="book-author">${escapeHtml(book.author)}</p>
            <div class="book-catalog-badges">
              ${lastReadPillHtml}
              ${genrePillHtml}
              <span class="catalog-pill meta-pill" title="Páginas estimadas (~250 palabras/pág.)">📄 ${effPages} págs.</span>
              <span class="catalog-pill meta-pill" title="${book.total_sentences} frases en ${book.chapter_count} capítulos">📚 ${book.chapter_count} cap.</span>
              ${pubPillHtml}
              ${addedPillHtml}
            </div>
            <div class="book-progress-row" title="${progStats.sentencesRead} de ${progStats.totalSentences} frases leídas">
              <div class="book-progress-header">
                <span>📘 Leído: <strong>${progStats.percentStr}</strong></span>
                <span style="color:var(--text-secondary);font-weight:500">Cap. ${chNum}/${book.chapter_count}</span>
              </div>
              <div class="book-progress-track">
                <div class="book-progress-fill ${progStats.isCompleted ? "completed" : ""}" style="width:${Math.min(100, progStats.percent).toFixed(1)}%"></div>
              </div>
            </div>
            ${mediaOverlayBadgeHtml}
            ${offlineBadgeHtml}
            ${pairBadgeHtml}
          </div>
        </div>
        <div class="book-card-actions">
          ${
            isArchivedCard
              ? `
          <div class="book-card-actions-main">
            <button class="primary-btn btn-open-archived-study" data-id="${book.id}">
              📓 Ver Ficha, Notas y Sesiones
            </button>
          </div>
          <div class="book-card-actions-tools">
            <button class="secondary-btn btn-study-book" data-id="${book.id}" title="Cuaderno de lectura, género, estado, nota y Obsidian">📓 Notas</button>
            <button class="secondary-btn btn-reupload-archived" data-id="${book.id}" title="Volver a añadir el EPUB para leer o escuchar recuperando todo este historial">📤 Re-subir EPUB</button>
            <button class="delete-book-btn btn-purge-archived" data-id="${book.id}" title="Eliminar definitivamente historial y calificación">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </button>
          </div>`
              : `
          <div class="book-card-actions-main">
            <button class="primary-btn btn-open-book" data-id="${book.id}">
              ${
                effStatus === "completed" || progStats.isCompleted
                  ? `✅ Terminado (${progStats.percentStr}) — Abrir libro`
                  : prog.chapter_index > 0 || prog.sentence_index > 0
                  ? `📖 Continuar lectura (${progStats.percentStr})`
                  : "📖 Abrir y escuchar"
              }
            </button>
          </div>
          <div class="book-card-actions-tools">
            <button class="secondary-btn btn-offline-book" data-id="${book.id}" title="Guardar en la memoria de este móvil/PC para leer y escuchar sin conexión">📲 Local</button>
            <button class="secondary-btn btn-study-book" data-id="${book.id}" title="Cuaderno de lectura, género, estado, nota y Obsidian">📓 Notas</button>
            <button class="secondary-btn btn-pair-book" data-id="${book.id}" title="Emparejar versión en Inglés y Castellano">🇬🇧↔🇪🇸</button>
            <button class="secondary-btn btn-export-book" data-id="${book.id}" title="Generar M4B, EPUB Media Overlay y caché permanente">🎧 M4B</button>
            <button class="delete-book-btn" data-id="${book.id}" title="Eliminar archivos del servidor (conservando historial y notas)">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </button>
          </div>`
          }
        </div>
      `;

      card.querySelectorAll("[data-switch-book-id]").forEach((switchEl) => {
        switchEl.addEventListener("click", (e) => {
          e.stopPropagation();
          const targetBookId = switchEl.dataset.switchBookId;
          if (!targetBookId || targetBookId === book.id) return;
          state.pairedCardActiveBookId[entry.pairKey] = targetBookId;
          renderLibrary();
        });
      });

      card.querySelectorAll(".card-star-btn").forEach((starBtn) => {
        starBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const starVal = Number(starBtn.dataset.star || 0);
          quickRateBookFromCard(book, starVal, e);
        });
      });

      card.querySelectorAll(".btn-card-edit-meta").forEach((pillEl) => {
        pillEl.addEventListener("click", (e) => {
          e.stopPropagation();
          openStudyModal(book, "habits");
        });
      });

      const openBookBtn = card.querySelector(".btn-open-book");
      if (openBookBtn) {
        openBookBtn.addEventListener("click", () =>
          openBook(book.id, { preferLocal: state.offlineBooksMap.has(book.id) })
        );
      }
      const openArchStudyBtn = card.querySelector(".btn-open-archived-study");
      if (openArchStudyBtn) {
        openArchStudyBtn.addEventListener("click", () => openStudyModal(book, "habits"));
      }
      const reuploadBtn = card.querySelector(".btn-reupload-archived");
      if (reuploadBtn && els.fileInput) {
        reuploadBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          els.fileInput.click();
        });
      }
      const offlineBookBtn = card.querySelector(".btn-offline-book");
      if (offlineBookBtn) {
        offlineBookBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openOfflineModal(book);
        });
      }
      const studyBookBtn = card.querySelector(".btn-study-book");
      if (studyBookBtn) {
        studyBookBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openStudyModal(book);
        });
      }
      const pairBookBtn = card.querySelector(".btn-pair-book");
      if (pairBookBtn) {
        pairBookBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openPairingModal(book);
        });
      }
      const exportBookBtn = card.querySelector(".btn-export-book");
      if (exportBookBtn) {
        exportBookBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openExportsModal(book);
        });
      }
      const purgeBtn = card.querySelector(".btn-purge-archived");
      const deleteBtn = card.querySelector(".delete-book-btn");
      if (purgeBtn) {
        purgeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          purgeArchivedBookHistory(book.id, book.title);
        });
      } else if (deleteBtn) {
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteBook(book.id, book.title);
        });
      }

      els.booksGrid.appendChild(card);
    }
  }

  function resetLibraryFilters() {
    state.libFilterSearch = "";
    state.libFilterAuthor = "all";
    state.libFilterGenre = "all";
    state.libFilterStatus = "all";
    state.libFilterRating = "all";
    if (els.libFilterSearch) els.libFilterSearch.value = "";
    if (els.libFilterAuthor) els.libFilterAuthor.value = "all";
    if (els.libFilterGenre) els.libFilterGenre.value = "all";
    if (els.libFilterStatus) els.libFilterStatus.value = "all";
    if (els.libFilterRating) els.libFilterRating.value = "all";
    renderLibrary();
  }

  let pendingSyncEpubFile = null;
  let pendingSyncAudioFiles = [];

  async function handleIncomingUploadFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const epubs = files.filter((f) => f.name.toLowerCase().endsWith(".epub"));
    const audios = files.filter((f) =>
      /\.(mp3|m4b|m4a|wav|ogg|flac|aac|opus)$/i.test(f.name)
    );

    if (epubs.length === 1 && audios.length === 0) {
      await uploadEpubFile(epubs[0]);
      return;
    }

    if (epubs.length > 0 && audios.length > 0) {
      openAudiobookSyncModal({
        mode: "new",
        epubFile: epubs[0],
        audioFiles: audios,
      });
      return;
    }

    if (audios.length > 0) {
      openAudiobookSyncModal({
        mode: state.books.length > 0 ? "existing" : "new",
        bookObj: state.currentBook || state.books[0] || null,
        audioFiles: audios,
      });
      return;
    }

    showToast("Selecciona un archivo .epub o archivos de audiolibro (.mp3, .m4b, .m4a)");
  }

  function updateSyncModalModeUi() {
    if (!els.syncTargetMode) return;
    const isExisting = els.syncTargetMode.value === "existing";
    if (els.syncNewEpubBox) els.syncNewEpubBox.classList.toggle("hidden", isExisting);
    if (els.syncExistingBookBox) els.syncExistingBookBox.classList.toggle("hidden", !isExisting);
  }

  async function openAudiobookSyncModal({
    mode = "new",
    bookObj = null,
    epubFile = null,
    audioFiles = null,
  } = {}) {
    if (state.books.length === 0) {
      await fetchLibrary();
    }

    if (els.syncExistingBookSelect) {
      els.syncExistingBookSelect.innerHTML = "";
      if (state.books.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "— No hay libros en la biblioteca —";
        els.syncExistingBookSelect.appendChild(opt);
      } else {
        for (const b of state.books) {
          const opt = document.createElement("option");
          opt.value = b.id;
          const flag = (b.language || "").startsWith("es") ? "🇪🇸" : "🇬🇧";
          opt.textContent = `📚 ${flag} ${b.title} (${b.chapter_count} cap. • ${b.total_sentences} frases)`;
          els.syncExistingBookSelect.appendChild(opt);
        }
        const target = bookObj || state.exportTargetBook || state.currentBook || state.books[0];
        if (target) {
          els.syncExistingBookSelect.value = target.id;
        }
      }
    }

    if (els.syncTargetMode) {
      els.syncTargetMode.value = mode === "existing" && state.books.length > 0 ? "existing" : "new";
    }
    updateSyncModalModeUi();

    if (epubFile) {
      pendingSyncEpubFile = epubFile;
      if (els.syncEpubFilename) {
        els.syncEpubFilename.textContent = `✓ ${epubFile.name}`;
      }
    } else if (!pendingSyncEpubFile && els.syncEpubFilename) {
      els.syncEpubFilename.textContent = "Ningún archivo .epub seleccionado";
    }

    if (audioFiles && audioFiles.length > 0) {
      pendingSyncAudioFiles = Array.from(audioFiles);
      if (els.syncAudioFilenames) {
        els.syncAudioFilenames.textContent =
          pendingSyncAudioFiles.length === 1
            ? `✓ ${pendingSyncAudioFiles[0].name}`
            : `✓ ${pendingSyncAudioFiles.length} archivos de audio seleccionados`;
      }
    } else if (pendingSyncAudioFiles.length === 0 && els.syncAudioFilenames) {
      els.syncAudioFilenames.textContent = "Ningún archivo de audio seleccionado";
    }

    if (els.syncUploadProgressBox) {
      els.syncUploadProgressBox.classList.add("hidden");
    }
    if (els.chkSyncBuildEpub) {
      els.chkSyncBuildEpub.checked = true;
    }
    if (els.chkSyncBuildM4b) {
      els.chkSyncBuildM4b.checked = false;
    }
    if (els.btnStartAudiobookSync) {
      els.btnStartAudiobookSync.disabled = false;
    }

    if (els.audiobookSyncModal) {
      els.audiobookSyncModal.classList.remove("hidden");
    }
  }

  function uploadFormDataWithProgress(url, formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", resolveApiUrl(url), true);
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
          }
        };
      }
      xhr.onload = () => {
        let parsed = {};
        try {
          parsed = JSON.parse(xhr.responseText || "{}");
        } catch (_) {}
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(parsed);
        } else {
          reject(new Error(parsed.detail || `Error HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new Error("Error de red al subir el audiolibro al servidor"));
      xhr.send(formData);
    });
  }

  async function submitAudiobookSync() {
    const mode = els.syncTargetMode ? els.syncTargetMode.value : "new";
    if (mode === "new" && !pendingSyncEpubFile) {
      showToast("Selecciona primero el archivo .epub del libro");
      return;
    }
    const existingBookId = els.syncExistingBookSelect ? els.syncExistingBookSelect.value : "";
    if (mode === "existing" && !existingBookId) {
      showToast("Selecciona un libro de tu biblioteca");
      return;
    }
    if (!pendingSyncAudioFiles || pendingSyncAudioFiles.length === 0) {
      if (mode === "new" && pendingSyncEpubFile) {
        const epubToUpload = pendingSyncEpubFile;
        pendingSyncEpubFile = null;
        if (els.syncEpubInput) els.syncEpubInput.value = "";
        if (els.audiobookSyncModal) els.audiobookSyncModal.classList.add("hidden");
        await uploadEpubFile(epubToUpload);
        return;
      }
      showToast("Selecciona al menos un archivo de audiolibro (.mp3, .m4b o .m4a)");
      return;
    }

    const label = els.syncAudiobookLabel ? els.syncAudiobookLabel.value.trim() : "";
    const wantEpub = els.chkSyncBuildEpub ? els.chkSyncBuildEpub.checked : true;
    const wantM4b = els.chkSyncBuildM4b ? els.chkSyncBuildM4b.checked : false;

    if (els.btnStartAudiobookSync) els.btnStartAudiobookSync.disabled = true;
    if (els.syncUploadProgressBox) els.syncUploadProgressBox.classList.remove("hidden");
    if (els.syncUploadPhase) els.syncUploadPhase.textContent = "Subiendo archivos al servidor...";
    if (els.syncUploadPct) els.syncUploadPct.textContent = "0%";
    if (els.syncUploadBar) els.syncUploadBar.style.width = "0%";

    try {
      const fd = new FormData();
      let endpoint = "";
      if (mode === "new") {
        endpoint = "/api/books/upload";
        fd.append("file", pendingSyncEpubFile);
      } else {
        endpoint = `/api/books/${encodeURIComponent(existingBookId)}/audiobook/sync`;
      }
      fd.append("build_epub_overlay", String(wantEpub));
      fd.append("build_m4b", String(wantM4b));

      for (const af of pendingSyncAudioFiles) {
        fd.append("audio_files", af);
      }
      if (label) {
        fd.append("audiobook_name", label);
      }

      const data = await uploadFormDataWithProgress(endpoint, fd, (pct) => {
        if (els.syncUploadPct) els.syncUploadPct.textContent = `${pct}%`;
        if (els.syncUploadBar) els.syncUploadBar.style.width = `${pct}%`;
        if (pct >= 100 && els.syncUploadPhase) {
          els.syncUploadPhase.textContent = "Iniciando alineación acústica de capítulos y frases...";
        }
      });

      pendingSyncEpubFile = null;
      pendingSyncAudioFiles = [];
      if (els.syncEpubInput) els.syncEpubInput.value = "";
      if (els.syncAudioInput) els.syncAudioInput.value = "";
      if (els.audiobookSyncModal) els.audiobookSyncModal.classList.add("hidden");

      await fetchLibrary();
      const targetBook =
        data.book ||
        state.books.find((b) => b.id === existingBookId) ||
        state.books[0] ||
        null;

      showToast(
        "🎧 ¡Sincronización de texto y voz iniciada! Puedes abrir el libro o seguir el progreso en la cola.",
        5500
      );
      await openExportsModal(targetBook);
    } catch (err) {
      showToast(`Error: ${err.message}`, 5500);
      if (els.btnStartAudiobookSync) els.btnStartAudiobookSync.disabled = false;
    }
  }

  async function uploadEpubFile(file) {
    if (!file || !file.name.toLowerCase().endsWith(".epub")) {
      showToast("Por favor, selecciona un archivo con extensión .epub");
      return;
    }

    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    const progBox = document.getElementById("epub-upload-progress-box");
    const progPhase = document.getElementById("epub-upload-phase");
    const progPct = document.getElementById("epub-upload-pct");
    const progBar = document.getElementById("epub-upload-bar");

    if (progBox) progBox.classList.remove("hidden");
    if (progPhase) progPhase.textContent = `Subiendo "${file.name}" (${sizeMb} MB)...`;
    if (progPct) progPct.textContent = "0%";
    if (progBar) progBar.style.width = "0%";
    if (els.btnSelectEpub) els.btnSelectEpub.disabled = true;

    showToast(`Subiendo "${file.name}" (${sizeMb} MB)...`, 6000);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const data = await uploadFormDataWithProgress(
        "/api/books/upload",
        formData,
        (pct, loaded, total) => {
          if (progPct) progPct.textContent = `${pct}%`;
          if (progBar) progBar.style.width = `${pct}%`;
          if (progPhase) {
            if (pct < 100) {
              const curMb = ((loaded || 0) / (1024 * 1024)).toFixed(1);
              const totMb = ((total || file.size) / (1024 * 1024)).toFixed(1);
              progPhase.textContent = `Subiendo "${file.name}" (${curMb} / ${totMb} MB)...`;
            } else {
              progPhase.textContent =
                "⚡ Analizando capítulos y extrayendo pistas Media Overlay SMIL (sin recalcular)...";
            }
          }
        }
      );

      if (data.restored_from_archive) {
        showToast(
          `♻️ «${data.book.title}» restaurado con todo su historial de lectura, calificación y notas`,
          6000
        );
      } else if (data.book && data.book.has_embedded_media_overlay) {
        await fetchVoices();
        showToast(
          `🎧 EPUB Media Overlay detectado: "${data.book.title}" (${data.book.embedded_media_overlay_sentences || data.book.total_sentences} frases con audio sincronizado listas sin recalcular)`,
          7500
        );
      } else {
        showToast(`Libro "${data.book.title}" añadido correctamente`);
      }
      await fetchLibrary();
      await openBook(data.book.id);
    } catch (err) {
      showToast(`Error al subir EPUB: ${err.message}`, 6500);
    } finally {
      if (progBox) progBox.classList.add("hidden");
      if (els.btnSelectEpub) els.btnSelectEpub.disabled = false;
    }
  }

  async function deleteBook(bookId, title) {
    if (
      !confirm(
        `¿Borrar los archivos pesados de «${title}» del servidor para liberar espacio?\n\n✅ Se conservarán intactos tu registro de lectura, fechas, calificación, vocabulario y notas de Obsidian (y se restaurarán solos si vuelves a subir el EPUB).`
      )
    ) {
      return;
    }
    try {
      if (state.currentBook && state.currentBook.id === bookId) {
        await closeMiniPlayerAndStop();
      }
      await fetch(`/api/books/${encodeURIComponent(bookId)}`, { method: "DELETE" });
      showToast(`🗄️ Archivos de «${title}» liberados — Tu historial y notas siguen guardados`, 4800);
      await fetchLibrary();
      fetchReadingAnalytics().catch(() => {});
    } catch (err) {
      showToast("No se pudo eliminar el libro");
    }
  }

  async function purgeArchivedBookHistory(bookId, title) {
    if (
      !confirm(
        `¿Eliminar DEFINITIVAMENTE el historial, sesiones y calificación de «${title}»?\n\nEsta acción borrará también su registro de Hábitos y Valoraciones.`
      )
    ) {
      return;
    }
    try {
      await fetch(`/api/books/${encodeURIComponent(bookId)}?purge_history=true`, {
        method: "DELETE",
      });
      showToast(`Historial de «${title}» eliminado permanentemente`);
      await fetchLibrary();
      fetchReadingAnalytics().catch(() => {});
    } catch (err) {
      showToast("No se pudo eliminar el historial del libro");
    }
  }

  // Devuelve la frase exacta guardada en un capítulo específico de un libro (o 0 si empieza capítulo nuevo)
  function getSavedSentenceForChapter(bookObj, targetChapter) {
    if (!bookObj) return 0;
    const chIdx = Number(targetChapter);
    if (Number.isNaN(chIdx) || chIdx < 0) return 0;

    const libBook = state.books.find((b) => b.id === bookObj.id) || null;
    const localRec = state.offlineBooksMap.get(bookObj.id) || null;
    const localBook = localRec && localRec.book ? localRec.book : null;

    const candidates = [
      bookObj.progress,
      libBook && libBook.progress,
      localBook && localBook.progress,
    ].filter(Boolean);

    candidates.sort((a, b) => {
      if (Boolean(a.dirty_offline) !== Boolean(b.dirty_offline)) {
        return a.dirty_offline ? -1 : 1;
      }
      return Number(b.updated_at || 0) - Number(a.updated_at || 0);
    });

    const bestProg = candidates[0] || {};
    const chSummary = (
      bookObj.chapters_summary ||
      (libBook && libBook.chapters_summary) ||
      (localBook && localBook.chapters_summary) ||
      []
    ).find((c) => Number(c.index) === chIdx);
    const totalSents = Number((chSummary && chSummary.sentence_count) || 0);

    // 1. Si el libro ya estaba situado en ese mismo capítulo, retomar exactamente en su frase actual
    if (Number(bestProg.chapter_index) === chIdx) {
      const curSent = Math.max(0, Number(bestProg.sentence_index || 0));
      return totalSents > 0 ? Math.min(curSent, totalSents - 1) : curSent;
    }

    // 2. Si existe una frase guardada en chapter_positions para ese capítulo (y no es el final de un capítulo ya completado)
    for (const c of candidates) {
      const posMap = c.chapter_positions || {};
      const saved = posMap[String(chIdx)];
      if (saved !== undefined && saved !== null && Number(saved) > 0) {
        const sVal = Number(saved);
        if (totalSents <= 0 || sVal < totalSents - 1) {
          return totalSents > 0 ? Math.min(sVal, totalSents - 1) : sVal;
        }
      }
    }

    // 3. Capítulo nuevo en este idioma: empezar en la frase 1 (índice 0)
    return 0;
  }

  // Abrir un libro y cargar el capítulo guardado (Prioridad Local-First si está en memoria del dispositivo)
  async function openBook(
    bookId,
    {
      overrideChapterIndex = null,
      overrideSentenceIndex = null,
      autoPlay = false,
      preferLocal = false,
      keepViewHidden = false,
      preferredUiMode = null,
    } = {}
  ) {
    // Si ya tenemos abierto este mismo libro en segundo plano (p. ej. sonando desde la Biblioteca), volver sin cortar el audio
    if (
      state.currentBook &&
      state.currentBook.id === bookId &&
      state.currentChapter &&
      overrideChapterIndex === null &&
      overrideSentenceIndex === null &&
      !keepViewHidden
    ) {
      returnToActiveBookView(preferredUiMode);
      if (autoPlay && !state.isPlaying) {
        startPlayback();
      }
      return;
    }

    if (state.autoFullscreen && !keepViewHidden) {
      enterFullscreenIfAllowed();
    }
    stopPlayback();
    hideDictionaryPopover();
    hideSelectionToolbar();
    if (state.currentBook && state.currentChapter && els.readerView && !els.readerView.classList.contains("hidden")) {
      await saveReadingProgress({ immediate: true });
    }
    flushActiveReadingSession().catch(() => {});

    try {
      // 1. Comprobar primero en la memoria RAM / IndexedDB local para apertura instantánea (0 ms de espera)
      let localBundle = state.offlineBooksMap.get(bookId) || null;
      if (!localBundle) {
        localBundle = await OfflineStore.getBookBundle(bookId);
        if (localBundle) {
          state.offlineBooksMap.set(bookId, localBundle);
        }
      }

      const catalogBook = state.books.find((b) => b.id === bookId) || null;

      let bookObj = null;
      if (localBundle && localBundle.book) {
        bookObj = localBundle.book;
        if (catalogBook) {
          const localProg = bookObj.progress || {};
          const catProg = catalogBook.progress || {};
          const keepLocalProg =
            Boolean(localProg.dirty_offline) &&
            Number(localProg.updated_at || 0) >= Number(catProg.updated_at || 0);
          const mergedPositions = {
            ...(catProg.chapter_positions || {}),
            ...(localProg.chapter_positions || {}),
          };
          bookObj = {
            ...bookObj,
            ...catalogBook,
            pairing:
              catalogBook.pairing !== undefined ? catalogBook.pairing : bookObj.pairing,
            progress: keepLocalProg
              ? { ...catProg, ...localProg, chapter_positions: mergedPositions }
              : { ...localProg, ...catProg, chapter_positions: mergedPositions },
          };
          localBundle.book = bookObj;
        }
        if (localBundle.study) state.currentStudy = localBundle.study;
        if (localBundle.obsidian_markdown) state.obsidianMarkdown = localBundle.obsidian_markdown;
      }

      // 2. Si no está en local (o si tenemos conexión y no se pidió apertura local directa), consultar servidor con timeout corto
      if (!bookObj || (!preferLocal && !state.isServerOffline)) {
        try {
          const res = await fetchWithTimeout(`/api/books/${bookId}`, {}, bookObj ? 1800 : 4500);
          if (res.ok) {
            const data = await res.json();
            if (data.book) {
              const localProg = (bookObj && bookObj.progress) || {};
              const srvProg = data.book.progress || {};
              const keepLocalProg =
                Boolean(localProg.dirty_offline) &&
                Number(localProg.updated_at || 0) > Number(srvProg.updated_at || 0);
              const mergedPositions = {
                ...(srvProg.chapter_positions || {}),
                ...(localProg.chapter_positions || {}),
              };
              data.book.progress = keepLocalProg
                ? { ...srvProg, ...localProg, chapter_positions: mergedPositions }
                : { ...localProg, ...srvProg, chapter_positions: mergedPositions };
              bookObj = data.book;
              if (localBundle) {
                OfflineStore.syncServerBookMeta(bookObj);
              }
            }
          }
        } catch (_) {
          if (!bookObj) {
            await markServerPotentiallyOffline();
          }
        }
      }

      // 3. Respaldo final desde la lista en memoria de la biblioteca
      if (!bookObj && catalogBook) {
        bookObj = catalogBook;
      }

      if (!bookObj) {
        throw new Error(
          "No se encontró el libro (ni en el servidor ni en la memoria local de este dispositivo)"
        );
      }

      state.currentBook = bookObj;

      const prog = state.currentBook.progress || {};
      state.chapterIndex =
        overrideChapterIndex !== null ? overrideChapterIndex : prog.chapter_index || 0;
      state.sentenceIndex =
        overrideSentenceIndex !== null
          ? overrideSentenceIndex
          : overrideChapterIndex !== null
          ? getSavedSentenceForChapter(state.currentBook, overrideChapterIndex)
          : prog.sentence_index || 0;

      // Si el libro tiene paquetes de audio descargados en local (IndexedDB), priorizar esa voz descargada
      const localPacks = localBundle && localBundle.audio_packs ? Object.values(localBundle.audio_packs) : [];
      if (localPacks.length > 0 && (preferLocal || state.isServerOffline || !prog.voice_id)) {
        const matchingPack =
          localPacks.find((p) => p.voice_id === prog.voice_id) || localPacks[0];
        state.selectedVoice = matchingPack.voice_id;
        state.speed = Number(matchingPack.speed || 1.0);
      } else if (prog.voice_id) {
        state.selectedVoice = prog.voice_id;
      } else {
        state.selectedVoice = (state.currentBook.language || "es").startsWith("es")
          ? "piper:es_ES-davefx-medium"
          : "piper:en_GB-cori-medium";
      }

      if (prog.speed && !(localPacks.length > 0 && (preferLocal || state.isServerOffline))) {
        state.speed = Number(prog.speed);
      }
      const matchSpeedOpt = [...els.selectSpeed.options].find(
        (o) => Math.abs(Number(o.value) - state.speed) < 0.01
      );
      els.selectSpeed.value = matchSpeedOpt ? matchSpeedOpt.value : "1.0";

      renderVoiceSelector(state.currentBook.language);
      // Asegurar que si la voz descargada en local o de Media Overlay no estaba en la lista aún, figure como opción seleccionable
      if (
        state.selectedVoice &&
        ![...els.selectVoice.options].some((o) => o.value === state.selectedVoice)
      ) {
        const customOpt = document.createElement("option");
        customOpt.value = state.selectedVoice;
        const packMatch = localPacks.find((p) => p.voice_id === state.selectedVoice);
        customOpt.textContent = packMatch
          ? `[En Memoria Local] ${packMatch.voice_name} (✓)`
          : state.selectedVoice === "audiobook:original"
          ? "🎧 [Audiolibro Sincronizado] Narración Original / Media Overlay (✓)"
          : `${state.selectedVoice} (✓)`;
        els.selectVoice.insertBefore(customOpt, els.selectVoice.firstChild);
      }
      els.selectVoice.value = state.selectedVoice;
      if (els.abSelectVoice) {
        els.abSelectVoice.innerHTML = els.selectVoice.innerHTML;
        els.abSelectVoice.value = state.selectedVoice;
      }

      if (preferredUiMode === "audiobook" || preferredUiMode === "reading") {
        state.readerUiMode = preferredUiMode;
        saveAppearancePrefs();
      }

      els.chapterContent.lang = (state.currentBook.language || "es").slice(0, 2).toLowerCase();
      if (!keepViewHidden) {
        els.currentBookTitle.textContent = state.currentBook.title;
        els.currentBookTitle.title = state.currentBook.title || "";
        els.libraryView.classList.add("hidden");
        els.readerView.classList.remove("hidden");
        els.btnBackLibrary.classList.remove("hidden");
        els.btnToggleToc.classList.remove("hidden");
        if (els.btnTopbarAddBook) els.btnTopbarAddBook.classList.add("hidden");
        if (els.btnOpenStudy) els.btnOpenStudy.classList.remove("hidden");
        if (els.btnOpenExports) els.btnOpenExports.classList.remove("hidden");
        if (els.btnOpenPairing) els.btnOpenPairing.classList.remove("hidden");
        els.brandLogo.classList.add("hide-mobile");
      }

      updateStudyHeaderBadge();
      updatePairingHeaderButtons();
      applyAppearance();
      renderToc();
      await loadChapter(state.chapterIndex, state.sentenceIndex, autoPlay);
      startReadingSessionForCurrentBook();

      // Sincronizar cuaderno de notas en segundo plano sin bloquear la apertura del libro
      if (!state.isServerOffline) {
        fetchBookStudy(state.currentBook.id).catch(() => {});
      }
    } catch (err) {
      showToast(`Error abriendo libro: ${err.message}`);
    }
  }

  function updatePairingHeaderButtons() {
    if (!state.currentBook) return;
    const pairing = state.currentBook.pairing;
    const hasPair = Boolean(pairing && pairing.paired_book_id);
    if (els.btnOpenPairingLabel) {
      els.btnOpenPairingLabel.textContent = hasPair ? "Bilingüe Activo" : "Emparejar EN/ES";
    }
    if (els.btnSwitchPaired) {
      if (hasPair) {
        const partnerIsEs = (pairing.paired_book_lang || "").toLowerCase().startsWith("es");
        els.btnSwitchPaired.textContent = partnerIsEs
          ? "🔄 Ir a versión ES 🇪🇸"
          : "🔄 Ir a versión EN 🇬🇧";
        els.btnSwitchPaired.classList.remove("hidden");
      } else {
        els.btnSwitchPaired.classList.add("hidden");
      }
    }
    syncAudiobookAndMiniPlayerUi();
  }

  function resolvePairedTargetChapter(
    bookObj,
    currentChapterIdx,
    { advancingToNextCycle = false, allowNearestFallback = false } = {}
  ) {
    if (!bookObj) return null;
    const freshBook = state.books.find((b) => b.id === bookObj.id) || bookObj;
    const pairing =
      freshBook.pairing &&
      freshBook.pairing.paired_book_id &&
      freshBook.pairing.chapter_map &&
      Object.keys(freshBook.pairing.chapter_map).length > 0
        ? freshBook.pairing
        : bookObj.pairing || freshBook.pairing;
    if (!pairing || !pairing.paired_book_id) return null;

    const partnerId = pairing.paired_book_id;
    const partnerBook =
      state.books.find((b) => b.id === partnerId) ||
      ((state.offlineBooksMap.get(partnerId) || {}).book) ||
      null;

    let cmap = { ...(pairing.chapter_map || {}) };
    // Completar con el mapa inverso del libro pareja si existiera alguna entrada adicional
    if (partnerBook && partnerBook.pairing && partnerBook.pairing.chapter_map) {
      for (const [pKey, sVal] of Object.entries(partnerBook.pairing.chapter_map)) {
        if (sVal !== undefined && sVal !== null && Number(sVal) >= 0) {
          const sKey = String(Number(sVal));
          if (cmap[sKey] === undefined) {
            cmap[sKey] = Number(pKey);
          }
        }
      }
    }
    // Si aún no hay mapa (ej. libro descargado antiguamente en modo offline), generarlo al vuelo por estructura de capítulos
    if (Object.keys(cmap).length === 0 && partnerBook) {
      const fb = buildClientFallbackPreview(
        freshBook,
        partnerBook,
        state.offlineBooksMap.get(bookObj.id),
        state.offlineBooksMap.get(partnerId)
      );
      if (fb && fb.chapter_map) {
        cmap = { ...fb.chapter_map };
      }
    }

    const hasMap = Object.keys(cmap).length > 0;
    const offset = Number(pairing.chapter_offset || 0);

    if (!advancingToNextCycle) {
      if (hasMap) {
        const direct = cmap[String(currentChapterIdx)];
        if (direct !== undefined && direct !== null && Number(direct) >= 0) {
          return Number(direct);
        }
        // Si es una portadilla muy breve sin pareja (ej: "Part I" de 1 frase), en avance automático pasar primero al siguiente capítulo del mismo libro
        const curSummary = (freshBook.chapters_summary || bookObj.chapters_summary || [])[
          currentChapterIdx
        ];
        if (!allowNearestFallback && curSummary && Number(curSummary.sentence_count || 0) <= 6) {
          return null;
        }
        // Si pulsó el botón manual "Ir a versión ES/EN", buscar el capítulo emparejado más cercano
        for (let delta = 1; delta <= 6; delta++) {
          const nextVal = cmap[String(currentChapterIdx + delta)];
          if (nextVal !== undefined && Number(nextVal) >= 0) return Number(nextVal);
          const prevVal = cmap[String(currentChapterIdx - delta)];
          if (prevVal !== undefined && Number(prevVal) >= 0) return Number(prevVal);
        }
      }
      return currentChapterIdx + offset;
    }

    // Avance tras terminar el capítulo en el 2º idioma -> ir al siguiente capítulo en el 1º idioma
    if (hasMap) {
      const totalCh = Number(freshBook.chapter_count || bookObj.chapter_count || 999);
      for (let nxt = currentChapterIdx + 1; nxt < totalCh; nxt++) {
        const mappedNext = cmap[String(nxt)];
        if (mappedNext !== undefined && mappedNext !== null && Number(mappedNext) >= 0) {
          return Number(mappedNext);
        }
      }
      const curMapped = cmap[String(currentChapterIdx)];
      if (curMapped !== undefined && curMapped !== null && Number(curMapped) >= 0) {
        return Number(curMapped) + 1;
      }
    }
    return currentChapterIdx + offset + 1;
  }

  async function advanceAfterChapterEnd(wasPlaying = false) {
    if (!state.currentBook) return false;
    if (state.currentChapter && state.currentChapter.sentence_count > 0) {
      state.sentenceIndex = Math.max(0, state.currentChapter.sentence_count - 1);
      await saveReadingProgress({ immediate: true });
    }
    const freshBook = state.books.find((b) => b.id === state.currentBook.id) || state.currentBook;
    const pairing = freshBook.pairing || state.currentBook.pairing;

    // Si el libro está emparejado en modo bilingüe con cambio automático de capítulo
    if (pairing && pairing.paired_book_id && pairing.auto_switch_chapters) {
      const isPrimary = state.currentBook.id === pairing.primary_book_id;
      const targetChapterInPartner = resolvePairedTargetChapter(
        state.currentBook,
        state.chapterIndex,
        { advancingToNextCycle: !isPrimary, allowNearestFallback: false }
      );

      const partnerBook =
        state.books.find((b) => b.id === pairing.paired_book_id) ||
        ((state.offlineBooksMap.get(pairing.paired_book_id) || {}).book) ||
        null;
      const partnerMaxCh = partnerBook ? partnerBook.chapter_count : 9999;

      if (
        targetChapterInPartner !== null &&
        targetChapterInPartner >= 0 &&
        targetChapterInPartner < partnerMaxCh
      ) {
        const partnerIsEs = (pairing.paired_book_lang || "").toLowerCase().startsWith("es");
        const langName = partnerIsEs ? "Castellano 🇪🇸" : "Inglés 🇬🇧";
        showToast(
          isPrimary
            ? `🔄 Capítulo terminado: pasando al mismo capítulo en ${langName}...`
            : `🔄 Capítulo completado en ambos idiomas: pasando al siguiente capítulo en ${langName}...`,
          4400
        );
        await openBook(pairing.paired_book_id, {
          overrideChapterIndex: targetChapterInPartner,
          overrideSentenceIndex: 0,
          autoPlay: wasPlaying,
          preferLocal: state.offlineBooksMap.has(pairing.paired_book_id),
          keepViewHidden: Boolean(els.readerView && els.readerView.classList.contains("hidden")),
        });
        return true;
      }
    }

    // Avance normal al siguiente capítulo del mismo libro
    if (state.chapterIndex < state.currentBook.chapter_count - 1) {
      showToast("Pasando al siguiente capítulo...");
      await loadChapter(state.chapterIndex + 1, 0, wasPlaying);
      return true;
    }
    return false;
  }

  function renderToc() {
    els.tocList.innerHTML = "";
    if (!state.currentBook) return;

    for (const ch of state.currentBook.chapters_summary || []) {
      const li = document.createElement("li");
      li.className = `toc-item ${ch.index === state.chapterIndex ? "active" : ""}`;
      const savedSent =
        ch.index === state.chapterIndex
          ? state.sentenceIndex
          : getSavedSentenceForChapter(state.currentBook, ch.index);
      const savedBadge =
        savedSent > 0 ? ` • Frase ${savedSent + 1}/${ch.sentence_count}` : `${ch.sentence_count} fr.`;
      li.innerHTML = `
        <span>${escapeHtml(ch.title)}</span>
        <small>${savedBadge}</small>
      `;
      li.addEventListener("click", async () => {
        els.tocSidebar.classList.add("hidden");
        const wasPlaying = state.isPlaying;
        stopPlayback();
        const targetSent =
          ch.index === state.chapterIndex
            ? 0
            : getSavedSentenceForChapter(state.currentBook, ch.index);
        await loadChapter(ch.index, targetSent, wasPlaying);
      });
      els.tocList.appendChild(li);
    }
  }

  async function loadChapter(chapterIdx, initialSentenceIdx = 0, autoPlay = false) {
    if (!state.currentBook) return;
    try {
      let chapterObj = null;

      // 1. Si el libro ya está guardado en memoria local (RAM o IndexedDB), cargar el capítulo instantáneamente (0 ms)
      let localBundle = state.offlineBooksMap.get(state.currentBook.id) || null;
      if (!localBundle) {
        localBundle = await OfflineStore.getBookBundle(state.currentBook.id);
        if (localBundle) {
          state.offlineBooksMap.set(state.currentBook.id, localBundle);
        }
      }
      if (localBundle && Array.isArray(localBundle.chapters) && localBundle.chapters.length > 0) {
        chapterObj =
          localBundle.chapters.find((c) => Number(c.index) === Number(chapterIdx)) ||
          localBundle.chapters[chapterIdx] ||
          null;
      }

      // 2. Si no está en memoria local, solicitar al servidor con timeout
      if (!chapterObj && !state.isServerOffline) {
        try {
          const res = await fetchWithTimeout(
            `/api/books/${state.currentBook.id}/chapters/${chapterIdx}`,
            {},
            6500
          );
          if (res.ok) {
            const data = await res.json();
            chapterObj = data.chapter;
          }
        } catch (_) {
          await markServerPotentiallyOffline();
        }
      }

      if (!chapterObj) {
        throw new Error(
          "No se pudo cargar el capítulo (descarga primero el libro en '📲 Offline' para leer sin conexión)"
        );
      }

      state.chapterIndex = chapterIdx;
      state.currentChapter = chapterObj;
      const maxSentence = Math.max(0, state.currentChapter.sentence_count - 1);
      state.sentenceIndex =
        initialSentenceIdx === -1
          ? maxSentence
          : Math.min(Math.max(0, initialSentenceIdx), maxSentence);

      els.chapterBadge.textContent = state.currentChapter.title;
      let chapterHtml = state.currentChapter.html || "";
      if (
        chapterIdx === 0 &&
        state.currentBook.cover_url &&
        !chapterHtml.includes("/cover")
      ) {
        const coverSrc = resolveApiUrl(state.currentBook.cover_url);
        const safeBookTitle = escapeHtml(state.currentBook.title || "Portada");
        chapterHtml =
          `<div class="epub-cover-page"><img src="${coverSrc}" class="epub-illustration epub-cover-img" alt="Portada de ${safeBookTitle}" title="Pulsa para ampliar la portada" /></div>` +
          chapterHtml;
      }
      els.chapterContent.innerHTML = chapterHtml;

      const hasBilingualNext = Boolean(
        state.currentBook.pairing &&
          state.currentBook.pairing.paired_book_id &&
          state.currentBook.pairing.auto_switch_chapters
      );
      els.btnPrevChapter.disabled = state.chapterIndex <= 0;
      els.btnNextChapter.disabled =
        !hasBilingualNext && state.chapterIndex >= state.currentBook.chapter_count - 1;

      // Vincular eventos de clic en cada frase del visualizador y guardar HTML original limpio
      els.chapterContent.querySelectorAll(".tts-sentence").forEach((span) => {
        span.dataset.rawHtml = span.innerHTML;
        span.addEventListener("click", (e) => {
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.toString().trim().length > 1) {
            return;
          }
          e.stopPropagation();
          const idx = Number(span.dataset.index);
          if (!Number.isNaN(idx)) {
            jumpToSentence(idx, true);
          }
        });
      });

      applyStudyDecorationsToChapter();

      // Si el capítulo contiene ilustraciones, recalcular paginación cuando carguen y permitir ampliarlas al pulsar
      els.chapterContent.querySelectorAll("img").forEach((img) => {
        if (!img.classList.contains("epub-illustration")) {
          img.classList.add("epub-illustration");
        }
        const rawAttrSrc = img.getAttribute("src") || "";
        if (rawAttrSrc.startsWith("/api/")) {
          img.src = resolveApiUrl(rawAttrSrc);
        }
        if (!img.title) {
          img.title = "Pulsa para ampliar y analizar la imagen";
        }
        img.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openImageLightbox(img);
        });
        img.addEventListener("load", () => {
          if (state.flowMode === "paginated") {
            updatePaginationLayout(true);
            if (
              chapterIdx === 0 &&
              initialSentenceIdx === 0 &&
              !autoPlay &&
              !state.isPlaying &&
              state.currentBook &&
              state.currentBook.cover_url
            ) {
              goToPage(0, { animate: false, syncSentenceIfPaused: false });
            }
          }
        });
      });

      renderToc();
      updatePaginationLayout(true);
      highlightCurrentSentence(true);
      if (
        chapterIdx === 0 &&
        initialSentenceIdx === 0 &&
        !autoPlay &&
        !state.isPlaying &&
        state.currentBook &&
        state.currentBook.cover_url &&
        state.flowMode === "paginated"
      ) {
        goToPage(0, { animate: false, syncSentenceIfPaused: false });
      }
      saveReadingProgress();

      if (autoPlay) {
        startPlayback();
      }
    } catch (err) {
      showToast(`Error cargando capítulo: ${err.message}`);
    }
  }

  // Motor de Paginación Horizontal por Hojas (CSS Multi-Column)
  function updatePaginationLayout(keepCurrentSentencePage = true) {
    const isReaderOpen = els.readerView && !els.readerView.classList.contains("hidden");
    if (!isReaderOpen || state.flowMode !== "paginated" || !els.chapterViewport) {
      els.chapterContent.style.width = "";
      els.chapterContent.style.columnWidth = "";
      els.chapterContent.style.columnCount = "";
      els.chapterContent.style.columnGap = "";
      els.chapterContent.style.transform = "";
      state.pageStride = 0;
      state.totalPages = 1;
      state.currentPage = 0;
      return;
    }

    const rawWidth = els.chapterViewport.clientWidth;
    if (rawWidth <= 0) return;

    const gap = 48;
    const cols = state.columns === 2 && window.innerWidth >= 900 ? 2 : 1;
    const colWidth = cols === 2 ? Math.floor((rawWidth - gap) / 2) : Math.floor(rawWidth);
    const usableWidth = cols === 2 ? 2 * colWidth + gap : colWidth;
    const stride = usableWidth + gap;

    state.pageStride = stride;
    els.chapterContent.style.width = `${usableWidth}px`;
    els.chapterContent.style.columnWidth = `${colWidth}px`;
    els.chapterContent.style.columnCount = String(cols);
    els.chapterContent.style.columnGap = `${gap}px`;

    // Medir el ancho total real ocupado por todas las columnas del capítulo
    const contentRect = els.chapterContent.getBoundingClientRect();
    let maxRight = els.chapterContent.scrollWidth;
    const allSpans = els.chapterContent.querySelectorAll(".tts-sentence");
    if (allSpans.length > 0) {
      const lastSpan = allSpans[allSpans.length - 1];
      const rects = lastSpan.getClientRects();
      const lastRect = rects.length > 0 ? rects[rects.length - 1] : lastSpan.getBoundingClientRect();
      maxRight = Math.max(maxRight, lastRect.right - contentRect.left);
    }

    state.totalPages = Math.max(1, Math.ceil((maxRight - 4) / stride));

    const targetPage = keepCurrentSentencePage
      ? getPageForSentence(state.sentenceIndex)
      : Math.min(state.currentPage, state.totalPages - 1);

    goToPage(targetPage, { animate: false, syncSentenceIfPaused: false });
  }

  function getPageForSentence(sentenceIdx) {
    if (state.flowMode !== "paginated" || !state.pageStride) return 0;
    const span = document.getElementById(`sent-${sentenceIdx}`);
    if (!span) return state.currentPage;
    const contentRect = els.chapterContent.getBoundingClientRect();
    const rects = span.getClientRects();
    const firstRect = rects.length > 0 ? rects[0] : span.getBoundingClientRect();
    const relX = firstRect.left - contentRect.left;
    const page = Math.floor((relX + 4) / state.pageStride);
    return Math.max(0, Math.min(state.totalPages - 1, page));
  }

  function goToPage(pageIdx, { animate = true, syncSentenceIfPaused = false } = {}) {
    if (state.flowMode !== "paginated" || !state.pageStride) return;
    const bounded = Math.max(0, Math.min(state.totalPages - 1, pageIdx));
    state.currentPage = bounded;

    if (!animate) {
      els.chapterContent.style.transition = "none";
    } else {
      els.chapterContent.style.transition = "";
    }
    const offset = bounded * state.pageStride;
    els.chapterContent.style.transform = `translate3d(-${offset}px, 0, 0)`;
    if (!animate) {
      // Forzar reflow para restaurar la transición suave en los siguientes pasos de hoja
      void els.chapterContent.offsetWidth;
      els.chapterContent.style.transition = "";
    }

    const pageText = `Hoja ${bounded + 1} / ${state.totalPages}`;
    if (els.pageCounter) els.pageCounter.textContent = `📖 ${pageText}`;
    updateReaderBottomBookProgress();

    const hasBilingualNext = Boolean(
      state.currentBook &&
        state.currentBook.pairing &&
        state.currentBook.pairing.paired_book_id &&
        state.currentBook.pairing.auto_switch_chapters
    );
    const canGoPrev = bounded > 0 || state.chapterIndex > 0;
    const canGoNext =
      bounded < state.totalPages - 1 ||
      hasBilingualNext ||
      (state.currentBook && state.chapterIndex < state.currentBook.chapter_count - 1);

    if (els.btnPagePrev) els.btnPagePrev.disabled = !canGoPrev;
    if (els.btnPageNext) els.btnPageNext.disabled = !canGoNext;
    if (els.btnFooterPagePrev) els.btnFooterPagePrev.disabled = !canGoPrev;
    if (els.btnFooterPageNext) els.btnFooterPageNext.disabled = !canGoNext;

    // Si el lector está en pausa y el usuario pasa de hoja manualmente, situar el cursor en la 1ª frase de la nueva hoja
    if (syncSentenceIfPaused && !state.isPlaying && state.currentChapter) {
      const contentRect = els.chapterContent.getBoundingClientRect();
      const pageStartX = bounded * state.pageStride - 6;
      const pageEndX = (bounded + 1) * state.pageStride - 6;
      const spans = els.chapterContent.querySelectorAll(".tts-sentence");
      for (const sp of spans) {
        const rects = sp.getClientRects();
        const r = rects.length > 0 ? rects[0] : sp.getBoundingClientRect();
        const relX = r.left - contentRect.left;
        if (relX >= pageStartX && relX < pageEndX) {
          const sIdx = Number(sp.dataset.index);
          if (!Number.isNaN(sIdx)) {
            state.sentenceIndex = sIdx;
            highlightCurrentSentence(false);
            saveReadingProgress();
          }
          break;
        }
      }
    }
  }

  async function turnPage(delta) {
    if (state.flowMode !== "paginated") return;
    hideDictionaryPopover();
    const next = state.currentPage + delta;
    if (next >= 0 && next < state.totalPages) {
      if (
        delta > 0 &&
        !state.isPlaying &&
        state.activeSession &&
        state.currentBook &&
        state.activeSession.bookId === state.currentBook.id
      ) {
        const nowMs = Date.now();
        const prevTurnMs = state.activeSession.lastManualPageTurnMs || state.activeSession.startedAtMs || nowMs;
        const pageElapsedSec = Math.min(45, Math.max(8, (nowMs - prevTurnMs) / 1000));
        state.activeSession.lastManualPageTurnMs = nowMs;
        state.activeSession.manualPagesRead = (state.activeSession.manualPagesRead || 0) + 1;
        state.activeSession.manualReadingSec = (state.activeSession.manualReadingSec || 0) + pageElapsedSec;
      }
      goToPage(next, { animate: true, syncSentenceIfPaused: true });
    } else if (delta > 0) {
      const wasPlaying = state.isPlaying;
      stopPlayback();
      await advanceAfterChapterEnd(wasPlaying);
    } else if (delta < 0 && state.chapterIndex > 0) {
      const wasPlaying = state.isPlaying;
      stopPlayback();
      showToast("Volviendo al capítulo anterior...");
      await loadChapter(state.chapterIndex - 1, -1, wasPlaying);
    }
  }

  function updateReaderBottomBookProgress() {
    if (!state.currentBook) return;
    const stats = computeBookProgressStats(
      state.currentBook,
      state.chapterIndex,
      state.sentenceIndex
    );
    const chTotal = Math.max(1, Number(state.currentBook.chapter_count || 1));
    const chNum = state.chapterIndex + 1;

    const badgeEl = document.getElementById("reader-book-progress-badge");
    if (badgeEl) {
      badgeEl.textContent = `📘 Libro: ${stats.percentStr} leído (Cap. ${chNum}/${chTotal})`;
      badgeEl.title = `Has leído ${stats.percentStr} del libro completo (${stats.sentencesRead} de ${stats.totalSentences} frases • Capítulo ${chNum} de ${chTotal})`;
    }

    if (els.paginationFooterLabel) {
      els.paginationFooterLabel.textContent = `Hoja ${state.currentPage + 1} de ${state.totalPages} • 📘 ${stats.percentStr} del libro`;
    }

    const chFooterPctEl = document.getElementById("chapter-footer-book-pct");
    if (chFooterPctEl) {
      chFooterPctEl.textContent = `📘 ${stats.percentStr} del libro leído (Cap. ${chNum} de ${chTotal})`;
    }
  }

  // Resalta la frase actual en el visualizador y hace scroll suave o pasa de hoja automáticamente
  function highlightCurrentSentence(forceScroll = false) {
    if (!state.currentChapter) return;
    const total = state.currentChapter.sentence_count;
    const idx = state.sentenceIndex;

    els.sentenceCounter.textContent = `Frase ${total > 0 ? idx + 1 : 0} de ${total}`;
    const pct = total > 0 ? ((idx + 1) / total) * 100 : 0;
    els.playerProgressFill.style.width = `${pct.toFixed(1)}%`;
    updateReaderBottomBookProgress();

    const allSpans = els.chapterContent.querySelectorAll(".tts-sentence");
    allSpans.forEach((sp) => {
      const sIdx = Number(sp.dataset.index);
      sp.classList.toggle("active-sentence", sIdx === idx);
      sp.classList.toggle("read-sentence", sIdx < idx);
    });

    const activeSpan = document.getElementById(`sent-${idx}`);
    const isReadingVisible =
      els.readerView &&
      !els.readerView.classList.contains("hidden") &&
      state.readerUiMode !== "audiobook";
    if (activeSpan) {
      els.activeSentencePreview.textContent = activeSpan.textContent;
      if (isReadingVisible) {
        if (state.flowMode === "paginated") {
          if (state.autoScroll || forceScroll) {
            const targetPage = getPageForSentence(idx);
            if (targetPage !== state.currentPage || forceScroll) {
              goToPage(targetPage, { animate: !forceScroll, syncSentenceIfPaused: false });
            }
          }
        } else if (state.autoScroll || forceScroll) {
          activeSpan.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }
      }
    } else {
      const txt = getSentenceText(idx);
      if (txt) els.activeSentencePreview.textContent = txt;
    }
    syncAudiobookAndMiniPlayerUi();
  }

  function getSentenceText(index) {
    if (!state.currentChapter || !state.currentChapter.sentences) return "";
    const item = state.currentChapter.sentences[index];
    return item ? item.text : "";
  }

  function makeAudioCacheKey(text, voiceId, speed) {
    return `${voiceId}|${speed}|${text}`;
  }

  // Caché en memoria del paquete de audio offline del capítulo actual
  let cachedLocalChapterPack = null;

  // Pre-solicita al almacén local (IndexedDB) o al servidor el audio WAV de una frase y devuelve su Blob URL
  function fetchSentenceAudioUrl(sentenceIdx, { isPrefetch = false } = {}) {
    const text = getSentenceText(sentenceIdx);
    if (!text) return Promise.resolve(null);

    const bookId = state.currentBook ? state.currentBook.id : "";
    const chIdx = state.chapterIndex;
    const voiceId = state.selectedVoice;
    const spd = state.speed;
    const gapMode = getEffectiveSentenceGapMode();

    const key = `${bookId}|${chIdx}|${sentenceIdx}|${gapMode}|${makeAudioCacheKey(text, voiceId, spd)}`;
    if (audioBlobCache.has(key)) {
      return audioBlobCache.get(key);
    }

    const promise = (async () => {
      // 1. Comprobar primero si el audio de este capítulo y voz está guardado en la memoria local (IndexedDB)
      let hadPartialLocalChapter = false;
      let localSavedCount = 0;
      const chTotalSents = (state.currentChapter && state.currentChapter.sentence_count) || 0;

      if (bookId) {
        const expectedPackKey = `${bookId}|${voiceId}|${Number(spd).toFixed(2)}|${chIdx}`;
        if (!cachedLocalChapterPack || cachedLocalChapterPack.key !== expectedPackKey) {
          const packFromIdb = await OfflineStore.getChapterAudioPack(bookId, voiceId, spd, chIdx);
          if (packFromIdb) {
            cachedLocalChapterPack = packFromIdb;
          }
        }
        if (
          cachedLocalChapterPack &&
          cachedLocalChapterPack.key === expectedPackKey &&
          cachedLocalChapterPack.sentences_b64
        ) {
          if (cachedLocalChapterPack.sentences_b64[String(sentenceIdx)]) {
            return OfflineStore.base64ToBlobUrl(
              cachedLocalChapterPack.sentences_b64[String(sentenceIdx)]
            );
          }
          localSavedCount = Object.keys(cachedLocalChapterPack.sentences_b64).length;
          if (localSavedCount > 0) {
            hadPartialLocalChapter = true;
          }
        }
      }

      // 2. Si no está en IndexedDB local, solicitar al servidor
      const requestBody = JSON.stringify({
        text,
        voice_id: voiceId,
        speed: spd,
        book_id: bookId || null,
        chapter_index: chIdx,
        sentence_index: sentenceIdx,
      });

      let res;
      try {
        res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        });
      } catch (firstErr) {
        // Si es una precarga en segundo plano (prefetch) que Android abortó al bloquear pantalla o saturar GPU,
        // NUNCA marcar el servidor como desconectado (Modo Local).
        if (isPrefetch) {
          throw firstErr;
        }
        // Para la frase activa en reproducción, reintentar una vez tras 450 ms antes de comprobar si el servidor cayó
        await new Promise((r) => setTimeout(r, 450));
        try {
          res = await fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
          });
        } catch (netErr) {
          await markServerPotentiallyOffline();
          if (hadPartialLocalChapter) {
            throw new Error(
              `Descarga local incompleta en Cap. ${chIdx + 1} (cortada en frase ${localSavedCount} de ${chTotalSents}) y sin conexión al servidor. Pulsa «📲 Offline → ▶️ Continuar descarga» con Wi-Fi.`
            );
          }
          if (bookId && state.offlineBooksMap.has(bookId)) {
            throw new Error(
              `El Capítulo ${chIdx + 1} no tiene audio descargado en la memoria local de este dispositivo y no hay conexión con el servidor. Descárgalo en «📲 Offline».`
            );
          }
          throw new Error(
            `Sin conexión con el servidor (${state.serverUrl}) al solicitar Cap. ${chIdx + 1}, Frase ${sentenceIdx + 1}.`
          );
        }
      }

      if (!res.ok) {
        let msg = `Error sintetizando voz (Cap. ${chIdx + 1}, Frase ${sentenceIdx + 1})`;
        try {
          const errData = await res.json();
          msg = errData.detail || msg;
        } catch (_) {}
        throw new Error(msg);
      }
      const arrBuf = await res.arrayBuffer();
      return createTrimmedWavBlobUrl(new Uint8Array(arrBuf), gapMode);
    })().catch((err) => {
      audioBlobCache.delete(key);
      throw err;
    });

    audioBlobCache.set(key, promise);
    // Limitar tamaño del mapa en el navegador
    if (audioBlobCache.size > 100) {
      const oldestKey = audioBlobCache.keys().next().value;
      const oldPromise = audioBlobCache.get(oldestKey);
      if (oldPromise) {
        oldPromise.then((url) => url && URL.revokeObjectURL(url)).catch(() => {});
      }
      audioBlobCache.delete(oldestKey);
    }
    return promise;
  }

  // Pre-carga las siguientes frases en segundo plano para transición instantánea incluso con pantalla apagada en Android
  function prefetchNextSentences(fromIndex) {
    if (state.selectedVoice.startsWith("browser:")) return;
    if (!state.currentChapter) return;
    const maxIdx = state.currentChapter.sentence_count - 1;
    const lookahead = 6;
    for (let offset = 1; offset <= lookahead; offset++) {
      const target = fromIndex + offset;
      if (target <= maxIdx) {
        fetchSentenceAudioUrl(target, { isPrefetch: true }).catch(() => {});
      }
    }
  }

  function updatePlayerUiState() {
    els.iconPlay.classList.toggle("hidden", state.isPlaying || state.isLoadingAudio);
    els.iconPause.classList.toggle("hidden", !state.isPlaying || state.isLoadingAudio);
    els.iconLoading.classList.toggle("hidden", !state.isLoadingAudio);

    els.statusIndicator.classList.toggle("playing", state.isPlaying && !state.isLoadingAudio);
    els.statusIndicator.classList.toggle("loading", state.isLoadingAudio);

    if (state.isLoadingAudio) {
      els.statusText.style.color = "";
      els.statusIndicator.style.background = "";
      els.statusText.textContent = "Cargando audio de la frase...";
    } else if (state.isPlaying) {
      els.statusText.style.color = "";
      els.statusIndicator.style.background = "";
      const vObj = state.voices.find((v) => v.id === state.selectedVoice);
      const vLabel = vObj ? vObj.name : state.selectedVoice;
      els.statusText.textContent = `Leyendo en voz alta • ${vLabel}`;
    } else if (state.lastPlaybackErrorReason) {
      els.statusText.style.color = "#f59e0b";
      els.statusIndicator.style.background = "#ef4444";
      els.statusText.textContent = `⚠️ ${state.lastPlaybackErrorReason}`;
    } else {
      els.statusText.style.color = "";
      els.statusIndicator.style.background = "";
      els.statusText.textContent = "En pausa — Pulsa en cualquier frase o en Play";
    }

    updateMediaSessionMetadata();
    syncAudiobookAndMiniPlayerUi();
  }

  async function startPlayback() {
    if (!state.currentChapter || state.currentChapter.sentence_count === 0) return;

    evaluateCarBluetoothConnection({ notifyChange: false }).catch(() => {});
    state.lastPlaybackErrorReason = "";
    state.isPlaying = true;
    const sessionId = ++state.playSessionId;
    startBackgroundKeepAlive();
    highlightCurrentSentence();
    updatePlayerUiState();

    await playCurrentSentenceLoop(sessionId);
  }

  function stopPlayback(errorReason = "") {
    state.isPlaying = false;
    state.isLoadingAudio = false;
    if (errorReason) {
      state.lastPlaybackErrorReason = errorReason;
    }
    state.playSessionId++;
    if (!state.isDownloadingOffline) {
      stopBackgroundKeepAlive();
    }
    standbyPreparedUrl = null;
    for (const audioEl of audioPool) {
      try {
        audioEl.pause();
        audioEl.removeAttribute("src");
      } catch (_) {}
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    updatePlayerUiState();
  }

  /**
   * Prepara en segundo plano el canal de audio alternativo (Standby) con la siguiente frase
   * mientras la frase actual se está reproduciendo. Así el decodificador de Android/Bluetooth A2DP
   * ya tiene el recurso abierto y listo en RAM cuando termina la frase actual.
   */
  function prewarmNextSentenceOnStandby(nextSentenceIdx, sessionId) {
    if (!state.currentChapter || state.selectedVoice.startsWith("browser:")) return;
    if (nextSentenceIdx > state.currentChapter.sentence_count - 1) return;

    fetchSentenceAudioUrl(nextSentenceIdx)
      .then((nextUrl) => {
        if (!nextUrl || !state.isPlaying || sessionId !== state.playSessionId) return;
        const standbyEl = audioPool[1 - activeAudioIdx];
        if (standbyPreparedUrl !== nextUrl) {
          standbyPreparedUrl = nextUrl;
          standbyEl.src = nextUrl;
          standbyEl.preservesPitch = true;
          standbyEl.playbackRate =
            state.selectedVoice === "audiobook:original" ? Number(state.speed || 1.0) : 1.0;
          try {
            standbyEl.load();
          } catch (_) {}
        }
      })
      .catch(() => {});
  }

  async function playCurrentSentenceLoop(sessionId) {
    while (state.isPlaying && sessionId === state.playSessionId) {
      const text = getSentenceText(state.sentenceIndex);
      if (!text) break;

      highlightCurrentSentence();
      saveReadingProgress();
      prefetchNextSentences(state.sentenceIndex);

      let sentencePlayStartMs = Date.now();
      try {
        if (state.selectedVoice.startsWith("browser:")) {
          sentencePlayStartMs = Date.now();
          await speakWithBrowserTTS(text, state.selectedVoice.split(":")[1], state.speed, sessionId);
        } else {
          // Solo mostrar estado "Cargando..." si la promesa aún no está resuelta o pre-cargada en standby
          const currentIdx = state.sentenceIndex;
          const audioPromise = fetchSentenceAudioUrl(currentIdx);
          let resolvedSyncUrl = null;
          if (standbyPreparedUrl) {
            resolvedSyncUrl = await Promise.race([audioPromise, Promise.resolve("__PENDING__")]);
          }
          if (!resolvedSyncUrl || resolvedSyncUrl === "__PENDING__") {
            state.isLoadingAudio = true;
            updatePlayerUiState();
          }
          const audioUrl =
            resolvedSyncUrl && resolvedSyncUrl !== "__PENDING__" ? resolvedSyncUrl : await audioPromise;
          if (!state.isPlaying || sessionId !== state.playSessionId) return;

          if (state.isLoadingAudio) {
            state.isLoadingAudio = false;
            updatePlayerUiState();
          }
          // Pre-calentar en el canal alternativo la frase N+1 mientras suena la frase N
          prewarmNextSentenceOnStandby(currentIdx + 1, sessionId);
          sentencePlayStartMs = Date.now();
          await playAudioElement(audioUrl, sessionId);
        }
      } catch (err) {
        if (sessionId !== state.playSessionId) return;
        console.error("Error reproduciendo frase:", err);
        const reasonMsg = err && err.message ? err.message : "Error desconocido al reproducir la frase";
        showToast(`⚠️ ${reasonMsg}`, 9500);
        stopPlayback(reasonMsg);
        return;
      }

      if (!state.isPlaying || sessionId !== state.playSessionId) return;

      if (state.activeSession && state.currentBook && state.activeSession.bookId === state.currentBook.id) {
        const sentenceAudioSec = Math.min(25, Math.max(0.5, (Date.now() - sentencePlayStartMs) / 1000));
        state.activeSession.audioActiveSec = (state.activeSession.audioActiveSec || 0) + sentenceAudioSec;
        state.activeSession.sentencesRead = (state.activeSession.sentencesRead || 0) + 1;
      }

      // Avanzar a la siguiente frase, o alternar al capítulo emparejado (EN↔ES) / siguiente capítulo
      if (state.sentenceIndex < state.currentChapter.sentence_count - 1) {
        state.sentenceIndex++;
      } else {
        if (state.sleepTimerMode === "chapter") {
          clearSleepTimer();
          await saveReadingProgress({ immediate: true });
          showToast("🌙 Fin de capítulo alcanzado — Reproducción detenida", 5000);
          stopPlayback();
          return;
        }
        const switchedBookOrChapter = await advanceAfterChapterEnd(true);
        if (!switchedBookOrChapter) {
          if (state.currentBook) {
            state.currentBook.reading_status = "completed";
            const libBook = state.books.find((b) => b.id === state.currentBook.id);
            if (libBook) libBook.reading_status = "completed";
            fetch(`/api/books/${encodeURIComponent(state.currentBook.id)}/study/meta`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reading_status: "completed" }),
            }).catch(() => {});
            updateReaderBottomBookProgress();
            renderLibrary();
          }
          showToast("🎉 ¡Has llegado al final del libro! Marcado como Terminado (100%)");
          stopPlayback();
        }
        return;
      }
    }
  }

  function playAudioElement(blobUrl, sessionId) {
    return new Promise((resolve, reject) => {
      if (!blobUrl || sessionId !== state.playSessionId) {
        resolve();
        return;
      }

      // Si el canal standby ya tiene pre-cargada exactamente esta URL, conmutar a ese canal al instante (Ping-Pong)
      const standbyIdx = 1 - activeAudioIdx;
      if (standbyPreparedUrl === blobUrl && audioPool[standbyIdx].src) {
        activeAudioIdx = standbyIdx;
        standbyPreparedUrl = null;
      }

      const player = audioPool[activeAudioIdx];
      const rate = state.selectedVoice === "audiobook:original" ? Number(state.speed || 1.0) : 1.0;

      if (player.src !== blobUrl) {
        player.src = blobUrl;
      }
      player.preservesPitch = true;
      player.playbackRate = rate;

      let settled = false;
      let earlyTimer = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      // En Modo Bluetooth Coche ("car"), adelantamos el disparo del siguiente canal ~135ms antes del evento 'ended'
      // para evitar que el buffer A2DP del coche se vacíe y entre en suspensión entre frase y frase
      const effectiveGapMode = getEffectiveSentenceGapMode();
      const scheduleEarlyBluetoothHandover = () => {
        if (settled || effectiveGapMode !== "car") return;
        const dur = player.duration;
        const cur = player.currentTime;
        if (!Number.isFinite(dur) || dur <= 0.35) return;
        const remainingMs = ((dur - cur) / Math.max(0.5, rate)) * 1000;
        const leadHandoverMs = 135;
        if (remainingMs <= leadHandoverMs) {
          finish();
        } else if (remainingMs <= 480 && !earlyTimer) {
          earlyTimer = setTimeout(() => {
            earlyTimer = null;
            finish();
          }, Math.max(8, remainingMs - leadHandoverMs));
        }
      };

      const onEnded = () => {
        finish();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("No se pudo reproducir el flujo de audio WAV"));
      };
      const cleanup = () => {
        if (earlyTimer) {
          clearTimeout(earlyTimer);
          earlyTimer = null;
        }
        player.removeEventListener("ended", onEnded);
        player.removeEventListener("error", onError);
        player.removeEventListener("timeupdate", scheduleEarlyBluetoothHandover);
      };

      player.addEventListener("ended", onEnded);
      player.addEventListener("error", onError);
      if (effectiveGapMode === "car") {
        player.addEventListener("timeupdate", scheduleEarlyBluetoothHandover);
      }
      player.play().catch((err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
    });
  }

  function speakWithBrowserTTS(text, langCode, speed, sessionId) {
    return new Promise((resolve, reject) => {
      if (!("speechSynthesis" in window)) {
        reject(new Error("Tu navegador no soporta Web Speech API"));
        return;
      }
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = langCode;
      utter.rate = speed;
      utter.onend = () => resolve();
      utter.onerror = (e) => {
        if (e.error === "interrupted" || e.error === "canceled" || sessionId !== state.playSessionId) {
          resolve();
        } else {
          reject(new Error(`Error Web Speech: ${e.error}`));
        }
      };
      window.speechSynthesis.speak(utter);
    });
  }

  function jumpToSentence(newIndex, shouldPlay = null) {
    if (!state.currentChapter) return;
    const bounded = Math.min(
      Math.max(0, newIndex),
      Math.max(0, state.currentChapter.sentence_count - 1)
    );
    const playAfter = shouldPlay !== null ? shouldPlay : state.isPlaying;
    stopPlayback();
    state.sentenceIndex = bounded;
    highlightCurrentSentence();
    saveReadingProgress();
    if (playAfter) {
      startPlayback();
    }
  }

  // Guardar progreso en el servidor y en la memoria local IndexedDB para sincronizar entre Windows y Android (con y sin conexión)
  const progressTimeoutsByBook = new Map();
  async function saveReadingProgress({ immediate = false } = {}) {
    if (!state.currentBook) return;
    const targetBookId = state.currentBook.id;
    const nowSec = Math.floor(Date.now() / 1000);
    const prevProg = state.currentBook.progress || {};
    const chPositions = {
      ...(prevProg.chapter_positions || {}),
      [String(state.chapterIndex)]: Math.max(0, Number(state.sentenceIndex || 0)),
    };
    const progPayload = {
      chapter_index: state.chapterIndex,
      sentence_index: state.sentenceIndex,
      voice_id: state.selectedVoice,
      speed: state.speed,
      chapter_positions: chPositions,
    };
    state.currentBook.progress = {
      ...prevProg,
      ...progPayload,
      updated_at: nowSec,
      last_read_at: nowSec,
      dirty_offline: Boolean(state.isServerOffline),
    };
    state.currentBook.last_read_at = nowSec;
    state.currentBook.updated_at = nowSec;
    const libBook = state.books.find((b) => b.id === targetBookId);
    if (libBook) {
      libBook.progress = state.currentBook.progress;
      libBook.last_read_at = nowSec;
      libBook.updated_at = nowSec;
    }
    const memBundle = state.offlineBooksMap.get(targetBookId);
    if (memBundle && memBundle.book) {
      memBundle.book.progress = state.currentBook.progress;
    }
    try {
      localStorage.setItem("vozlectura_catalog_cache", JSON.stringify(state.books));
    } catch (_) {}
    OfflineStore.updateBookProgress(targetBookId, state.currentBook.progress, {
      dirtyOffline: Boolean(state.isServerOffline),
    });

    const existingTimer = progressTimeoutsByBook.get(targetBookId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      progressTimeoutsByBook.delete(targetBookId);
    }

    const sendToServer = async () => {
      if (state.isServerOffline) return;
      try {
        const res = await fetch(`/api/books/${targetBookId}/progress`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(progPayload),
        });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data && data.progress) {
            const srvUpd = Number(data.progress.updated_at || nowSec);
            if (state.currentBook && state.currentBook.id === targetBookId && state.currentBook.progress) {
              state.currentBook.progress.updated_at = srvUpd;
              state.currentBook.progress.last_read_at = srvUpd;
              state.currentBook.progress.dirty_offline = false;
            }
            if (libBook && libBook.progress) {
              libBook.progress.updated_at = srvUpd;
              libBook.progress.last_read_at = srvUpd;
              libBook.progress.dirty_offline = false;
            }
            OfflineStore.updateBookProgress(
              targetBookId,
              {
                ...progPayload,
                updated_at: srvUpd,
                last_read_at: srvUpd,
              },
              { dirtyOffline: false }
            );
          }
        }
      } catch (_) {
        OfflineStore.updateBookProgress(
          targetBookId,
          { ...progPayload, updated_at: nowSec, last_read_at: nowSec },
          { dirtyOffline: true }
        );
      }
    };

    if (immediate) {
      await sendToServer();
    } else {
      const tId = setTimeout(() => {
        progressTimeoutsByBook.delete(targetBookId);
        sendToServer();
      }, 450);
      progressTimeoutsByBook.set(targetBookId, tId);
    }
  }

  // Integración con controles de pantalla de bloqueo en Android / Windows Media Keys / Bluetooth Coche (AVRCP)
  function updateMediaSessionMetadata() {
    if (!("mediaSession" in navigator) || !state.currentBook) return;
    const chTitle = state.currentChapter ? state.currentChapter.title : state.currentBook.title;
    const metaKey = `${state.currentBook.id}|${state.chapterIndex}|${chTitle}`;

    // IMPORTANTE para Bluetooth del coche (AVRCP):
    // No recrear MediaMetadata en cada frase, ya que la pantalla del coche interpreta cada `new MediaMetadata`
    // como un cambio de canción/pista y silencia el canal Bluetooth A2DP durante 150-300ms entre frase y frase.
    const metaChanged = metaKey !== lastMediaSessionKey;
    if (metaChanged) {
      lastMediaSessionKey = metaKey;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chTitle,
        artist: state.currentBook.author,
        album: state.currentBook.title,
      });
    }

    const desiredState = state.isPlaying ? "playing" : "paused";
    if (navigator.mediaSession.playbackState !== desiredState) {
      navigator.mediaSession.playbackState = desiredState;
    }

    const now = Date.now();
    if (
      "setPositionState" in navigator.mediaSession &&
      state.currentChapter &&
      state.currentChapter.sentence_count > 0 &&
      (metaChanged || !state.isPlaying || now - lastMediaPositionUpdateAt > 12000)
    ) {
      lastMediaPositionUpdateAt = now;
      try {
        const total = Math.max(1, state.currentChapter.sentence_count);
        const pos = Math.min(total, Math.max(0, state.sentenceIndex));
        navigator.mediaSession.setPositionState({
          duration: total * 4,
          playbackRate: 1.0,
          position: pos * 4,
        });
      } catch (_) {}
    }
  }

  function setupMediaSessionHandlers() {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => startPlayback());
    navigator.mediaSession.setActionHandler("pause", () => stopPlayback());
    navigator.mediaSession.setActionHandler("previoustrack", () => {
      jumpToSentence(state.sentenceIndex - 1);
    });
    navigator.mediaSession.setActionHandler("nexttrack", () => {
      jumpToSentence(state.sentenceIndex + 1);
    });
  }

  // Gestor de Cola Global de Conversión M4B / EPUB 3 Media Overlay y Caché Permanente
  let exportPollTimer = null;

  async function openExportsModal(bookObj = null) {
    if (state.books.length === 0) {
      await fetchLibrary();
    }
    const target = bookObj || state.currentBook || state.books[0] || null;
    state.exportTargetBook = target;

    // Rellenar selector de libros del modal de conversión
    if (els.exportBookSelect) {
      els.exportBookSelect.innerHTML = "";
      if (state.books.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "— No hay libros en la biblioteca —";
        els.exportBookSelect.appendChild(opt);
      } else {
        for (const b of state.books) {
          const opt = document.createElement("option");
          opt.value = b.id;
          const flag = (b.language || "").startsWith("es") ? "🇪🇸" : "🇬🇧";
          opt.textContent = `📚 ${flag} ${b.title} (${b.total_sentences} frases)`;
          els.exportBookSelect.appendChild(opt);
        }
        if (target) {
          els.exportBookSelect.value = target.id;
        }
      }
    }

    syncExportVoiceSelectorForBook(target);

    els.exportsModal.classList.remove("hidden");
    await refreshExportsStatus();
  }

  function syncExportVoiceSelectorForBook(bookObj) {
    els.exportVoiceSelect.innerHTML = "";
    for (const v of state.voices) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = `${getEngineBadgeLabel(v)} ${v.name}`;
      els.exportVoiceSelect.appendChild(opt);
    }
    const preferredVoice =
      (bookObj && bookObj.progress && bookObj.progress.voice_id) || state.selectedVoice;
    if (
      preferredVoice &&
      !preferredVoice.startsWith("browser:") &&
      [...els.exportVoiceSelect.options].some((o) => o.value === preferredVoice)
    ) {
      els.exportVoiceSelect.value = preferredVoice;
    }
  }

  function closeExportsModal() {
    els.exportsModal.classList.add("hidden");
  }

  function updateGlobalQueueBadgesAndBanner(queueData) {
    if (!queueData) return;
    const activeJobs = queueData.active_jobs || [];
    const items = queueData.items || [];
    const pendingOrActiveCount = items.filter(
      (it) => it.is_running || (!it.m4b_ready && !it.epub_overlay_ready)
    ).length;

    if (els.libraryQueueCount) {
      els.libraryQueueCount.textContent = String(items.length);
    }

    if (els.exportsQueueBadge) {
      if (activeJobs.length > 0) {
        els.exportsQueueBadge.textContent = `⚡ ${activeJobs.length}`;
        els.exportsQueueBadge.classList.add("active-running");
        els.exportsQueueBadge.classList.remove("hidden");
      } else if (pendingOrActiveCount > 0) {
        els.exportsQueueBadge.textContent = String(pendingOrActiveCount);
        els.exportsQueueBadge.classList.remove("active-running");
        els.exportsQueueBadge.classList.remove("hidden");
      } else if (items.length > 0) {
        els.exportsQueueBadge.textContent = String(items.length);
        els.exportsQueueBadge.classList.remove("active-running");
        els.exportsQueueBadge.classList.remove("hidden");
      } else {
        els.exportsQueueBadge.classList.add("hidden");
      }
    }

    if (els.libraryQueueBanner) {
      if (activeJobs.length > 0) {
        const j = activeJobs[0];
        els.libraryQueueBanner.classList.remove("hidden");
        if (els.libraryQueueTitle) {
          els.libraryQueueTitle.textContent = `⚡ Convirtiendo: ${j.book_title || j.book_id} — ${j.voice_name} (${j.percent || 0}%)`;
        }
        if (els.libraryQueueSubtitle) {
          els.libraryQueueSubtitle.textContent = `${j.phase || "Codificando..."} • Frase ${j.processed_sentences || 0} de ${j.total_sentences || 0}`;
        }
        if (els.libraryQueueBarFill) {
          els.libraryQueueBarFill.style.width = `${j.percent || 0}%`;
        }
      } else {
        els.libraryQueueBanner.classList.add("hidden");
      }
    }
  }

  async function refreshExportsStatus() {
    clearTimeout(exportPollTimer);
    if (state.isServerOffline) return;

    try {
      const res = await fetchWithTimeout("/api/exports/queue", {}, 2400);
      if (!res.ok) return;
      const data = await res.json();

      updateGlobalQueueBadgesAndBanner(data);

      const allActive = data.active_jobs || [];
      const allItems = data.items || [];
      const isModalOpen = els.exportsModal && !els.exportsModal.classList.contains("hidden");

      if (isModalOpen) {
        const selectedBookId = els.exportBookSelect
          ? els.exportBookSelect.value
          : state.exportTargetBook
          ? state.exportTargetBook.id
          : "";
        state.exportTargetBook =
          state.books.find((b) => b.id === selectedBookId) || state.exportTargetBook;

        const jobForSelected =
          allActive.find((j) => j.book_id === selectedBookId) || allActive[0] || null;

        if (jobForSelected && jobForSelected.status === "running") {
          els.exportJobBox.classList.remove("hidden");
          els.exportJobPhase.textContent = `${jobForSelected.book_title || ""}: ${jobForSelected.phase || "Codificando..."}`;
          els.exportJobPct.textContent = `${jobForSelected.percent || 0}%`;
          els.exportBarFill.style.width = `${jobForSelected.percent || 0}%`;
          els.exportJobCounts.textContent = `Frase ${jobForSelected.processed_sentences || 0} / ${jobForSelected.total_sentences || 0} • ${jobForSelected.voice_name}`;
          if (els.btnCancelExport) {
            els.btnCancelExport.dataset.book = jobForSelected.book_id || "";
          }
          if (els.btnDeleteActiveExport) {
            els.btnDeleteActiveExport.dataset.book = jobForSelected.book_id || "";
            els.btnDeleteActiveExport.dataset.vhash = jobForSelected.voice_hash || "";
          }
          els.btnStartExport.disabled = jobForSelected.book_id === selectedBookId;
        } else {
          els.btnStartExport.disabled = !selectedBookId;
          els.exportJobBox.classList.add("hidden");
        }

        const filterOnlySelected =
          els.chkExportFilterBook && els.chkExportFilterBook.checked && selectedBookId;
        const filteredItems = filterOnlySelected
          ? allItems.filter((it) => it.book_id === selectedBookId)
          : allItems;

        renderGlobalExportsQueueList(filteredItems);
      }

      if (allActive.length > 0) {
        exportPollTimer = setTimeout(refreshExportsStatus, 1400);
      }
    } catch (err) {
      console.error("Error consultando cola de conversiones:", err);
    }
  }

  function renderGlobalExportsQueueList(itemsArr) {
    els.exportsList.innerHTML = "";

    if (itemsArr.length === 0) {
      els.exportsList.innerHTML = `
        <div class="model-row">
          <div class="model-info">
            <h4>La cola de conversión está vacía</h4>
            <p>Selecciona un libro y una voz arriba y pulsa "Iniciar conversión" para generar un audiolibro M4B o un EPUB con Media Overlays.</p>
          </div>
        </div>
      `;
      return;
    }

    for (const item of itemsArr) {
      const row = document.createElement("div");
      row.className = "model-row";
      if (item.is_running) {
        row.style.borderColor = "var(--accent)";
      }

      const totalSentences = item.total_sentences || 0;
      const pctCached =
        totalSentences > 0
          ? Math.min(100, Math.round((item.cached_sentences / totalSentences) * 100))
          : item.percent || 0;

      const btnsHtml = [];
      if (item.m4b_ready && item.m4b_url) {
        btnsHtml.push(
          `<a href="${item.m4b_url}" download class="primary-btn" style="text-decoration:none;padding:6px 11px;font-size:0.78rem">⬇️ M4B (${item.m4b_size_mb} MB)</a>`
        );
      }
      if (item.epub_overlay_ready && item.epub_overlay_url) {
        btnsHtml.push(
          `<a href="${item.epub_overlay_url}" download class="secondary-btn" style="text-decoration:none;padding:6px 11px;font-size:0.78rem">⬇️ EPUB Media Overlay (${item.epub_size_mb} MB)</a>`
        );
      }

      if (item.is_running) {
        btnsHtml.push(
          `<span class="badge-pill" style="color:var(--accent);border-color:var(--accent)">⚡ Codificando (${pctCached}%)</span>`
        );
        btnsHtml.push(
          `<button class="secondary-btn btn-pause-other-job" data-book="${item.book_id}" style="padding:6px 10px;font-size:0.78rem">⏸ Pausar</button>`
        );
      } else if (!item.m4b_ready && !item.epub_overlay_ready) {
        btnsHtml.push(`<span class="badge-pill">En pausa / Parcial (${pctCached}%)</span>`);
        if (item.voice_id && item.voice_id.includes(":")) {
          btnsHtml.push(
            `<button class="secondary-btn btn-resume-export-row" data-book="${item.book_id}" data-voice="${escapeHtml(item.voice_id)}" data-speed="${item.speed || 1.0}" title="Reanudar esta conversión desde el ${pctCached}%" style="padding:6px 10px;font-size:0.78rem">▶️ Continuar</button>`
          );
        }
      }

      btnsHtml.push(
        `<button class="delete-book-btn btn-del-export-row" data-book="${item.book_id}" data-vhash="${item.voice_hash}" data-name="${escapeHtml(item.book_title)} — ${escapeHtml(item.voice_name)}" title="Cancelar y eliminar esta conversión del disco" style="padding:6px 10px;font-size:0.78rem;font-weight:600">🗑 ${item.is_running || (!item.m4b_ready && !item.epub_overlay_ready) ? "Cancelar" : "Borrar"}</button>`
      );

      row.innerHTML = `
        <div class="model-info">
          <h4>📚 <strong>${escapeHtml(item.book_title || item.book_id)}</strong> • 🎙️ ${escapeHtml(item.voice_name)} <small style="color:var(--text-secondary)">(${item.speed}×)</small></h4>
          <p>💾 Caché en disco: <strong>${item.cached_sentences} / ${totalSentences} frases (${pctCached}%)</strong> — 0% uso CPU/GPU al reproducir</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${btnsHtml.join("")}
        </div>
      `;
      els.exportsList.appendChild(row);
    }

    // Eventos de pausar, reanudar y cancelar/eliminar cada fila de la cola global
    els.exportsList.querySelectorAll(".btn-pause-other-job").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const bId = btn.dataset.book;
        try {
          await fetch(`/api/books/${bId}/exports/cancel`, { method: "POST" });
          showToast("Pausando conversión tras la frase actual...");
          await refreshExportsStatus();
        } catch (_) {}
      });
    });

    els.exportsList.querySelectorAll(".btn-resume-export-row").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const bId = btn.dataset.book;
        const vid = btn.dataset.voice;
        const spd = Number(btn.dataset.speed) || 1.0;
        if (els.exportBookSelect && bId) {
          els.exportBookSelect.value = bId;
          state.exportTargetBook = state.books.find((b) => b.id === bId) || state.exportTargetBook;
        }
        els.exportVoiceSelect.value = vid;
        els.exportSpeedSelect.value = String(spd);
        els.btnStartExport.click();
      });
    });

    els.exportsList.querySelectorAll(".btn-del-export-row").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const bId = btn.dataset.book;
        const vhash = btn.dataset.vhash;
        const vname = btn.dataset.name || vhash;
        if (
          !confirm(
            `¿Cancelar y eliminar la conversión/caché de "${vname}"?\nSe detendrá inmediatamente y se borrarán sus archivos.`
          )
        ) {
          return;
        }
        btn.disabled = true;
        try {
          const res = await fetch(
            `/api/books/${encodeURIComponent(bId)}/exports/${encodeURIComponent(vhash)}`,
            { method: "DELETE" }
          );
          const data = await res.json();
          showToast(`Conversión cancelada y eliminada (${data.freed_mb || 0} MB liberados)`);
          await refreshExportsStatus();
        } catch (err) {
          showToast("No se pudo eliminar la conversión");
          btn.disabled = false;
        }
      });
    });
  }

  // Gestor de Emparejamiento Bilingüe (Inglés ↔ Castellano) con Auto-Alineación y Vista Previa Lado a Lado
  let pairingTargetBook = null;
  let pairingPreviewData = null;
  let pairingWorkingMap = {};

  function buildClientFallbackPreview(bookA, bookB, bundleA, bundleB) {
    const rawA =
      (bundleA && Array.isArray(bundleA.chapters) && bundleA.chapters.length > 0
        ? bundleA.chapters
        : bookA.chapters_summary || bookA.chapters || []);
    const rawB =
      (bundleB && Array.isArray(bundleB.chapters) && bundleB.chapters.length > 0
        ? bundleB.chapters
        : bookB.chapters_summary || bookB.chapters || []);

    const mapChapter = (c, idx) => {
      const sents = Array.isArray(c.sentences) ? c.sentences : [];
      const texts = sents.map((s) => String((s && s.text) || "").trim()).filter(Boolean);
      const sc = Number(c.sentence_count || texts.length || 0);
      const preview = texts.slice(0, 3).join(" ").slice(0, 250);
      const ending = texts.length >= 2 ? texts.slice(-2).join(" ").slice(-160) : "";
      const isStory = sc > 15;
      return {
        index: Number(c.index !== undefined ? c.index : idx),
        title: c.title || `Capítulo ${idx + 1}`,
        sentence_count: sc,
        word_count: sc * 14,
        preview: preview || `(${sc} frases en este capítulo)`,
        ending_preview: ending,
        kind: isStory ? "chapter" : "front_matter",
        chapter_num: null,
        is_story: isStory,
      };
    };

    const chA = rawA.map(mapChapter);
    const chB = rawB.map(mapChapter);
    const storyA = chA.filter((c) => c.is_story);
    const storyB = chB.filter((c) => c.is_story);

    const cmap = {};
    const pairs = [];
    const count = Math.min(storyA.length, storyB.length);
    for (let k = 0; k < count; k++) {
      const a = storyA[k];
      const b = storyB[k];
      cmap[String(a.index)] = b.index;
      const ratio =
        Math.min(Math.max(1, a.sentence_count), Math.max(1, b.sentence_count)) /
        Math.max(1, a.sentence_count, b.sentence_count);
      pairs.push({
        src_index: a.index,
        tgt_index: b.index,
        confidence: Math.round(60 + ratio * 38),
        reason: `${a.sentence_count} ↔ ${b.sentence_count} frases`,
        is_story: true,
      });
    }

    const firstA = storyA[0] ? storyA[0].index : 0;
    const firstB = storyB[0] ? storyB[0].index : 0;
    return {
      book_a_id: bookA.id,
      book_b_id: bookB.id,
      book_a_chapters: chA,
      book_b_chapters: chB,
      chapter_map: cmap,
      pairs,
      dominant_offset: firstB - firstA,
      first_story_src: firstA,
      first_story_tgt: firstB,
    };
  }

  async function openPairingModal(bookObj) {
    await fetchLibrary();
    const target = bookObj
      ? state.books.find((b) => b.id === bookObj.id) || bookObj
      : state.currentBook;
    if (!target) return;

    pairingTargetBook = target;
    pairingPreviewData = null;
    pairingWorkingMap = {};
    els.pairSourceTitle.textContent = target.title;

    const targetIsEs = (target.language || "").toLowerCase().startsWith("es");
    const targetAuthor = (target.author || "").toLowerCase().trim();

    // Ordenar libros candidatos priorizando mismo autor e idioma opuesto
    const otherBooks = state.books
      .filter((b) => b.id !== target.id)
      .slice()
      .sort((a, b) => {
        const aDiffLang = (a.language || "").toLowerCase().startsWith("es") !== targetIsEs ? 1 : 0;
        const bDiffLang = (b.language || "").toLowerCase().startsWith("es") !== targetIsEs ? 1 : 0;
        const aSameAuth =
          targetAuthor && (a.author || "").toLowerCase().trim() === targetAuthor ? 1 : 0;
        const bSameAuth =
          targetAuthor && (b.author || "").toLowerCase().trim() === targetAuthor ? 1 : 0;
        const scoreA = aSameAuth * 4 + aDiffLang * 2;
        const scoreB = bSameAuth * 4 + bDiffLang * 2;
        return scoreB - scoreA;
      });

    els.pairPartnerSelect.innerHTML = "";

    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent =
      otherBooks.length === 0
        ? "— Sube primero el otro libro EPUB a tu biblioteca —"
        : "— Selecciona un libro de tu biblioteca —";
    els.pairPartnerSelect.appendChild(noneOpt);

    let bestSuggestedId = "";
    for (const b of otherBooks) {
      const opt = document.createElement("option");
      opt.value = b.id;
      const bIsEs = (b.language || "").toLowerCase().startsWith("es");
      const flag = bIsEs ? "🇪🇸 ES" : `🇬🇧 ${b.language || "EN"}`;
      const sameAuth =
        targetAuthor &&
        targetAuthor !== "autor desconocido" &&
        (b.author || "").toLowerCase().trim() === targetAuthor;
      const isSuggested = sameAuth && bIsEs !== targetIsEs;
      if (isSuggested && !bestSuggestedId) {
        bestSuggestedId = b.id;
      }
      opt.textContent = `${isSuggested ? "⭐ [Sugerido] " : ""}[${flag}] ${b.title} (${b.chapter_count} cap.)`;
      els.pairPartnerSelect.appendChild(opt);
    }

    const currentPairing = target.pairing || {};
    if (
      currentPairing.paired_book_id &&
      otherBooks.some((b) => b.id === currentPairing.paired_book_id)
    ) {
      els.pairPartnerSelect.value = currentPairing.paired_book_id;
      els.btnUnpairBooks.classList.remove("hidden");
    } else if (bestSuggestedId) {
      els.pairPartnerSelect.value = bestSuggestedId;
      els.btnUnpairBooks.classList.add("hidden");
    } else {
      els.pairPartnerSelect.value = "";
      els.btnUnpairBooks.classList.add("hidden");
    }

    els.chkPairAutoswitch.checked =
      typeof currentPairing.auto_switch_chapters === "boolean"
        ? currentPairing.auto_switch_chapters
        : true;

    els.pairingModal.classList.remove("hidden");
    await updatePairingModalFields();
  }

  async function updatePairingModalFields() {
    if (!pairingTargetBook) return;
    const partnerId = els.pairPartnerSelect.value;
    const partnerBook = state.books.find((b) => b.id === partnerId);

    const liveBox = document.getElementById("pair-live-preview-box");
    const mapDetails = document.getElementById("pair-map-details");
    const confBadge = document.getElementById("pair-match-confidence-badge");

    if (!partnerBook) {
      els.pairPrimarySelect.innerHTML = `<option value="${pairingTargetBook.id}">Selecciona primero un libro pareja arriba</option>`;
      els.pairChSource.innerHTML = "";
      els.pairChTarget.innerHTML = "";
      els.pairOffsetHint.textContent = "Desfase de capítulos: 0";
      if (liveBox) liveBox.classList.add("hidden");
      if (mapDetails) mapDetails.classList.add("hidden");
      if (confBadge) confBadge.classList.add("hidden");
      return;
    }

    const currentPairing = pairingTargetBook.pairing || {};
    const aIsEn = (pairingTargetBook.language || "").toLowerCase().startsWith("en");
    const bIsEn = (partnerBook.language || "").toLowerCase().startsWith("en");

    els.pairPrimarySelect.innerHTML = "";
    const optAFirst = document.createElement("option");
    optAFirst.value = pairingTargetBook.id;
    optAFirst.textContent = `1º "${pairingTargetBook.title}" → 2º "${partnerBook.title}"`;

    const optBFirst = document.createElement("option");
    optBFirst.value = partnerBook.id;
    optBFirst.textContent = `1º "${partnerBook.title}" → 2º "${pairingTargetBook.title}"`;

    els.pairPrimarySelect.appendChild(optAFirst);
    els.pairPrimarySelect.appendChild(optBFirst);

    if (
      currentPairing.paired_book_id === partnerBook.id &&
      currentPairing.primary_book_id
    ) {
      els.pairPrimarySelect.value = currentPairing.primary_book_id;
    } else if (bIsEn && !aIsEn) {
      els.pairPrimarySelect.value = partnerBook.id;
    } else {
      els.pairPrimarySelect.value = pairingTargetBook.id;
    }

    // Obtener análisis de capítulos y extractos del servidor (o fallback local si está sin conexión)
    els.pairOffsetHint.textContent = "⏳ Analizando capítulos, nombres propios y longitudes...";
    let previewData = null;
    if (!state.isServerOffline) {
      try {
        const res = await fetchWithTimeout(
          `/api/books/${encodeURIComponent(pairingTargetBook.id)}/pair-preview/${encodeURIComponent(partnerBook.id)}`,
          {},
          6000
        );
        if (res.ok) {
          previewData = await res.json();
        }
      } catch (_) {}
    }
    if (!previewData) {
      const bundleA =
        state.offlineBooksMap.get(pairingTargetBook.id) ||
        (await OfflineStore.getBookBundle(pairingTargetBook.id));
      const bundleB =
        state.offlineBooksMap.get(partnerBook.id) ||
        (await OfflineStore.getBookBundle(partnerBook.id));
      previewData = buildClientFallbackPreview(pairingTargetBook, partnerBook, bundleA, bundleB);
    }

    pairingPreviewData = previewData;

    // Inicializar mapa de trabajo capítulo a capítulo
    const autoMap = (previewData && previewData.chapter_map) || {};
    const savedMap =
      currentPairing.paired_book_id === partnerBook.id &&
      currentPairing.chapter_map &&
      Object.keys(currentPairing.chapter_map).length > 0
        ? currentPairing.chapter_map
        : null;

    pairingWorkingMap = {};
    const baseMap = savedMap || autoMap;
    for (const [k, v] of Object.entries(baseMap)) {
      if (v !== null && v !== undefined && Number(v) >= 0) {
        pairingWorkingMap[String(k)] = Number(v);
      }
    }

    // Rellenar selectores de capítulos con información de longitud y tipo (historia vs portadilla)
    els.pairChSource.innerHTML = "";
    const srcChapters =
      (previewData && previewData.book_a_chapters) ||
      pairingTargetBook.chapters_summary ||
      [];
    for (const ch of srcChapters) {
      const opt = document.createElement("option");
      opt.value = String(ch.index);
      const tag = ch.is_story === false ? " • Portadilla/Preliminar" : "";
      opt.textContent = `Cap. ${ch.index + 1}: ${ch.title} (${ch.sentence_count || 0} fr.${tag})`;
      els.pairChSource.appendChild(opt);
    }

    els.pairChTarget.innerHTML = "";
    const tgtChapters =
      (previewData && previewData.book_b_chapters) ||
      partnerBook.chapters_summary ||
      [];
    for (const ch of tgtChapters) {
      const opt = document.createElement("option");
      opt.value = String(ch.index);
      const tag = ch.is_story === false ? " • Portadilla/Preliminar" : "";
      opt.textContent = `Cap. ${ch.index + 1}: ${ch.title} (${ch.sentence_count || 0} fr.${tag})`;
      els.pairChTarget.appendChild(opt);
    }

    // Situar el selector por defecto en el capítulo actual de lectura (si es de historia) o en el 1º capítulo real de historia
    let initialSrcIdx =
      state.currentBook && state.currentBook.id === pairingTargetBook.id
        ? state.chapterIndex
        : Number(previewData.first_story_src || 0);
    if (
      initialSrcIdx === 0 &&
      srcChapters[0] &&
      srcChapters[0].is_story === false &&
      previewData.first_story_src > 0
    ) {
      initialSrcIdx = Number(previewData.first_story_src);
    }

    els.pairChSource.value = String(initialSrcIdx);
    syncTargetSelectWithSourceChapter(initialSrcIdx);
    renderPairingMapTable();
  }

  function syncTargetSelectWithSourceChapter(srcIdx) {
    if (!pairingPreviewData) return;
    const tgtChapters = pairingPreviewData.book_b_chapters || [];
    if (tgtChapters.length === 0) return;

    let targetIdx = pairingWorkingMap[String(srcIdx)];
    if (targetIdx === undefined || targetIdx === null || Number.isNaN(Number(targetIdx))) {
      const domOff = Number(pairingPreviewData.dominant_offset || 0);
      targetIdx = Math.max(0, Math.min(tgtChapters.length - 1, srcIdx + domOff));
    }
    els.pairChTarget.value = String(targetIdx);
    updatePairingOffsetLabel();
  }

  function updatePairingOffsetLabel() {
    const srcIdx = Number(els.pairChSource.value || 0);
    const tgtIdx = Number(els.pairChTarget.value || 0);
    const offset = tgtIdx - srcIdx;
    const mappedCount = Object.keys(pairingWorkingMap).length;
    if (offset === 0) {
      els.pairOffsetHint.textContent =
        mappedCount > 0
          ? `Mapa inteligente activo (${mappedCount} cap. alineados) • En este par: desfase 0 (Cap. ${srcIdx + 1} ↔ Cap. ${tgtIdx + 1})`
          : "Desfase de capítulos: 0 (ambos libros coinciden en numeración de capítulo)";
    } else {
      const sign = offset > 0 ? `+${offset}` : String(offset);
      els.pairOffsetHint.textContent =
        mappedCount > 0
          ? `Mapa inteligente activo (${mappedCount} cap. alineados) • En este par: desfase ${sign} (Cap. ${srcIdx + 1} ↔ Cap. ${tgtIdx + 1})`
          : `Desfase de capítulos: ${sign} (Cap. ${srcIdx + 1} de este libro ↔ Cap. ${tgtIdx + 1} de la pareja)`;
    }
    renderPairingLivePreview(srcIdx, tgtIdx);
    highlightActiveRowInPairingTable(srcIdx);
  }

  function renderPairingLivePreview(srcIdx, tgtIdx) {
    const liveBox = document.getElementById("pair-live-preview-box");
    const confBadge = document.getElementById("pair-match-confidence-badge");
    if (!liveBox || !pairingPreviewData) return;

    const srcCh = (pairingPreviewData.book_a_chapters || [])[srcIdx];
    const tgtCh = (pairingPreviewData.book_b_chapters || [])[tgtIdx];
    if (!srcCh || !tgtCh) {
      liveBox.classList.add("hidden");
      return;
    }

    liveBox.classList.remove("hidden");
    const srcTitleEl = document.getElementById("pair-prev-src-title");
    const srcMetaEl = document.getElementById("pair-prev-src-meta");
    const srcTextEl = document.getElementById("pair-prev-src-text");
    const srcEndEl = document.getElementById("pair-prev-src-end");

    const tgtTitleEl = document.getElementById("pair-prev-tgt-title");
    const tgtMetaEl = document.getElementById("pair-prev-tgt-meta");
    const tgtTextEl = document.getElementById("pair-prev-tgt-text");
    const tgtEndEl = document.getElementById("pair-prev-tgt-end");

    if (srcTitleEl) srcTitleEl.textContent = `Cap. ${srcCh.index + 1}: ${srcCh.title}`;
    if (srcMetaEl) {
      srcMetaEl.textContent = `${srcCh.sentence_count} fr. ${srcCh.is_story ? "📖" : "📄"}`;
    }
    if (srcTextEl) {
      srcTextEl.textContent = srcCh.preview ? `«${srcCh.preview}»` : "— Sin texto de vista previa —";
    }
    if (srcEndEl) {
      srcEndEl.textContent = srcCh.ending_preview ? `Final: «${srcCh.ending_preview}»` : "";
    }

    if (tgtTitleEl) tgtTitleEl.textContent = `Cap. ${tgtCh.index + 1}: ${tgtCh.title}`;
    if (tgtMetaEl) {
      tgtMetaEl.textContent = `${tgtCh.sentence_count} fr. ${tgtCh.is_story ? "📖" : "📄"}`;
    }
    if (tgtTextEl) {
      tgtTextEl.textContent = tgtCh.preview ? `«${tgtCh.preview}»` : "— Sin texto de vista previa —";
    }
    if (tgtEndEl) {
      tgtEndEl.textContent = tgtCh.ending_preview ? `Final: «${tgtCh.ending_preview}»` : "";
    }

    if (confBadge) {
      const pairInfo = (pairingPreviewData.pairs || []).find(
        (p) => Number(p.src_index) === srcIdx && Number(p.tgt_index) === tgtIdx
      );
      const sa = Math.max(1, Number(srcCh.sentence_count || 1));
      const sb = Math.max(1, Number(tgtCh.sentence_count || 1));
      const lenRatio = Math.round((Math.min(sa, sb) / Math.max(sa, sb)) * 100);
      confBadge.classList.remove("hidden");
      if (pairInfo) {
        confBadge.textContent = `🎯 ${pairInfo.confidence}% coincidencia • ${pairInfo.reason}`;
        confBadge.style.borderColor = "var(--accent)";
        confBadge.style.color = "var(--accent)";
      } else {
        confBadge.textContent = `📏 Similitud de longitud: ${lenRatio}% (${srcCh.sentence_count} vs ${tgtCh.sentence_count} frases)`;
        confBadge.style.borderColor = "";
        confBadge.style.color = "";
      }
    }
  }

  function highlightActiveRowInPairingTable(srcIdx) {
    const listEl = document.getElementById("pair-map-list");
    if (!listEl) return;
    listEl.querySelectorAll(".pair-map-row").forEach((row) => {
      row.classList.toggle("is-active-row", Number(row.dataset.srcIdx) === Number(srcIdx));
    });
  }

  function renderPairingMapTable() {
    const detailsEl = document.getElementById("pair-map-details");
    const listEl = document.getElementById("pair-map-list");
    const countBadge = document.getElementById("pair-map-count-badge");
    if (!detailsEl || !listEl || !pairingPreviewData) return;

    const srcChapters = pairingPreviewData.book_a_chapters || [];
    const tgtChapters = pairingPreviewData.book_b_chapters || [];
    if (srcChapters.length === 0 || tgtChapters.length === 0) {
      detailsEl.classList.add("hidden");
      return;
    }

    detailsEl.classList.remove("hidden");
    const mappedTotal = Object.keys(pairingWorkingMap).length;
    if (countBadge) {
      countBadge.textContent = `${mappedTotal} de ${srcChapters.length} cap. vinculados`;
    }

    listEl.innerHTML = "";
    const curSelectedSrc = Number(els.pairChSource.value || 0);

    for (const srcCh of srcChapters) {
      const sIdx = Number(srcCh.index);
      const mappedTgt =
        pairingWorkingMap[String(sIdx)] !== undefined ? Number(pairingWorkingMap[String(sIdx)]) : -1;
      const tgtCh = mappedTgt >= 0 ? tgtChapters[mappedTgt] : null;
      const pairInfo = (pairingPreviewData.pairs || []).find(
        (p) => Number(p.src_index) === sIdx && Number(p.tgt_index) === mappedTgt
      );

      const row = document.createElement("div");
      row.className = `pair-map-row${sIdx === curSelectedSrc ? " is-active-row" : ""}${
        srcCh.is_story === false ? " is-front-matter" : ""
      }`;
      row.dataset.srcIdx = String(sIdx);

      const optionsHtml = [
        `<option value="-1"${mappedTgt < 0 ? " selected" : ""}>— Sin equivalente (portadilla / saltar) —</option>`,
      ];
      for (const tc of tgtChapters) {
        const sel = Number(tc.index) === mappedTgt ? " selected" : "";
        optionsHtml.push(
          `<option value="${tc.index}"${sel}>Cap. ${tc.index + 1}: ${escapeHtml(tc.title)} (${tc.sentence_count} fr.)</option>`
        );
      }

      const confHtml = pairInfo
        ? `<span class="badge-pill" style="font-size:0.68rem;color:var(--accent);border-color:var(--accent)">🎯 ${pairInfo.confidence}%</span>`
        : mappedTgt >= 0
        ? `<span class="badge-pill" style="font-size:0.68rem">Manual</span>`
        : `<span class="badge-pill" style="font-size:0.68rem;opacity:0.6">Omitido</span>`;

      row.innerHTML = `
        <div>
          <div class="pair-map-cell-title">
            <span>Cap. ${sIdx + 1}: ${escapeHtml(srcCh.title)}</span>
            <span class="badge-pill" style="font-size:0.66rem">${srcCh.sentence_count} fr.</span>
          </div>
          <div class="pair-map-cell-snippet">${escapeHtml(srcCh.preview || "")}</div>
        </div>
        <div style="text-align:center">${confHtml}</div>
        <div>
          <select class="player-select pair-row-target-select" data-src-idx="${sIdx}" style="width:100%;max-width:none;padding:4px 8px;font-size:0.76rem">
            ${optionsHtml.join("")}
          </select>
          <div class="pair-map-cell-snippet">${
            tgtCh ? escapeHtml(tgtCh.preview || "") : "<em>Se saltará automáticamente al cambiar de idioma</em>"
          }</div>
        </div>
      `;

      row.addEventListener("click", (e) => {
        if (e.target && e.target.tagName === "SELECT") return;
        els.pairChSource.value = String(sIdx);
        if (mappedTgt >= 0) {
          els.pairChTarget.value = String(mappedTgt);
        }
        updatePairingOffsetLabel();
      });

      const rowSelect = row.querySelector(".pair-row-target-select");
      if (rowSelect) {
        rowSelect.addEventListener("change", (e) => {
          e.stopPropagation();
          const newTgt = Number(rowSelect.value);
          if (newTgt >= 0) {
            pairingWorkingMap[String(sIdx)] = newTgt;
            els.pairChSource.value = String(sIdx);
            els.pairChTarget.value = String(newTgt);
          } else {
            delete pairingWorkingMap[String(sIdx)];
          }
          renderPairingMapTable();
          updatePairingOffsetLabel();
        });
      }

      listEl.appendChild(row);
    }
  }

  function applyAutoAlignmentInModal() {
    if (!pairingPreviewData) return;
    pairingWorkingMap = {};
    const autoMap = pairingPreviewData.chapter_map || {};
    for (const [k, v] of Object.entries(autoMap)) {
      if (v !== null && v !== undefined && Number(v) >= 0) {
        pairingWorkingMap[String(k)] = Number(v);
      }
    }
    const firstSrc = Number(pairingPreviewData.first_story_src || 0);
    els.pairChSource.value = String(firstSrc);
    syncTargetSelectWithSourceChapter(firstSrc);
    renderPairingMapTable();
    showToast(
      `✨ ${Object.keys(pairingWorkingMap).length} capítulos alineados automáticamente por contenido y longitud`
    );
  }

  function applyOffsetFromCurrentChapterOnwards() {
    if (!pairingPreviewData) return;
    const srcIdx = Number(els.pairChSource.value || 0);
    const tgtIdx = Number(els.pairChTarget.value || 0);
    const offset = tgtIdx - srcIdx;
    const srcChapters = pairingPreviewData.book_a_chapters || [];
    const tgtChapters = pairingPreviewData.book_b_chapters || [];

    let updatedCount = 0;
    for (let i = srcIdx; i < srcChapters.length; i++) {
      const mapped = i + offset;
      if (mapped >= 0 && mapped < tgtChapters.length) {
        pairingWorkingMap[String(i)] = mapped;
        updatedCount++;
      } else {
        delete pairingWorkingMap[String(i)];
      }
    }
    renderPairingMapTable();
    updatePairingOffsetLabel();
    const sign = offset >= 0 ? `+${offset}` : String(offset);
    showToast(`📐 Aplicado desfase ${sign} a ${updatedCount} capítulos a partir del Cap. ${srcIdx + 1}`);
  }

  async function saveBookPairing() {
    if (!pairingTargetBook) return;
    const partnerId = els.pairPartnerSelect.value;
    if (!partnerId) {
      showToast("Selecciona un libro de la lista para emparejarlo");
      return;
    }

    const srcIdx = Number(els.pairChSource.value || 0);
    const tgtIdx = Number(els.pairChTarget.value || 0);
    const offset = tgtIdx - srcIdx;
    pairingWorkingMap[String(srcIdx)] = tgtIdx;

    try {
      const res = await fetch(`/api/books/${pairingTargetBook.id}/pair`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paired_book_id: partnerId,
          auto_switch_chapters: els.chkPairAutoswitch.checked,
          primary_book_id: els.pairPrimarySelect.value,
          chapter_offset: offset,
          chapter_map: pairingWorkingMap,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "No se pudo guardar el emparejamiento");
      }
      const data = await res.json();
      if (data.book) {
        OfflineStore.syncServerBookMeta(data.book);
      }
      if (data.paired_book) {
        OfflineStore.syncServerBookMeta(data.paired_book);
      }
      if (state.currentBook && state.currentBook.id === data.book.id) {
        state.currentBook = data.book;
      } else if (
        state.currentBook &&
        data.paired_book &&
        state.currentBook.id === data.paired_book.id
      ) {
        state.currentBook = data.paired_book;
      }
      els.pairingModal.classList.add("hidden");
      showToast(
        `🔗 Libros emparejados (${Object.keys(pairingWorkingMap).length} capítulos sincronizados)`
      );
      await fetchLibrary();
      updatePairingHeaderButtons();
      if (state.currentBook && !state.isServerOffline) {
        fetchBookStudy(state.currentBook.id).catch(() => {});
      }
    } catch (err) {
      showToast(`Error: ${err.message}`);
    }
  }

  async function unpairCurrentBook() {
    if (!pairingTargetBook) return;
    const oldPartnerId =
      pairingTargetBook.pairing && pairingTargetBook.pairing.paired_book_id
        ? pairingTargetBook.pairing.paired_book_id
        : null;
    try {
      const res = await fetch(`/api/books/${pairingTargetBook.id}/pair`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paired_book_id: null }),
      });
      if (!res.ok) throw new Error("Error al desvincular");
      if (state.currentBook) {
        state.currentBook.pairing = null;
      }
      for (const bid of [pairingTargetBook.id, oldPartnerId].filter(Boolean)) {
        const bObj = state.books.find((b) => b.id === bid);
        if (bObj) {
          bObj.pairing = null;
          OfflineStore.syncServerBookMeta(bObj);
        }
      }
      els.pairingModal.classList.add("hidden");
      showToast("Libros desvinculados");
      await fetchLibrary();
      updatePairingHeaderButtons();
      if (state.currentBook && !state.isServerOffline) {
        fetchBookStudy(state.currentBook.id).catch(() => {});
      }
    } catch (err) {
      showToast(`Error: ${err.message}`);
    }
  }

  async function switchToPairedBookNow() {
    if (!state.currentBook) return;
    const freshCurrent =
      state.books.find((b) => b.id === state.currentBook.id) || state.currentBook;
    const pairing =
      freshCurrent.pairing &&
      freshCurrent.pairing.paired_book_id &&
      freshCurrent.pairing.chapter_map &&
      Object.keys(freshCurrent.pairing.chapter_map).length > 0
        ? freshCurrent.pairing
        : state.currentBook.pairing || freshCurrent.pairing;
    if (!pairing || !pairing.paired_book_id) return;

    const wasPlaying = state.isPlaying;
    // 1. Guardar inmediatamente la posición exacta (capítulo y frase) del idioma actual antes de cambiar
    await saveReadingProgress({ immediate: true });

    const partnerId = pairing.paired_book_id;
    const partnerBook =
      state.books.find((b) => b.id === partnerId) ||
      ((state.offlineBooksMap.get(partnerId) || {}).book) ||
      null;
    const maxCh = partnerBook ? Math.max(0, partnerBook.chapter_count - 1) : 999;
    const resolved = resolvePairedTargetChapter(state.currentBook, state.chapterIndex, {
      advancingToNextCycle: false,
      allowNearestFallback: true,
    });
    const targetChapter = Math.max(
      0,
      Math.min(
        maxCh,
        resolved !== null ? resolved : state.chapterIndex + Number(pairing.chapter_offset || 0)
      )
    );

    // 2. Recuperar la frase exacta guardada en ese capítulo del libro destino (o 0 si es capítulo nuevo en ese idioma)
    const targetSentence = partnerBook
      ? getSavedSentenceForChapter(partnerBook, targetChapter)
      : 0;

    await openBook(partnerId, {
      overrideChapterIndex: targetChapter,
      overrideSentenceIndex: targetSentence,
      autoPlay: wasPlaying,
      preferLocal: state.offlineBooksMap.has(partnerId),
      keepViewHidden: Boolean(els.readerView && els.readerView.classList.contains("hidden")),
    });

    if (state.currentBook && state.currentBook.id === partnerId) {
      const isEs = (state.currentBook.language || "").toLowerCase().startsWith("es");
      const flag = isEs ? "🇪🇸" : "🇬🇧";
      const chTitle = state.currentChapter
        ? state.currentChapter.title
        : `Cap. ${targetChapter + 1}`;
      const sentNote =
        state.sentenceIndex > 0
          ? `retomando en Frase ${state.sentenceIndex + 1}`
          : "inicio del capítulo (Frase 1)";
      showToast(
        `${flag} «${state.currentBook.title}» — ${chTitle} (${sentNote})`,
        4200
      );
    }
  }

  // Diccionario y Traducción Contextual con Clic Derecho en cualquier palabra
  let currentDictWord = "";
  let currentDictLang = "en";
  let currentDictSentence = "";
  let currentDictSentenceIdx = 0;
  let lastDictLookupResult = null;
  let lastSavedVocabEntryId = null;
  let dictOpenedAtMs = 0;
  const dictAudio = new Audio();

  function hasRealDictDefinitions(data) {
    if (!data || !Array.isArray(data.definitions) || data.definitions.length === 0) {
      return false;
    }
    for (const d of data.definitions) {
      if (!d || !Array.isArray(d.senses)) continue;
      for (const s of d.senses) {
        const txt = String((s && s.definition) || "").trim();
        if (
          txt.length >= 18 &&
          !txt.startsWith("Acepciones equivalentes:") &&
          !txt.startsWith("Equivalent meanings:")
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function stripHtmlTagsClient(htmlStr) {
    if (!htmlStr) return "";
    const tmp = document.createElement("div");
    tmp.innerHTML = String(htmlStr);
    return (tmp.textContent || tmp.innerText || "").replace(/\s+/g, " ").trim();
  }

  function parseEsWiktionaryExtractClient(extract, title) {
    if (!extract) return { defs: [], refLemma: "" };
    let section = extract;
    const esMatch = extract.match(/==\s*Español\s*==/i);
    if (esMatch && esMatch.index !== undefined) {
      section = extract.slice(esMatch.index + esMatch[0].length);
      const nextLang = section.match(/\n==\s*[^=]+\s*==/);
      if (nextLang && nextLang.index !== undefined) {
        section = section.slice(0, nextLang.index);
      }
    }

    const ignoredHeaders = [
      "etimología",
      "pronunciación",
      "traducciones",
      "véase",
      "referencias",
      "conjugación",
      "locuciones",
      "información adicional",
      "anagramas",
      "derivados",
      "compuestos",
    ];
    const metaPrefixes = [
      "sinónimo",
      "antónimo",
      "relacionado",
      "hiperónimo",
      "hipónimo",
      "cohipónimo",
      "uso:",
      "ámbito:",
      "registro:",
      "nota:",
    ];

    const results = [];
    let currentPos = `Definición (${title})`;
    let currentSenses = [];
    let inIgnoredSection = false;
    let pendingDomain = null;
    let refLemma = "";

    for (const rawLine of section.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const headerMatch = line.match(/^===+\s*(.+?)\s*===+$/);
      if (headerMatch) {
        pendingDomain = null;
        const hTitle = headerMatch[1].trim();
        const lowH = hTitle.toLowerCase();
        if (ignoredHeaders.some((kw) => lowH.includes(kw))) {
          inIgnoredSection = true;
          continue;
        }
        inIgnoredSection = false;
        if (currentSenses.length > 0) {
          results.push({ part_of_speech: currentPos, senses: currentSenses.slice(0, 5) });
          currentSenses = [];
        }
        currentPos = hTitle;
        continue;
      }

      if (inIgnoredSection) continue;
      if (line.includes("¦") || line.toLowerCase() === String(title || "").toLowerCase()) {
        continue;
      }

      const lowLine = line.toLowerCase();
      if (lowLine.startsWith("ejemplo:") || lowLine.startsWith("ejemplos:")) {
        const exText = line.replace(/^ejemplos?:\s*/i, "").trim();
        if (currentSenses.length > 0 && exText && !currentSenses[currentSenses.length - 1].example) {
          currentSenses[currentSenses.length - 1].example = exText.slice(0, 220);
        }
        continue;
      }
      if (metaPrefixes.some((p) => lowLine.startsWith(p))) {
        continue;
      }

      const senseMatch = line.match(/^;?\s*(\d{1,2})\b\s*[:.]?\s*(.*)$/);
      if (senseMatch) {
        const inlineRest = (senseMatch[2] || "").replace(/(\w)\d+(?=[.;,]|$)/g, "$1").trim();
        if (!inlineRest) {
          pendingDomain = "";
        } else if (inlineRest.length < 42 && !inlineRest.endsWith(".")) {
          pendingDomain = inlineRest;
        } else {
          currentSenses.push({ definition: inlineRest, example: "" });
          pendingDomain = null;
        }
        continue;
      }

      if (pendingDomain !== null) {
        const defText = line.replace(/(\w)\d+(?=[.;,]|$)/g, "$1").trim();
        if (defText.length > 3) {
          const fullDef = pendingDomain ? `(${pendingDomain}) ${defText}` : defText;
          currentSenses.push({ definition: fullDef, example: "" });
          if (!refLemma) {
            const refM = defText.match(
              /(?:forma del|plural de|femenino de|participio de|gerundio de|infinitivo|persona\b[^.]+?\bde)\s+([a-záéíóúüñ]{3,})/i
            );
            if (refM) {
              refLemma = refM[1].trim();
            }
          }
        }
        pendingDomain = null;
      }
    }

    if (currentSenses.length > 0) {
      results.push({ part_of_speech: currentPos, senses: currentSenses.slice(0, 5) });
    }
    return { defs: results.slice(0, 4), refLemma };
  }

  const LOCAL_DICT_CACHE_KEY = "vozlectura_dict_cache_v1";

  function loadLocalDictCacheMap() {
    try {
      const raw = localStorage.getItem(LOCAL_DICT_CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function getCachedDictLookup(word, srcLang) {
    if (!word) return null;
    const key = `${srcLang}:${String(word).trim().toLowerCase()}`;
    const map = loadLocalDictCacheMap();
    return map[key] || null;
  }

  function saveCachedDictLookup(word, srcLang, data) {
    if (!word || !data || !data.translation) return;
    if (String(data.translation).trim().toLowerCase() === String(word).trim().toLowerCase() && !hasRealDictDefinitions(data)) {
      return;
    }
    try {
      const key = `${srcLang}:${String(word).trim().toLowerCase()}`;
      const map = loadLocalDictCacheMap();
      map[key] = {
        word: data.word || word,
        lemma: data.lemma || word.toLowerCase(),
        phonetic: data.phonetic || "",
        translation: data.translation || "",
        bilingual_entries: Array.isArray(data.bilingual_entries) ? data.bilingual_entries.slice(0, 4) : [],
        definitions: Array.isArray(data.definitions) ? data.definitions.slice(0, 3) : [],
        savedAt: Date.now(),
      };
      const keys = Object.keys(map);
      if (keys.length > 450) {
        keys
          .sort((a, b) => Number((map[a] && map[a].savedAt) || 0) - Number((map[b] && map[b].savedAt) || 0))
          .slice(0, keys.length - 400)
          .forEach((k) => delete map[k]);
      }
      localStorage.setItem(LOCAL_DICT_CACHE_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  function findVocabEntryAcrossAllLocalBooks(word, srcLang) {
    const wLow = String(word || "").trim().toLowerCase();
    if (!wLow) return null;
    const studySources = [];
    if (state.currentStudy && Array.isArray(state.currentStudy.vocabulary)) {
      studySources.push(state.currentStudy.vocabulary);
    }
    for (const rec of state.offlineBooksMap.values()) {
      if (rec && rec.study && Array.isArray(rec.study.vocabulary)) {
        studySources.push(rec.study.vocabulary);
      }
    }
    for (const vocabList of studySources) {
      for (const v of vocabList) {
        if (!v) continue;
        const vw = String(v.word || "").trim().toLowerCase();
        const vl = String(v.lemma || "").trim().toLowerCase();
        if (vw === wLow || (vl && vl === wLow)) {
          if (v.translation && v.translation.toLowerCase() !== wLow) {
            return v;
          }
        }
      }
    }
    return null;
  }

  function getAlignedPartnerSentenceOffline(sentenceIdx = currentDictSentenceIdx) {
    try {
      if (!state.currentBook || !state.currentBook.pairing || !state.currentBook.pairing.paired_book_id) {
        return "";
      }
      const partnerId = state.currentBook.pairing.paired_book_id;
      const partnerBundle = state.offlineBooksMap.get(partnerId);
      if (!partnerBundle || !Array.isArray(partnerBundle.chapters) || partnerBundle.chapters.length === 0) {
        return "";
      }
      const targetChIdx = resolvePairedTargetChapter(state.currentBook, state.chapterIndex, {
        advancingToNextCycle: false,
        allowNearestFallback: true,
      });
      if (targetChIdx === null || targetChIdx === undefined || targetChIdx < 0) return "";
      const partnerCh =
        partnerBundle.chapters.find((c) => Number(c.index) === Number(targetChIdx)) ||
        partnerBundle.chapters[targetChIdx];
      if (!partnerCh || !Array.isArray(partnerCh.sentences) || partnerCh.sentences.length === 0) {
        return "";
      }
      const srcSentences = (state.currentChapter && state.currentChapter.sentences) || [];
      const srcCount = Math.max(1, srcSentences.length);
      const tgtCount = partnerCh.sentences.length;
      const ratio = Math.max(0, Math.min(1, Number(sentenceIdx || 0) / Math.max(1, srcCount - 1)));
      const approxIdx = Math.min(tgtCount - 1, Math.max(0, Math.round(ratio * (tgtCount - 1))));
      const rawSent = partnerCh.sentences[approxIdx];
      const text = typeof rawSent === "string" ? rawSent : (rawSent && rawSent.text) || "";
      return String(text || "").trim();
    } catch (_) {
      return "";
    }
  }

  async function fetchJsonDirectWithTimeout(url, timeoutMs = 4200) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await nativeFetch(url, { cache: "no-store", signal: controller.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function translateViaMyMemoryClient(text, srcLang, tgtLang, timeoutMs = 3800) {
    const clean = String(text || "").trim();
    if (!clean) return "";
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
        clean.slice(0, 450)
      )}&langpair=${encodeURIComponent(`${srcLang}|${tgtLang}`)}`;
      const data = await fetchJsonDirectWithTimeout(url, timeoutMs);
      const translated =
        data && data.responseData && typeof data.responseData.translatedText === "string"
          ? data.responseData.translatedText.trim()
          : "";
      if (
        translated &&
        !translated.includes("MYMEMORY WARNING") &&
        translated.toLowerCase() !== clean.toLowerCase()
      ) {
        return translated;
      }
    } catch (_) {}
    return "";
  }

  async function fetchClientSideDefinitions(word, lemma, srcLang) {
    const cleanW = String(word || "").trim();
    const cleanL = String(lemma || cleanW).trim();
    const candidates = [...new Set([cleanW.toLowerCase(), cleanL.toLowerCase(), cleanW])].filter(
      Boolean
    );
    const wLow = cleanW.toLowerCase();
    if (wLow.length > 4) {
      if (srcLang === "en") {
        if (wLow.endsWith("ies")) candidates.push(`${wLow.slice(0, -3)}y`);
        if (wLow.endsWith("es")) candidates.push(wLow.slice(0, -2), wLow.slice(0, -1));
        else if (wLow.endsWith("s") && !wLow.endsWith("ss")) candidates.push(wLow.slice(0, -1));
        if (wLow.endsWith("ed")) candidates.push(wLow.slice(0, -2), wLow.slice(0, -1));
        if (wLow.endsWith("ing") && wLow.length > 5) {
          candidates.push(wLow.slice(0, -3), `${wLow.slice(0, -3)}e`);
        }
      } else {
        if (wLow.endsWith("ces")) candidates.push(`${wLow.slice(0, -3)}z`);
        if (wLow.endsWith("es")) candidates.push(wLow.slice(0, -2), wLow.slice(0, -1));
        else if (wLow.endsWith("s") && !wLow.endsWith("ss")) candidates.push(wLow.slice(0, -1));
        if (wLow.endsWith("as")) candidates.push(`${wLow.slice(0, -2)}o`);
        else if (wLow.endsWith("a")) candidates.push(`${wLow.slice(0, -1)}o`);
      }
    }

    const definitions = [];
    let phonetic = "";

    if (srcLang === "en") {
      for (const cand of candidates) {
        try {
          const data = await fetchJsonDirectWithTimeout(
            `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cand)}`,
            3800
          );
          if (Array.isArray(data) && data.length > 0) {
            const entry = data[0];
            phonetic = entry.phonetic || "";
            if (!phonetic && Array.isArray(entry.phonetics)) {
              const ph = entry.phonetics.find((p) => p && p.text);
              if (ph) phonetic = ph.text;
            }
            for (const meaning of entry.meanings || []) {
              const pos = meaning.partOfSpeech || "";
              const senses = (meaning.definitions || [])
                .slice(0, 4)
                .map((d) => ({
                  definition: (d.definition || "").trim(),
                  example: (d.example || "").trim(),
                }))
                .filter((s) => s.definition);
              if (senses.length > 0) {
                definitions.push({ part_of_speech: pos, senses });
              }
            }
            if (definitions.length > 0) return { definitions, phonetic };
          }
        } catch (_) {}
      }

      for (const cand of candidates) {
        try {
          const data = await fetchJsonDirectWithTimeout(
            `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(cand)}`,
            4200
          );
          if (data && Array.isArray(data.en)) {
            for (const meaning of data.en) {
              const pos = (meaning.partOfSpeech || "").trim();
              const senses = (meaning.definitions || [])
                .slice(0, 4)
                .map((d) => {
                  const defTxt = stripHtmlTagsClient(d.definition || "");
                  const exArr = d.parsedExamples || d.examples || [];
                  const firstEx = exArr[0];
                  const exTxt = firstEx
                    ? stripHtmlTagsClient(typeof firstEx === "string" ? firstEx : firstEx.example || "")
                    : "";
                  return { definition: defTxt, example: exTxt };
                })
                .filter((s) => s.definition);
              if (senses.length > 0) {
                definitions.push({ part_of_speech: pos, senses });
              }
            }
            if (definitions.length > 0) return { definitions: definitions.slice(0, 4), phonetic };
          }
        } catch (_) {}
      }
    } else {
      const visited = new Set();
      for (let i = 0; i < candidates.length && i < 8; i++) {
        const cand = candidates[i];
        if (!cand || visited.has(cand)) continue;
        visited.add(cand);
        try {
          const url = `https://es.wiktionary.org/w/api.php?action=query&prop=extracts&titles=${encodeURIComponent(
            cand
          )}&explaintext=1&redirects=1&format=json&origin=*`;
          const data = await fetchJsonDirectWithTimeout(url, 4200);
          const pages = (data && data.query && data.query.pages) || {};
          for (const [pid, pageInfo] of Object.entries(pages)) {
            if (String(pid) === "-1" || !pageInfo) continue;
            const { defs, refLemma } = parseEsWiktionaryExtractClient(
              pageInfo.extract || "",
              cand
            );
            if (refLemma && !visited.has(refLemma.toLowerCase())) {
              candidates.push(refLemma.toLowerCase());
            }
            if (defs.length > 0) {
              return { definitions: defs, phonetic: "" };
            }
          }
        } catch (_) {}
      }
    }

    return { definitions, phonetic };
  }

  async function lookupDictionaryClientFallback(word, srcLang, sentence, partialServerData = null) {
    const src = srcLang === "es" ? "es" : "en";
    const tgt = src === "es" ? "en" : "es";
    const cachedEntry = getCachedDictLookup(word, src);
    const localVocabEntry = findVocabEntryAcrossAllLocalBooks(word, src);

    const result = partialServerData
      ? { ...partialServerData }
      : {
          word,
          lemma: (cachedEntry && cachedEntry.lemma) || (localVocabEntry && localVocabEntry.lemma) || word.toLowerCase(),
          source_lang: src,
          target_lang: tgt,
          phonetic: (cachedEntry && cachedEntry.phonetic) || (localVocabEntry && localVocabEntry.phonetic) || "",
          translation: (cachedEntry && cachedEntry.translation) || (localVocabEntry && localVocabEntry.translation) || "",
          bilingual_entries: (cachedEntry && cachedEntry.bilingual_entries) || [],
          definitions:
            (cachedEntry && cachedEntry.definitions && cachedEntry.definitions.length > 0
              ? cachedEntry.definitions
              : localVocabEntry && localVocabEntry.definitions_summary
              ? [{ part_of_speech: "", senses: [{ definition: localVocabEntry.definitions_summary, example: "" }] }]
              : []),
          dictionary_lang_label:
            src === "en" ? "Diccionario en Inglés (EN)" : "Diccionario en Castellano (ES)",
          translation_lang_label:
            src === "en" ? "Traducción al Castellano (ES)" : "Traducción al Inglés (EN)",
          context_sentence: sentence || "",
          context_translation:
            localVocabEntry &&
            localVocabEntry.context_sentence === sentence &&
            localVocabEntry.context_translation
              ? localVocabEntry.context_translation
              : "",
        };

    // 1. Si falta traducción principal o bilingüe, consultar Google GTX directamente desde el navegador
    if (!result.translation || result.translation.toLowerCase() === word.toLowerCase()) {
      try {
        const gtxUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tgt}&hl=es&dt=t&dt=bd&q=${encodeURIComponent(
          word
        )}`;
        const gtxData = await fetchJsonDirectWithTimeout(gtxUrl, 3600);
        if (Array.isArray(gtxData)) {
          if (Array.isArray(gtxData[0])) {
            const parts = [];
            for (const it of gtxData[0]) {
              if (Array.isArray(it) && it[0]) parts.push(String(it[0]));
              if (Array.isArray(it) && it[3] && !result.phonetic) result.phonetic = String(it[3]);
            }
            if (parts.length > 0) result.translation = parts.join("").trim();
          }
          if (Array.isArray(gtxData[1])) {
            const bil = [];
            for (const posBlock of gtxData[1]) {
              if (!Array.isArray(posBlock) || posBlock.length < 2) continue;
              const posName = String(posBlock[0] || "");
              const terms = (posBlock[1] || []).filter((t) => typeof t === "string").slice(0, 8);
              if (posBlock[3] && typeof posBlock[3] === "string") {
                result.lemma = posBlock[3];
              }
              if (terms.length > 0) bil.push({ pos: posName, terms });
            }
            if (bil.length > 0) result.bilingual_entries = bil;
          }
        }
      } catch (_) {}
    }

    // 1b. Respaldo secundario CORS-friendly (MyMemory) si Brave Shields o la red bloquearon Google GTX
    if (!result.translation || result.translation.toLowerCase() === word.toLowerCase()) {
      const mmWord = await translateViaMyMemoryClient(word, src, tgt, 3500);
      if (mmWord) {
        result.translation = mmWord;
      }
    }

    if (
      (!result.translation || result.translation.toLowerCase() === word.toLowerCase()) &&
      Array.isArray(result.bilingual_entries) &&
      result.bilingual_entries.length > 0
    ) {
      const firstTerms = result.bilingual_entries[0].terms || [];
      if (firstTerms.length > 0) {
        result.translation = firstTerms.slice(0, 3).join(", ");
      }
    }
    if (!result.translation) {
      result.translation = word;
    }

    // 2. Si faltan definiciones reales del diccionario monolingüe, obtenerlas directamente de DictionaryAPI / Wiktionary
    if (!hasRealDictDefinitions(result)) {
      const { definitions, phonetic } = await fetchClientSideDefinitions(
        word,
        result.lemma || word,
        src
      );
      if (definitions && definitions.length > 0) {
        result.definitions = definitions;
      }
      if (phonetic && !result.phonetic) {
        result.phonetic = phonetic;
      }
    }

    // 3. Si hay frase de contexto y aún no está traducida, traducirla (con doble motor + respaldo de libro bilingüe local)
    if (sentence && sentence.trim().length > 3 && !result.context_translation) {
      const shortSent = sentence.trim().slice(0, 450);
      try {
        const sentUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tgt}&dt=t&q=${encodeURIComponent(
          shortSent
        )}`;
        const sentData = await fetchJsonDirectWithTimeout(sentUrl, 3600);
        if (Array.isArray(sentData) && Array.isArray(sentData[0])) {
          const parts = sentData[0]
            .filter((seg) => Array.isArray(seg) && typeof seg[0] === "string")
            .map((seg) => seg[0]);
          result.context_translation = parts.join("").trim();
        }
      } catch (_) {}

      if (!result.context_translation) {
        const mmSent = await translateViaMyMemoryClient(shortSent, src, tgt, 3500);
        if (mmSent) {
          result.context_translation = mmSent;
        }
      }
    }

    // 4. Si estamos 100% sin Internet (o falló la traducción de frase) y el libro tiene su pareja bilingüe en memoria local,
    // mostrar la frase alineada del libro emparejado para dar contexto inmediato sin red
    const alignedOfflineSent = getAlignedPartnerSentenceOffline(currentDictSentenceIdx);
    if (!result.context_translation && alignedOfflineSent) {
      result.context_translation = `${alignedOfflineSent} [📖 De tu edición bilingüe enlazada]`;
    } else if (alignedOfflineSent && (!result.translation || result.translation.toLowerCase() === word.toLowerCase())) {
      result.translation = "Ver frase equivalente en tu edición bilingüe ↓";
    }

    saveCachedDictLookup(word, src, result);
    return result;
  }

  function hideDictionaryPopover() {
    if (els.dictPopover) {
      els.dictPopover.classList.add("hidden");
    }
  }

  function extractWordAtPoint(clientX, clientY) {
    // 1. Si el usuario ya tiene seleccionada una palabra corta, usarla
    const sel = window.getSelection();
    const selText = sel ? sel.toString().trim() : "";
    if (selText && selText.length <= 38 && !/\s/.test(selText)) {
      return selText;
    }

    // 2. Detectar el nodo de texto y carácter exacto bajo el cursor del ratón
    let textNode = null;
    let offset = 0;

    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(clientX, clientY);
      if (range) {
        textNode = range.startContainer;
        offset = range.startOffset;
      }
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(clientX, clientY);
      if (pos) {
        textNode = pos.offsetNode;
        offset = pos.offset;
      }
    }

    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return "";
    const text = textNode.textContent || "";
    if (!text) return "";

    const wordCharRegex = /[\p{L}\p{N}'’-]/u;
    let idx = offset;
    if (idx >= text.length || !wordCharRegex.test(text[idx])) {
      if (idx > 0 && wordCharRegex.test(text[idx - 1])) {
        idx = idx - 1;
      } else {
        return "";
      }
    }

    let start = idx;
    while (start > 0 && wordCharRegex.test(text[start - 1])) {
      start--;
    }
    let end = idx;
    while (end < text.length && wordCharRegex.test(text[end])) {
      end++;
    }

    const rawWord = text.slice(start, end).replace(/^['’-]+|['’-]+$/g, "");
    if (rawWord && sel) {
      try {
        const wordRange = document.createRange();
        wordRange.setStart(textNode, start);
        wordRange.setEnd(textNode, end);
        sel.removeAllRanges();
        sel.addRange(wordRange);
      } catch (_) {}
    }
    return rawWord;
  }

  async function handleReaderContextMenu(e) {
    const word = extractWordAtPoint(e.clientX, e.clientY);
    if (!word) return;

    e.preventDefault();
    e.stopPropagation();

    let sentenceSpan = e.target.closest ? e.target.closest(".tts-sentence") : null;
    if (!sentenceSpan) {
      const sel = window.getSelection();
      const anchorEl = sel && sel.anchorNode ? sel.anchorNode.parentElement : null;
      if (anchorEl && anchorEl.closest) {
        sentenceSpan = anchorEl.closest(".tts-sentence");
      }
    }
    const contextSentence = sentenceSpan ? sentenceSpan.textContent.trim() : "";
    const sIdx = sentenceSpan ? Number(sentenceSpan.dataset.index || 0) : state.sentenceIndex;
    const bookLang = state.currentBook ? state.currentBook.language : "en";

    currentDictSentence = contextSentence;
    currentDictSentenceIdx = Number.isNaN(sIdx) ? state.sentenceIndex : sIdx;
    await showDictionaryPopover(word, bookLang, contextSentence, e.clientX, e.clientY);
  }

  async function showDictionaryPopover(word, lang, sentence, clientX, clientY) {
    currentDictWord = word;
    currentDictLang = (lang || "en").toLowerCase().startsWith("es") ? "es" : "en";
    lastDictLookupResult = null;
    lastSavedVocabEntryId = null;

    els.dictWordTitle.textContent = word;
    els.dictPhonetic.textContent = "";
    const existingVocab =
      state.currentStudy && Array.isArray(state.currentStudy.vocabulary)
        ? state.currentStudy.vocabulary.find(
            (v) => (v.word || "").toLowerCase() === (word || "").toLowerCase()
          )
        : null;
    if (existingVocab) {
      lastSavedVocabEntryId = existingVocab.id;
      const savedNote = existingVocab.user_note || existingVocab.note || "";
      if (els.dictVocabNote) els.dictVocabNote.value = savedNote;
      if (els.btnDictUnderline) els.btnDictUnderline.textContent = "✓ Palabra subrayada";
      if (els.dictVocabStatus) {
        els.dictVocabStatus.textContent = savedNote
          ? "✓ Nota guardada en el cuaderno"
          : `Guardada (${existingVocab.lookup_count || 1}x)`;
      }
    } else {
      if (els.dictVocabNote) els.dictVocabNote.value = "";
      if (els.dictVocabStatus) els.dictVocabStatus.textContent = "";
      if (els.btnDictUnderline) {
        els.btnDictUnderline.textContent = "🖍️ Subrayar palabra";
      }
    }
    els.dictBody.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;color:var(--text-secondary)">
        <span class="spinner" style="border-color:var(--border-color);border-top-color:var(--accent)"></span>
        <span>Consultando traducción y diccionario (${currentDictLang.toUpperCase()})...</span>
      </div>
    `;

    // Posicionar el popover cerca del clic sin salirse de los bordes de la ventana
    dictOpenedAtMs = Date.now();
    els.dictPopover.classList.remove("hidden");
    const popWidth = Math.min(390, window.innerWidth - 24);
    const popHeight = 380;
    const left = Math.max(12, Math.min(window.innerWidth - popWidth - 12, clientX - 40));
    const top =
      clientY + popHeight + 24 < window.innerHeight
        ? clientY + 14
        : Math.max(66, clientY - popHeight - 10);

    els.dictPopover.style.left = `${left}px`;
    els.dictPopover.style.top = `${top}px`;

    let data = null;
    if (!state.isServerOffline) {
      try {
        const res = await fetchWithTimeout(
          "/api/dictionary/lookup",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              word,
              lang: currentDictLang,
              sentence,
            }),
          },
          2200
        );
        if (res.ok) {
          data = await res.json();
          saveCachedDictLookup(word, currentDictLang, data);
        }
      } catch (_) {
        markServerPotentiallyOffline().catch(() => {});
      }
    }

    try {
      if (!data || !hasRealDictDefinitions(data)) {
        data = await lookupDictionaryClientFallback(word, currentDictLang, sentence, data);
      }
      dictOpenedAtMs = Date.now();
      renderDictionaryContent(data);
    } catch (err) {
      if (data) {
        renderDictionaryContent(data);
      } else {
        els.dictBody.innerHTML = `<p style="color:#dc2626">No se pudo obtener la definición: ${escapeHtml(err.message)}</p>`;
      }
    }
  }

  function renderDictionaryContent(data) {
    lastDictLookupResult = data;
    if (data.lemma && data.lemma.toLowerCase() !== data.word.toLowerCase()) {
      els.dictWordTitle.innerHTML = `${escapeHtml(data.word)} <small style="font-weight:400;color:var(--text-secondary)">(${escapeHtml(data.lemma)})</small>`;
    } else {
      els.dictWordTitle.textContent = data.word;
    }
    const cleanPhon = String(data.phonetic || "").replace(/^\/+|\/+$/g, "");
    els.dictPhonetic.textContent = cleanPhon ? `/${cleanPhon}/` : "";

    const bilingualRows = (data.bilingual_entries || [])
      .map(
        (b) =>
          `<div class="dict-bilingual-pos"><em>${escapeHtml(b.pos)}:</em> ${b.terms.map(escapeHtml).join(", ")}</div>`
      )
      .join("");

    const contextHtml = data.context_translation
      ? `<div class="dict-context-box"><strong>Frase en contexto:</strong> «${escapeHtml(data.context_translation)}»</div>`
      : "";

    const defsArr = data.definitions || [];
    let defsHtml = "";
    if (defsArr.length > 0) {
      defsHtml = defsArr
        .map((d) => {
          const sensesHtml = (d.senses || [])
            .map(
              (s) => `
              <li>
                <span>${escapeHtml(s.definition)}</span>
                ${s.example ? `<span class="dict-sense-example">"${escapeHtml(s.example)}"</span>` : ""}
              </li>
            `
            )
            .join("");
          return `
            <div class="dict-def-block">
              ${d.part_of_speech ? `<span class="dict-pos-badge">${escapeHtml(d.part_of_speech)}</span>` : ""}
              <ol class="dict-sense-list">${sensesHtml}</ol>
            </div>
          `;
        })
        .join("");
    } else {
      defsHtml = `<p style="color:var(--text-secondary);font-size:0.82rem">Sin entradas adicionales en el diccionario monolingüe.</p>`;
    }

    els.dictBody.innerHTML = `
      <div class="dict-translation-box">
        <div class="dict-section-label">${escapeHtml(data.translation_lang_label || "Traducción")}</div>
        <div class="dict-primary-trans">${escapeHtml(data.translation || data.word)}</div>
        ${bilingualRows}
        ${contextHtml}
      </div>

      <div>
        <div class="dict-section-label">${escapeHtml(data.dictionary_lang_label || "Definición del diccionario")}</div>
        ${defsHtml}
      </div>
    `;

    // Verificar si la palabra ya estaba guardada o si debe subrayarse automáticamente al consultarla
    const existingEntry = findExistingVocabEntry(data.word, data.lemma);
    if (existingEntry && els.dictVocabNote) {
      els.dictVocabNote.value = existingEntry.user_note || existingEntry.note || "";
      lastSavedVocabEntryId = existingEntry.id;
    }

    const autoUnderline =
      !state.currentStudy || state.currentStudy.auto_underline_lookups !== false;
    if (autoUnderline && state.currentBook) {
      saveCurrentDictWordToVocab({ silent: true });
    } else if (existingEntry && els.dictVocabStatus) {
      els.dictVocabStatus.textContent = `✓ Ya subrayada en tu vocabulario (${existingEntry.lookup_count || 1}x)`;
      if (els.btnDictUnderline) els.btnDictUnderline.textContent = "💾 Actualizar nota";
    }
  }

  function findExistingVocabEntry(word, lemma) {
    if (!state.currentStudy || !Array.isArray(state.currentStudy.vocabulary)) return null;
    const wLow = String(word || "").trim().toLowerCase();
    const lLow = String(lemma || "").trim().toLowerCase();
    return state.currentStudy.vocabulary.find((v) => {
      const vw = String(v.word || "").toLowerCase();
      const vl = String(v.lemma || "").toLowerCase();
      return vw === wLow || (lLow && vl === lLow);
    });
  }

  const OFFLINE_STUDY_QUEUE_KEY = "vozlectura_pending_study_v1";

  function loadPendingOfflineStudyQueue() {
    try {
      const raw = localStorage.getItem(OFFLINE_STUDY_QUEUE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function enqueueOfflineStudyAction(item) {
    if (!item || !item.bookId || !item.type || !item.payload) return;
    try {
      const list = loadPendingOfflineStudyQueue();
      if (item.type === "vocab") {
        const wKey = String(item.payload.word || "").trim().toLowerCase();
        const existingIdx = list.findIndex(
          (x) =>
            x &&
            x.type === "vocab" &&
            x.bookId === item.bookId &&
            String((x.payload && x.payload.word) || "").trim().toLowerCase() === wKey
        );
        if (existingIdx >= 0) {
          list[existingIdx] = {
            ...list[existingIdx],
            payload: { ...list[existingIdx].payload, ...item.payload },
            savedAt: Date.now(),
          };
          localStorage.setItem(OFFLINE_STUDY_QUEUE_KEY, JSON.stringify(list));
          return;
        }
      }
      list.push({ ...item, id: `stq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, savedAt: Date.now() });
      localStorage.setItem(OFFLINE_STUDY_QUEUE_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  let isSyncingOfflineStudy = false;
  async function syncPendingOfflineStudyItems() {
    if (isSyncingOfflineStudy || state.isServerOffline) return 0;
    const queue = loadPendingOfflineStudyQueue();
    if (queue.length === 0) return 0;

    isSyncingOfflineStudy = true;
    let synced = 0;
    const remaining = [];
    try {
      for (const item of queue) {
        if (!item || !item.bookId || !item.payload) continue;
        const endpoint =
          item.type === "highlight"
            ? `/api/books/${encodeURIComponent(item.bookId)}/study/highlights`
            : `/api/books/${encodeURIComponent(item.bookId)}/study/vocabulary`;
        try {
          const res = await fetchWithTimeout(
            endpoint,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(item.payload),
            },
            3500
          );
          if (res && res.ok) {
            const data = await res.json().catch(() => null);
            if (data && data.study) {
              OfflineStore.updateBookStudy(
                item.bookId,
                data.study,
                data.obsidian_markdown || data.markdown || null
              );
              if (state.currentBook && state.currentBook.id === item.bookId) {
                state.currentStudy = data.study;
                if (data.obsidian_markdown || data.markdown) {
                  state.obsidianMarkdown = data.obsidian_markdown || data.markdown;
                }
                applyStudyDecorationsToChapter();
                updateStudyHeaderBadge();
              }
            }
            synced++;
          } else {
            remaining.push(item);
          }
        } catch (_) {
          remaining.push(item);
          break;
        }
      }
      localStorage.setItem(OFFLINE_STUDY_QUEUE_KEY, JSON.stringify(remaining));
    } catch (_) {
    } finally {
      isSyncingOfflineStudy = false;
    }
    return synced;
  }

  function ensureLocalStudyStructure() {
    if (!state.currentStudy || typeof state.currentStudy !== "object") {
      const localRec = state.currentBook ? state.offlineBooksMap.get(state.currentBook.id) : null;
      state.currentStudy =
        localRec && localRec.study
          ? localRec.study
          : {
              vocabulary: [],
              highlights: [],
              sessions: [],
              auto_underline_lookups: true,
            };
    }
    if (!Array.isArray(state.currentStudy.vocabulary)) state.currentStudy.vocabulary = [];
    if (!Array.isArray(state.currentStudy.highlights)) state.currentStudy.highlights = [];
    if (!Array.isArray(state.currentStudy.sessions)) state.currentStudy.sessions = [];
    return state.currentStudy;
  }

  async function saveCurrentDictWordToVocab({ silent = false } = {}) {
    if (!state.currentBook || !lastDictLookupResult) return;
    const d = lastDictLookupResult;
    const cleanPhon = String(d.phonetic || "").replace(/^\/+|\/+$/g, "");
    const firstDef =
      d.definitions &&
      d.definitions[0] &&
      d.definitions[0].senses &&
      d.definitions[0].senses[0]
        ? `${d.definitions[0].part_of_speech ? `(${d.definitions[0].part_of_speech}) ` : ""}${d.definitions[0].senses[0].definition}`
        : "";
    const noteText = els.dictVocabNote ? els.dictVocabNote.value.trim() : "";

    const vocabPayload = {
      word: d.word || currentDictWord,
      lemma: d.lemma || d.word || currentDictWord,
      source_lang: currentDictLang,
      lang: currentDictLang,
      phonetic: cleanPhon ? `/${cleanPhon}/` : "",
      translation: d.translation || "",
      definitions_summary: firstDef,
      context_sentence: currentDictSentence || "",
      context_translation: d.context_translation || "",
      chapter_index: state.chapterIndex,
      chapter_title: state.currentChapter ? state.currentChapter.title : "",
      sentence_index: currentDictSentenceIdx,
      user_note: noteText,
      note: noteText,
    };

    if (!state.isServerOffline) {
      try {
        // Si ya se había guardado en esta misma consulta y el usuario pulsa para guardar nota, actualizamos la nota sin duplicar el contador
        if (!silent && lastSavedVocabEntryId && !String(lastSavedVocabEntryId).startsWith("local_")) {
          const resUpd = await fetchWithTimeout(
            `/api/books/${state.currentBook.id}/study/vocabulary/${encodeURIComponent(lastSavedVocabEntryId)}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                user_note: noteText,
                note: noteText,
                translation: d.translation || undefined,
              }),
            },
            3200
          );
          if (resUpd.ok) {
            const updData = await resUpd.json();
            state.currentStudy = updData.study;
            if (updData.markdown || updData.obsidian_markdown) {
              state.obsidianMarkdown = updData.obsidian_markdown || updData.markdown;
            }
            OfflineStore.updateBookStudy(state.currentBook.id, state.currentStudy, state.obsidianMarkdown);
            applyStudyDecorationsToChapter();
            updateStudyHeaderBadge();
            if (els.dictVocabStatus) {
              els.dictVocabStatus.textContent = "✓ Nota de vocabulario guardada en Obsidian";
            }
            showToast("📝 Nota de palabra guardada en tu cuaderno de Obsidian");
            return;
          }
        }

        const res = await fetchWithTimeout(
          `/api/books/${state.currentBook.id}/study/vocabulary`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(vocabPayload),
          },
          3200
        );
        if (res.ok) {
          const resData = await res.json();
          state.currentStudy = resData.study;
          if (resData.markdown || resData.obsidian_markdown) {
            state.obsidianMarkdown = resData.obsidian_markdown || resData.markdown;
          }
          OfflineStore.updateBookStudy(state.currentBook.id, state.currentStudy, state.obsidianMarkdown);
          if (resData.entry) {
            lastSavedVocabEntryId = resData.entry.id;
            const savedNote = resData.entry.user_note || resData.entry.note || "";
            if (els.dictVocabNote && !els.dictVocabNote.value.trim() && savedNote) {
              els.dictVocabNote.value = savedNote;
            }
          }
          applyStudyDecorationsToChapter();
          updateStudyHeaderBadge();

          if (els.dictVocabStatus && resData.entry) {
            els.dictVocabStatus.textContent = noteText
              ? `✓ Subrayada con nota en Obsidian (consultada ${resData.entry.lookup_count || 1}x)`
              : `✓ Subrayada y guardada en nota Obsidian (consultada ${resData.entry.lookup_count || 1}x)`;
          }
          if (els.btnDictUnderline) {
            els.btnDictUnderline.textContent = "💾 Guardar nota";
          }
          if (!silent) {
            showToast(
              noteText
                ? `📝 Nota de «${d.word}» guardada en tu cuaderno de Obsidian`
                : `🖍️ «${d.word}» subrayada y añadida a tu nota de Obsidian`
            );
          }
          return;
        }
      } catch (_) {}
    }

    // Respaldo 100% Local Offline: guardar en el estudio local (IndexedDB + cola pendiente para sincronizar al volver a casa)
    const studyObj = ensureLocalStudyStructure();
    let localEntry = findExistingVocabEntry(vocabPayload.word, vocabPayload.lemma);
    if (localEntry) {
      if (!silent || !lastSavedVocabEntryId) {
        localEntry.lookup_count = Number(localEntry.lookup_count || 1) + (silent ? 1 : 0);
      }
      if (vocabPayload.translation) localEntry.translation = vocabPayload.translation;
      if (vocabPayload.phonetic) localEntry.phonetic = vocabPayload.phonetic;
      if (vocabPayload.definitions_summary) localEntry.definitions_summary = vocabPayload.definitions_summary;
      if (noteText || !silent) {
        localEntry.user_note = noteText;
        localEntry.note = noteText;
      }
    } else {
      localEntry = {
        id: `local_${Date.now().toString(36)}`,
        ...vocabPayload,
        lookup_count: 1,
        created_at: new Date().toISOString(),
      };
      studyObj.vocabulary.unshift(localEntry);
    }
    lastSavedVocabEntryId = localEntry.id;
    OfflineStore.updateBookStudy(state.currentBook.id, studyObj, state.obsidianMarkdown);
    enqueueOfflineStudyAction({
      type: "vocab",
      bookId: state.currentBook.id,
      payload: vocabPayload,
    });
    applyStudyDecorationsToChapter();
    updateStudyHeaderBadge();

    if (els.dictVocabStatus) {
      els.dictVocabStatus.textContent = noteText
        ? `✓ Subrayada con nota en local (${localEntry.lookup_count || 1}x • se sincronizará con Obsidian)`
        : `✓ Subrayada en local (${localEntry.lookup_count || 1}x • se sincronizará con Obsidian)`;
    }
    if (els.btnDictUnderline) {
      els.btnDictUnderline.textContent = "💾 Guardar nota";
    }
    if (!silent) {
      showToast(
        noteText
          ? `📝 Nota de «${d.word}» guardada en memoria local (se sincronizará al reconectar)`
          : `🖍️ «${d.word}» subrayada en memoria local (se sincronizará con Obsidian al reconectar)`
      );
    }
  }

  // =========================================================================
  // CUADERNO DE LECTURA, HÁBITOS, SUBRAYADOS, PASAJES Y NOTA OBSIDIAN (.MD)
  // =========================================================================
  let pendingSelectionInfo = null;
  let sessionHeartbeatTimer = null;

  async function fetchBookStudy(bookId) {
    if (!bookId) return null;
    try {
      const res = await fetch(`/api/books/${bookId}/study`);
      if (!res.ok) return null;
      const data = await res.json();
      if (state.currentBook && state.currentBook.id === bookId) {
        state.currentStudy = data.study;
        state.obsidianMarkdown = data.obsidian_markdown || data.markdown || "";
        updateStudyHeaderBadge();
      }
      return data;
    } catch (err) {
      console.error("Error cargando datos de estudio:", err);
      return null;
    }
  }

  function updateStudyHeaderBadge() {
    if (!els.btnOpenStudyLabel || !state.currentStudy) return;
    const hlCount = (state.currentStudy.highlights || []).length;
    const vcCount = (state.currentStudy.vocabulary || []).length;
    const total = hlCount + vcCount;
    els.btnOpenStudyLabel.textContent = total > 0 ? `Notas (${total})` : "Notas / Obsidian";
  }

  function escapeRegExp(str) {
    return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Subraya visualmente las palabras del vocabulario y colorea los pasajes resaltados en el capítulo abierto
  function applyStudyDecorationsToChapter() {
    if (!els.chapterContent || !state.currentChapter) return;
    const study = state.currentStudy;
    const spans = els.chapterContent.querySelectorAll(".tts-sentence");
    if (spans.length === 0) return;

    // 1. Restaurar el HTML limpio de cada frase antes de aplicar decoraciones
    spans.forEach((sp) => {
      if (sp.dataset.rawHtml !== undefined) {
        sp.innerHTML = sp.dataset.rawHtml;
      }
      sp.classList.remove("hl-yellow", "hl-green", "hl-blue", "hl-pink");
    });

    if (!study) return;

    // 2. Subrayar palabras del vocabulario buscadas en el diccionario
    const vocabList = study.vocabulary || [];
    if (vocabList.length > 0) {
      const wordMap = new Map();
      for (const v of vocabList) {
        const w = String(v.word || "").trim();
        if (w.length >= 2) wordMap.set(w.toLowerCase(), v);
        const l = String(v.lemma || "").trim();
        if (l.length >= 2 && !wordMap.has(l.toLowerCase())) {
          wordMap.set(l.toLowerCase(), v);
        }
      }

      const sortedWords = [...wordMap.keys()].sort((a, b) => b.length - a.length);
      if (sortedWords.length > 0) {
        const pattern = new RegExp(
          `(?<![\\p{L}\\p{N}])(${sortedWords.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`,
          "giu"
        );

        spans.forEach((sp) => {
          underlineTextNodesInElement(sp, pattern, wordMap);
        });
      }
    }

    // 3. Aplicar resaltados de frases/pasajes y globos de nota en este capítulo
    const chapterHighlights = (study.highlights || []).filter(
      (h) => Number(h.chapter_index) === Number(state.chapterIndex)
    );

    for (const hl of chapterHighlights) {
      const indicesArr = Array.isArray(hl.sentence_indices) ? hl.sentence_indices : [];
      const startIdx =
        hl.sentence_index !== undefined
          ? Number(hl.sentence_index)
          : indicesArr.length > 0
          ? Number(indicesArr[0])
          : 0;
      const endIdx = Math.max(
        startIdx,
        hl.end_sentence_index !== undefined
          ? Number(hl.end_sentence_index)
          : indicesArr.length > 0
          ? Number(indicesArr[indicesArr.length - 1])
          : startIdx
      );
      const colorClass = `hl-${hl.color || "yellow"}`;
      const hlText = hl.selected_text || hl.text || "";

      let lastSpanEl = null;
      for (let i = startIdx; i <= endIdx; i++) {
        const sp = document.getElementById(`sent-${i}`);
        if (sp) {
          sp.classList.add(colorClass);
          lastSpanEl = sp;
        }
      }

      if (lastSpanEl) {
        const badge = document.createElement("span");
        badge.className = "hl-note-badge";
        badge.textContent = hl.note ? "📝" : "🖍️";
        badge.title = hl.note
          ? `Nota: ${hl.note}\n(Pulsa para editar o ver en el cuaderno)`
          : "Pasaje resaltado (Pulsa para añadir o editar nota)";
        badge.addEventListener("click", async (e) => {
          e.stopPropagation();
          const newNote = prompt(
            `Editar nota para este pasaje resaltado:\n«${hlText.slice(0, 140)}»`,
            hl.note || ""
          );
          if (newNote === null) return;
          await updateHighlightItem(hl.id, { note: newNote.trim(), color: hl.color });
        });
        lastSpanEl.appendChild(badge);
      }
    }
  }

  function underlineTextNodesInElement(rootEl, regex, wordMap) {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let current = walker.nextNode();
    while (current) {
      textNodes.push(current);
      current = walker.nextNode();
    }

    for (const node of textNodes) {
      const text = node.nodeValue;
      if (!text) continue;
      regex.lastIndex = 0;
      if (!regex.test(text)) continue;

      regex.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const matchedStr = match[0];
        const offset = match.index;
        if (offset > lastIdx) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx, offset)));
        }
        const vEntry = wordMap.get(matchedStr.toLowerCase());
        const mark = document.createElement("mark");
        const vNote = vEntry ? vEntry.user_note || vEntry.note || "" : "";
        mark.className = vNote ? "vocab-underline has-vocab-note" : "vocab-underline";
        mark.textContent = matchedStr;
        if (vEntry) {
          const tipParts = [
            `${vEntry.word}${vEntry.phonetic ? ` ${vEntry.phonetic}` : ""} → ${vEntry.translation || ""}`,
          ];
          if (vEntry.definitions_summary) tipParts.push(vEntry.definitions_summary);
          if (vNote) tipParts.push(`📝 Nota: ${vNote}`);
          mark.title = tipParts.join("\n");
        }
        mark.addEventListener("click", async (e) => {
          e.stopPropagation();
          const sentenceSpan = mark.closest ? mark.closest(".tts-sentence") : null;
          const contextSentence = sentenceSpan ? sentenceSpan.textContent.trim() : "";
          const sIdx = sentenceSpan ? Number(sentenceSpan.dataset.index || 0) : state.sentenceIndex;
          const bookLang = state.currentBook ? state.currentBook.language : "en";
          currentDictSentence = contextSentence;
          currentDictSentenceIdx = Number.isNaN(sIdx) ? state.sentenceIndex : sIdx;
          await showDictionaryPopover(
            vEntry ? vEntry.word : matchedStr,
            bookLang,
            contextSentence,
            e.clientX || window.innerWidth / 2,
            e.clientY || window.innerHeight / 3
          );
        });
        frag.appendChild(mark);
        lastIdx = offset + matchedStr.length;
      }
      if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      if (node.parentNode) {
        node.parentNode.replaceChild(frag, node);
      }
    }
  }

  // Barra flotante al seleccionar un pasaje o frase con el ratón
  function hideSelectionToolbar() {
    pendingSelectionInfo = null;
    if (els.selectionToolbar) {
      els.selectionToolbar.classList.add("hidden");
    }
  }

  function handleReaderSelectionEnd() {
    if (els.dictPopover && !els.dictPopover.classList.contains("hidden") && Date.now() - dictOpenedAtMs < 2000) {
      // Actualizar marca de tiempo al soltar el dedo tras pulsación larga en Android para evitar que el click sintético cierre el diccionario
      dictOpenedAtMs = Date.now();
    }
    setTimeout(() => {
      if (els.dictPopover && !els.dictPopover.classList.contains("hidden") && Date.now() - dictOpenedAtMs < 650) {
        hideSelectionToolbar();
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        hideSelectionToolbar();
        return;
      }
      const rawText = sel.toString().trim();
      if (rawText.length < 3 || !els.chapterContent) {
        hideSelectionToolbar();
        return;
      }

      const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (!range || !els.chapterContent.contains(range.commonAncestorContainer)) {
        hideSelectionToolbar();
        return;
      }

      // Determinar qué frases (.tts-sentence) abarca la selección
      const startEl =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? range.startContainer
          : range.startContainer.parentElement;
      const endEl =
        range.endContainer.nodeType === Node.ELEMENT_NODE
          ? range.endContainer
          : range.endContainer.parentElement;

      const startSentSpan = startEl && startEl.closest ? startEl.closest(".tts-sentence") : null;
      const endSentSpan = endEl && endEl.closest ? endEl.closest(".tts-sentence") : null;

      let startIdx = startSentSpan ? Number(startSentSpan.dataset.index) : state.sentenceIndex;
      let endIdx = endSentSpan ? Number(endSentSpan.dataset.index) : startIdx;
      if (Number.isNaN(startIdx)) startIdx = state.sentenceIndex;
      if (Number.isNaN(endIdx)) endIdx = startIdx;
      if (endIdx < startIdx) {
        const tmp = startIdx;
        startIdx = endIdx;
        endIdx = tmp;
      }

      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        hideSelectionToolbar();
        return;
      }

      pendingSelectionInfo = {
        selectedText: rawText,
        startSentenceIndex: startIdx,
        endSentenceIndex: endIdx,
      };

      els.selectionToolbar.classList.remove("hidden");
      const tbWidth = 240;
      const left = Math.max(
        12,
        Math.min(window.innerWidth - tbWidth - 12, rect.left + rect.width / 2 - tbWidth / 2)
      );
      const top = rect.top > 64 ? rect.top - 46 : rect.bottom + 10;
      els.selectionToolbar.style.left = `${left}px`;
      els.selectionToolbar.style.top = `${top}px`;
    }, 30);
  }

  async function saveSelectionHighlight(color = "yellow", askForNote = false) {
    if (!state.currentBook || !pendingSelectionInfo) return;
    const info = pendingSelectionInfo;
    let noteText = "";
    if (askForNote) {
      const entered = prompt(
        `Añadir nota para el pasaje seleccionado:\n«${info.selectedText.slice(0, 120)}${info.selectedText.length > 120 ? "..." : ""}»`,
        ""
      );
      if (entered === null) return;
      noteText = entered.trim();
    }

    const indicesArr = [];
    for (let idx = info.startSentenceIndex; idx <= info.endSentenceIndex; idx++) {
      indicesArr.push(idx);
    }

    const hlPayload = {
      chapter_index: state.chapterIndex,
      chapter_title: state.currentChapter ? state.currentChapter.title : "",
      sentence_index: info.startSentenceIndex,
      end_sentence_index: info.endSentenceIndex,
      sentence_indices: indicesArr,
      text: info.selectedText,
      selected_text: info.selectedText,
      note: noteText,
      color,
    };

    if (!state.isServerOffline) {
      try {
        const res = await fetchWithTimeout(
          `/api/books/${state.currentBook.id}/study/highlights`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(hlPayload),
          },
          3200
        );
        if (res.ok) {
          const data = await res.json();
          state.currentStudy = data.study;
          if (data.markdown || data.obsidian_markdown) {
            state.obsidianMarkdown = data.obsidian_markdown || data.markdown;
          }
          OfflineStore.updateBookStudy(state.currentBook.id, state.currentStudy, state.obsidianMarkdown);

          const sel = window.getSelection();
          if (sel) sel.removeAllRanges();
          hideSelectionToolbar();

          applyStudyDecorationsToChapter();
          updateStudyHeaderBadge();
          showToast(
            noteText
              ? "📝 Pasaje y nota guardados en tu cuaderno de Obsidian"
              : "🖍️ Pasaje resaltado y guardado en tu nota de Obsidian"
          );
          return;
        }
      } catch (_) {}
    }

    // Respaldo 100% Local Offline para pasajes resaltados
    const studyObj = ensureLocalStudyStructure();
    studyObj.highlights.push({
      id: `local_hl_${Date.now().toString(36)}`,
      ...hlPayload,
      created_at: new Date().toISOString(),
    });
    OfflineStore.updateBookStudy(state.currentBook.id, studyObj, state.obsidianMarkdown);
    enqueueOfflineStudyAction({
      type: "highlight",
      bookId: state.currentBook.id,
      payload: hlPayload,
    });

    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    hideSelectionToolbar();

    applyStudyDecorationsToChapter();
    updateStudyHeaderBadge();
    showToast(
      noteText
        ? "📝 Pasaje y nota guardados en memoria local (se sincronizarán con Obsidian)"
        : "🖍️ Pasaje resaltado en memoria local (se sincronizará con Obsidian)"
    );
  }

  async function updateHighlightItem(highlightId, { note, color }) {
    const targetBook = state.studyTargetBook || state.currentBook;
    if (!targetBook) return;
    try {
      const res = await fetch(
        `/api/books/${targetBook.id}/study/highlights/${encodeURIComponent(highlightId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note, color }),
        }
      );
      if (!res.ok) return;
      const data = await res.json();
      if (state.currentBook && state.currentBook.id === targetBook.id) {
        state.currentStudy = data.study;
        applyStudyDecorationsToChapter();
      }
      showToast("Nota actualizada");
    } catch (_) {}
  }

  // Cola persistente de sesiones de lectura offline (para sincronizar automáticamente al recuperar conexión)
  const OFFLINE_SESSIONS_STORAGE_KEY = "vozlectura_pending_sessions_v1";

  function loadPendingOfflineSessionsMap() {
    try {
      const raw = localStorage.getItem(OFFLINE_SESSIONS_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function savePendingOfflineSessionLocal(bookId, sessionPayload) {
    if (!bookId || !sessionPayload || !sessionPayload.session_id) return;
    try {
      const map = loadPendingOfflineSessionsMap();
      map[sessionPayload.session_id] = {
        bookId,
        payload: sessionPayload,
        savedAt: Date.now(),
      };
      localStorage.setItem(OFFLINE_SESSIONS_STORAGE_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  function removePendingOfflineSessionLocal(sessionId) {
    if (!sessionId) return;
    try {
      const map = loadPendingOfflineSessionsMap();
      if (map[sessionId]) {
        delete map[sessionId];
        localStorage.setItem(OFFLINE_SESSIONS_STORAGE_KEY, JSON.stringify(map));
      }
    } catch (_) {}
  }

  let isSyncingOfflineSessions = false;
  async function syncPendingOfflineSessions() {
    if (isSyncingOfflineSessions || state.isServerOffline) return 0;
    const map = loadPendingOfflineSessionsMap();
    const entries = Object.values(map);
    if (entries.length === 0) return 0;

    isSyncingOfflineSessions = true;
    let syncedCount = 0;
    try {
      for (const item of entries) {
        if (!item || !item.bookId || !item.payload) continue;
        const p = item.payload;
        const sents = Number(p.sentences_read || 0);
        // Descartar sesiones fantasma en la cola local que tuvieran 0 frases leídas
        if (sents < 2 && !p.note) {
          removePendingOfflineSessionLocal(p.session_id);
          continue;
        }
        // Recalibrar duraciones infladas por pestañas abiertas en pausa antes de enviar
        if (sents > 0 && !p.note) {
          const maxRealisticSec = Math.max(60, Math.round(sents * 6.0));
          if (Number(p.duration_seconds || 0) > maxRealisticSec) {
            p.duration_seconds = Math.max(60, Math.round(sents * 4.2));
            p.duration_minutes = Math.max(1, Math.round((p.duration_seconds / 60) * 10) / 10);
          }
        }
        try {
          const res = await fetchWithTimeout(
            `/api/books/${encodeURIComponent(item.bookId)}/study/sessions`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(p),
            },
            3500
          );
          if (res && res.ok) {
            // Si la sesión ya no es la sesión activa en curso, eliminarla de la cola pendiente
            if (!state.activeSession || state.activeSession.sessionId !== p.session_id) {
              removePendingOfflineSessionLocal(p.session_id);
            }
            syncedCount++;
          }
        } catch (_) {
          break;
        }
      }
    } finally {
      isSyncingOfflineSessions = false;
    }
    return syncedCount;
  }

  // Registro automático de sesiones de lectura (basado exclusivamente en tiempo real de escucha activa o paso de página)
  function getLocalIsoDateStr(d = new Date()) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function startReadingSessionForCurrentBook() {
    clearInterval(sessionHeartbeatTimer);
    if (!state.currentBook) return;

    const now = new Date();
    state.activeSession = {
      sessionId: `sess_${Date.now().toString(36)}`,
      bookId: state.currentBook.id,
      dateStr: getLocalIsoDateStr(now),
      startedAtIso: now.toISOString(),
      startedAtMs: now.getTime(),
      lastTickMs: now.getTime(),
      audioActiveSec: 0,
      manualReadingSec: 0,
      manualPagesRead: 0,
      lastManualPageTurnMs: 0,
      startChapterIndex: state.chapterIndex,
      startChapterTitle: state.currentChapter ? state.currentChapter.title : `Cap. ${state.chapterIndex + 1}`,
      sentencesRead: 0,
    };

    sessionHeartbeatTimer = setInterval(() => {
      if (!state.activeSession) return;
      const nowTick = new Date();
      const todayIso = getLocalIsoDateStr(nowTick);

      // Si cambió el día natural (ej. lectura nocturna pasando de medianoche o tablet reabierta al día siguiente),
      // cerrar la sesión del día anterior y abrir una nueva sesión en el nuevo día
      if (state.activeSession.dateStr && state.activeSession.dateStr !== todayIso) {
        flushActiveReadingSession({ keepActive: false }).finally(() => {
          if (state.currentBook && (!els.readerView || !els.readerView.classList.contains("hidden"))) {
            startReadingSessionForCurrentBook();
          }
        });
        return;
      }

      state.activeSession.lastTickMs = nowTick.getTime();

      // Solo sincronizar periódicamente cuando el usuario realmente está reproduciendo o ha leído frases/páginas
      if (
        state.isPlaying ||
        (state.activeSession.sentencesRead || 0) >= 2 ||
        (state.activeSession.manualPagesRead || 0) >= 1
      ) {
        flushActiveReadingSession({ keepActive: true });
      }
    }, 30000);
  }

  async function flushActiveReadingSession({ keepActive = false } = {}) {
    if (!state.activeSession) return;
    const sess = state.activeSession;
    const nowMs = Date.now();
    sess.lastTickMs = nowMs;

    const sents = Number(sess.sentencesRead || 0);
    const manualPages = Number(sess.manualPagesRead || 0);
    const audioSec = Number(sess.audioActiveSec || 0);
    const manualSec = Number(sess.manualReadingSec || 0);

    if (!keepActive) {
      clearInterval(sessionHeartbeatTimer);
      state.activeSession = null;
    }

    // No guardar jamás sesiones vacías por simplemente abrir un libro o dejar la pestaña abierta en pausa
    if (sents < 2 && manualPages < 1) {
      return;
    }

    // Tiempo real efectivo: suma exacta del audio reproducido + lectura manual de hojas
    // Si por algún motivo audioSec es 0 pero se leyeron frases, estimar ~4.2s por frase; y limitar el máximo por frase a ~6.0s
    let effectiveAudioSec = audioSec > 0 ? audioSec : sents * 4.2;
    if (sents > 0) {
      effectiveAudioSec = Math.min(effectiveAudioSec, Math.max(30, sents * 6.0));
    }
    const effectiveSec = effectiveAudioSec + manualSec;

    if (effectiveSec < 15 && sents < 2) {
      return;
    }

    const durationSeconds = Math.max(10, Math.round(effectiveSec));
    const durationMinutes = Math.max(1, Math.round((durationSeconds / 60) * 10) / 10);
    const endChapterIdx =
      state.currentBook && state.currentBook.id === sess.bookId
        ? state.chapterIndex
        : sess.startChapterIndex;
    const endChapterTitle =
      state.currentBook && state.currentBook.id === sess.bookId && state.currentChapter
        ? state.currentChapter.title
        : sess.startChapterTitle;

    const sessionPayload = {
      session_id: sess.sessionId,
      date: sess.dateStr || getLocalIsoDateStr(new Date(sess.startedAtMs)),
      started_at: sess.startedAtIso,
      ended_at: new Date(nowMs).toISOString(),
      duration_seconds: durationSeconds,
      duration_minutes: durationMinutes,
      start_chapter: sess.startChapterIndex,
      end_chapter: endChapterIdx,
      chapter_title: endChapterTitle,
      start_chapter_index: sess.startChapterIndex,
      end_chapter_index: endChapterIdx,
      start_chapter_title: sess.startChapterTitle,
      end_chapter_title: endChapterTitle,
      sentences_read: sents,
    };

    // 1. Guardar SIEMPRE primero en la cola local del dispositivo para no perder jamás sesiones leídas Offline
    savePendingOfflineSessionLocal(sess.bookId, sessionPayload);

    // 2. Intentar enviar al servidor si hay conexión
    try {
      const res = await fetchWithTimeout(
        `/api/books/${sess.bookId}/study/sessions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sessionPayload),
        },
        3500
      );
      if (res && res.ok) {
        if (!keepActive) {
          removePendingOfflineSessionLocal(sess.sessionId);
        }
        if (state.currentBook && state.currentBook.id === sess.bookId) {
          const data = await res.json();
          state.currentStudy = data.study;
        }
      }
    } catch (_) {
      // Queda guardada en localStorage (OFFLINE_SESSIONS_STORAGE_KEY) y se sincronizará automáticamente al volver online
    }
  }

  let currentActiveStudyTab = "habits";

  // Modal Cuaderno de Lectura y Exportación a Obsidian (.md)
  async function openStudyModal(bookObj = null, initialTab = "habits") {
    const target = bookObj || state.currentBook;
    if (!target) return;
    state.studyTargetBook = target;
    els.studyBookTitle.textContent = target.title;

    if (state.currentBook && state.currentBook.id === target.id && state.activeSession) {
      await flushActiveReadingSession({ keepActive: true });
    }
    await syncPendingOfflineSessions();
    await syncPendingOfflineStudyItems();

    let study = null;
    let obsidianConfig = null;
    if (!state.isServerOffline) {
      try {
        const res = await fetchWithTimeout(`/api/books/${target.id}/study`, {}, 3200);
        if (res.ok) {
          const data = await res.json();
          study = data.study;
          obsidianConfig = data.obsidian_config || null;
          state.obsidianMarkdown = data.obsidian_markdown || data.markdown || "";
          if (state.currentBook && state.currentBook.id === target.id) {
            state.currentStudy = study;
          }
          OfflineStore.updateBookStudy(target.id, study, state.obsidianMarkdown);
        }
      } catch (_) {}
    }

    if (!study) {
      const localRec = state.offlineBooksMap.get(target.id);
      if (state.currentBook && state.currentBook.id === target.id && state.currentStudy) {
        study = state.currentStudy;
      } else if (localRec && localRec.study) {
        study = localRec.study;
        if (localRec.obsidian_markdown) {
          state.obsidianMarkdown = localRec.obsidian_markdown;
        }
      } else {
        study = {
          reading_status: target.reading_status || "reading",
          rating: target.rating || 0,
          genre: target.genre || "",
          published_date: target.published_date || "",
          highlights: [],
          vocabulary: [],
          sessions: [],
          auto_underline_lookups: true,
        };
      }
    }

    renderStudyModalData(study, state.obsidianMarkdown, obsidianConfig);
    switchStudyTab(initialTab);
    els.studyModal.classList.remove("hidden");
  }

  function switchStudyTab(tabName) {
    currentActiveStudyTab = tabName || "habits";
    document.querySelectorAll(".study-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.studyTab === tabName);
    });
    const panes = {
      habits: document.getElementById("study-pane-habits"),
      highlights: document.getElementById("study-pane-highlights"),
      vocab: document.getElementById("study-pane-vocab"),
      obsidian: document.getElementById("study-pane-obsidian"),
    };
    Object.entries(panes).forEach(([k, el]) => {
      if (el) el.classList.toggle("hidden", k !== tabName);
    });
  }

  function formatTsToIsoDate(val) {
    if (!val) return "";
    if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}/.test(val)) {
      return val.slice(0, 10);
    }
    const n = Number(val);
    if (!Number.isNaN(n) && n > 100000) {
      return new Date(n * 1000).toISOString().slice(0, 10);
    }
    return "";
  }

  function renderStudyModalData(study, markdownText, obsidianConfig = null) {
    if (!study) return;
    const hls = study.highlights || [];
    const voc = study.vocabulary || [];
    const sessions = study.sessions || [];

    els.studyCountHighlights.textContent = String(hls.length);
    els.studyCountVocab.textContent = String(voc.length);

    renderStudyPairedBanner(study);

    els.studyStatus.value = study.reading_status || "reading";
    els.studyStartedAt.value =
      study.stats && study.stats.started_date_str && study.stats.started_date_str !== "—"
        ? study.stats.started_date_str
        : formatTsToIsoDate(study.started_at);
    els.studyFinishedAt.value =
      study.stats &&
      study.stats.finished_date_str &&
      study.stats.finished_date_str !== "—" &&
      study.stats.finished_date_str !== "En curso"
        ? study.stats.finished_date_str
        : formatTsToIsoDate(study.finished_at);
    els.studyTimesRead.value = String(study.times_read ?? 1);
    els.studyRating.value = String(normalizeHalfStarRating(study.rating ?? 0));
    if (els.studyGenre) {
      const targetBook = state.studyTargetBook || {};
      els.studyGenre.value =
        study.genre ||
        targetBook.genre ||
        (Array.isArray(targetBook.genres) && targetBook.genres[0]) ||
        "";
    }
    if (els.studyPublishedDate) {
      const targetBook = state.studyTargetBook || {};
      els.studyPublishedDate.value =
        study.published_date ||
        targetBook.published_date ||
        (targetBook.published_year ? String(targetBook.published_year) : "") ||
        "";
    }
    els.chkStudyAutoUnderline.checked = study.auto_underline_lookups !== false;
    els.studyBookNotes.value = study.general_notes || study.book_notes || "";
    updateStudyRichNotesView(els.studyBookNotes.value, true);

    const totalMins = Math.round(
      sessions.reduce(
        (acc, s) =>
          acc +
          (s.duration_minutes !== undefined
            ? Number(s.duration_minutes)
            : Math.max(1, Math.round((Number(s.duration_seconds) || 60) / 60))),
        0
      )
    );
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    const timeStr = hrs > 0 ? `${hrs} h ${mins} min` : `${mins} min`;
    els.studyTotalStats.textContent = `📊 Tiempo total registrado: ${timeStr} en ${sessions.length} ${sessions.length === 1 ? "sesión" : "sesiones"} • ${hls.length} pasajes • ${voc.length} palabras`;

    // 1. Renderizar lista de sesiones de lectura
    els.studySessionsList.innerHTML = "";
    if (sessions.length === 0) {
      els.studySessionsList.innerHTML = `<p style="color:var(--text-secondary);font-size:0.84rem">Aún no hay sesiones registradas. Se irán guardando automáticamente mientras lees o escuchas el libro.</p>`;
    } else {
      for (const s of [...sessions]) {
        const card = document.createElement("div");
        card.className = "study-item-card";
        const sDate = s.date || formatTsToIsoDate(s.started_at) || "Reciente";
        const sMins =
          s.duration_minutes !== undefined
            ? s.duration_minutes
            : Math.max(1, Math.round((Number(s.duration_seconds) || 60) / 60));
        const chRange =
          s.chapter_title ||
          (s.start_chapter_title && s.end_chapter_title && s.start_chapter_title !== s.end_chapter_title
            ? `${s.start_chapter_title} → ${s.end_chapter_title}`
            : s.end_chapter_title ||
              s.start_chapter_title ||
              `Cap. ${(s.start_chapter ?? s.start_chapter_index ?? 0) + 1}`);
        card.innerHTML = `
          <div class="study-item-header">
            <div>
              <strong>📅 ${escapeHtml(sDate)}</strong>
              <span class="badge-pill" style="margin-left:6px">⏱️ ${sMins} min</span>
              <small style="color:var(--text-secondary);margin-left:6px">${escapeHtml(chRange)} (${s.sentences_read || 0} frases)</small>
            </div>
            <button class="delete-book-btn btn-del-session" data-id="${s.id}" title="Borrar sesión" style="padding:3px 8px;font-size:0.75rem">🗑</button>
          </div>
          ${s.note ? `<p style="font-size:0.82rem;color:var(--text-secondary);margin:0">📝 ${escapeHtml(s.note)}</p>` : ""}
        `;
        card.querySelector(".btn-del-session").addEventListener("click", async () => {
          if (!state.studyTargetBook) return;
          const res = await fetch(
            `/api/books/${state.studyTargetBook.id}/study/sessions/${encodeURIComponent(s.id)}`,
            { method: "DELETE" }
          );
          if (res.ok) {
            await openStudyModal(state.studyTargetBook, "habits");
          }
        });
        els.studySessionsList.appendChild(card);
      }
    }

    // 2. Renderizar lista de pasajes resaltados y notas
    els.studyHighlightsList.innerHTML = "";
    if (hls.length === 0) {
      els.studyHighlightsList.innerHTML = `<p style="color:var(--text-secondary);font-size:0.84rem">Aún no has resaltado ningún pasaje en este libro.</p>`;
    } else {
      for (const h of hls) {
        const card = document.createElement("div");
        card.className = "study-item-card";
        const colorIcon =
          { yellow: "🟡", green: "🟢", blue: "🔵", pink: "🩷" }[h.color] || "🟡";
        const hText = h.selected_text || h.text || "";
        const hSentIdx =
          h.sentence_index !== undefined
            ? Number(h.sentence_index)
            : Array.isArray(h.sentence_indices) && h.sentence_indices.length > 0
            ? Number(h.sentence_indices[0])
            : 0;
        card.innerHTML = `
          <div class="study-item-header">
            <div>
              <span>${colorIcon}</span>
              <strong>${escapeHtml(h.chapter_title || `Capítulo ${(h.chapter_index || 0) + 1}`)}</strong>
              <small style="color:var(--text-secondary);margin-left:6px">Frase ${hSentIdx + 1}</small>
            </div>
            <div style="display:flex;gap:6px">
              <button class="secondary-btn btn-jump-hl" style="padding:4px 9px;font-size:0.76rem">📖 Ir al pasaje</button>
              <button class="secondary-btn btn-edit-hl" style="padding:4px 9px;font-size:0.76rem">✏️ Editar nota</button>
              <button class="delete-book-btn btn-del-hl" style="padding:4px 8px;font-size:0.76rem">🗑</button>
            </div>
          </div>
          <div class="study-quote-text">«${escapeHtml(hText)}»</div>
          ${
            h.note
              ? `<div style="font-size:0.85rem"><strong>📝 Nota:</strong> ${escapeHtml(h.note)}</div>`
              : `<small style="color:var(--text-secondary)">Sin nota adjunta (pulsa «Editar nota» para añadir una)</small>`
          }
        `;
        card.querySelector(".btn-jump-hl").addEventListener("click", async () => {
          if (state.studyTargetBook && state.studyTargetBook.is_archived) {
            showToast(
              "🗄️ El archivo EPUB se borró para ahorrar espacio. Vuelve a añadir el EPUB si deseas saltar al texto."
            );
            return;
          }
          els.studyModal.classList.add("hidden");
          if (!state.currentBook || state.currentBook.id !== state.studyTargetBook.id) {
            await openBook(state.studyTargetBook.id, {
              overrideChapterIndex: h.chapter_index || 0,
              overrideSentenceIndex: hSentIdx,
            });
          } else {
            await loadChapter(h.chapter_index || 0, hSentIdx, false);
          }
        });
        card.querySelector(".btn-edit-hl").addEventListener("click", async () => {
          const updated = prompt("Nota para este pasaje:", h.note || "");
          if (updated === null) return;
          await updateHighlightItem(h.id, { note: updated.trim(), color: h.color });
          await openStudyModal(state.studyTargetBook, "highlights");
        });
        card.querySelector(".btn-del-hl").addEventListener("click", async () => {
          if (!confirm("¿Eliminar este resaltado y su nota?")) return;
          const res = await fetch(
            `/api/books/${state.studyTargetBook.id}/study/highlights/${encodeURIComponent(h.id)}`,
            { method: "DELETE" }
          );
          if (res.ok) {
            const d = await res.json();
            if (state.currentBook && state.currentBook.id === state.studyTargetBook.id) {
              state.currentStudy = d.study;
              applyStudyDecorationsToChapter();
              updateStudyHeaderBadge();
            }
            await openStudyModal(state.studyTargetBook, "highlights");
          }
        });
        els.studyHighlightsList.appendChild(card);
      }
    }

    // 3. Renderizar lista de vocabulario subrayado
    els.studyVocabList.innerHTML = "";
    if (voc.length === 0) {
      els.studyVocabList.innerHTML = `<p style="color:var(--text-secondary);font-size:0.84rem">Aún no hay palabras subrayadas. Haz clic derecho sobre cualquier palabra mientras lees para traducirla y subrayarla.</p>`;
    } else {
      for (const v of voc) {
        const card = document.createElement("div");
        card.className = "study-item-card";
        const vNote = v.user_note || v.note || "";
        card.innerHTML = `
          <div class="study-item-header">
            <div>
              <strong style="font-size:1rem;color:var(--accent)">${escapeHtml(v.word)}</strong>
              ${v.phonetic ? `<span class="dict-phonetic" style="margin-left:6px">${escapeHtml(v.phonetic)}</span>` : ""}
              <span style="margin-left:8px;font-weight:700">→ ${escapeHtml(v.translation || "—")}</span>
              <span class="badge-pill" style="margin-left:6px">${v.lookup_count || 1}x</span>
            </div>
            <div style="display:flex;gap:6px">
              <button class="secondary-btn btn-jump-vocab" style="padding:4px 9px;font-size:0.76rem">📖 Ir al texto</button>
              <button class="secondary-btn btn-edit-vocab" style="padding:4px 9px;font-size:0.76rem">✏️ Nota</button>
              <button class="delete-book-btn btn-del-vocab" style="padding:4px 8px;font-size:0.76rem">🗑</button>
            </div>
          </div>
          ${v.definitions_summary ? `<div style="font-size:0.83rem">${escapeHtml(v.definitions_summary)}</div>` : ""}
          ${v.context_sentence ? `<div class="study-quote-text" style="font-size:0.81rem">«${escapeHtml(v.context_sentence)}» <small style="color:var(--text-secondary)">(${escapeHtml(v.chapter_title || `Cap. ${(v.chapter_index || 0) + 1}`)})</small></div>` : ""}
          ${
            vNote
              ? `<div style="font-size:0.83rem"><strong>📝 Nota:</strong> ${escapeHtml(vNote)}</div>`
              : `<small style="color:var(--text-secondary)">Sin nota personal (pulsa «✏️ Nota» para añadir una)</small>`
          }
        `;
        card.querySelector(".btn-jump-vocab").addEventListener("click", async () => {
          if (state.studyTargetBook && state.studyTargetBook.is_archived) {
            showToast(
              "🗄️ El archivo EPUB se borró para ahorrar espacio. Vuelve a añadir el EPUB si deseas saltar al texto."
            );
            return;
          }
          els.studyModal.classList.add("hidden");
          if (!state.currentBook || state.currentBook.id !== state.studyTargetBook.id) {
            await openBook(state.studyTargetBook.id, {
              overrideChapterIndex: v.chapter_index || 0,
              overrideSentenceIndex: v.sentence_index || 0,
            });
          } else {
            await loadChapter(v.chapter_index || 0, v.sentence_index || 0, false);
          }
        });
        card.querySelector(".btn-edit-vocab").addEventListener("click", async () => {
          const updated = prompt(`Nota personal para la palabra «${v.word}»:`, vNote);
          if (updated === null) return;
          await fetch(
            `/api/books/${state.studyTargetBook.id}/study/vocabulary/${encodeURIComponent(v.id)}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                user_note: updated.trim(),
                note: updated.trim(),
              }),
            }
          );
          if (state.currentBook && state.currentBook.id === state.studyTargetBook.id) {
            await fetchBookStudy(state.currentBook.id);
            applyStudyDecorationsToChapter();
          }
          await openStudyModal(state.studyTargetBook, "vocab");
        });
        card.querySelector(".btn-del-vocab").addEventListener("click", async () => {
          const res = await fetch(
            `/api/books/${state.studyTargetBook.id}/study/vocabulary/${encodeURIComponent(v.id)}`,
            { method: "DELETE" }
          );
          if (res.ok) {
            const d = await res.json();
            if (state.currentBook && state.currentBook.id === state.studyTargetBook.id) {
              state.currentStudy = d.study;
              applyStudyDecorationsToChapter();
              updateStudyHeaderBadge();
            }
            await openStudyModal(state.studyTargetBook, "vocab");
          }
        });
        els.studyVocabList.appendChild(card);
      }
    }

    // 4. Vista previa editable y configuración de conexión directa con Obsidian
    if (els.studyObsidianPreview) {
      els.studyObsidianPreview.value = markdownText || "";
    }
    if (obsidianConfig) {
      renderObsidianVaultConfigUi(obsidianConfig, study);
    }
  }

  function renderObsidianRichMarkdownToHtml(mdText) {
    const raw = (mdText || "").trim();
    if (!raw) {
      return `<p style="color:var(--text-secondary);margin:0"><em>Sin notas aún. Escribe en el cuadro inferior o en Obsidian para ver tus apuntes e imágenes aquí.</em></p>`;
    }
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    const htmlParts = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        htmlParts.push(`<div style="height:6px"></div>`);
        continue;
      }
      // Imágenes embebidas de Obsidian: ![[Pasted image 20261101063006.png|300]]
      const wikiImgMatch = trimmed.match(/^!\[\[([^\]]+)\]\]$/);
      if (wikiImgMatch) {
        const parts = wikiImgMatch[1].split("|");
        const imgName = parts[0].trim();
        const widthAttr = parts[1] && /^\d+$/.test(parts[1].trim()) ? `max-width:${parts[1].trim()}px;` : "max-width:100%;";
        const srcUrl = `/api/obsidian/attachment?name=${encodeURIComponent(imgName)}`;
        htmlParts.push(
          `<div style="margin:8px 0"><img src="${srcUrl}" alt="${escapeHtml(imgName)}" loading="lazy" style="${widthAttr}height:auto;border-radius:8px;border:1px solid var(--border-color);box-shadow:0 2px 8px rgba(0,0,0,0.12)" /></div>`
        );
        continue;
      }
      // Imágenes Markdown estándar: ![Portada|250](https://...)
      const mdImgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (mdImgMatch) {
        const altParts = mdImgMatch[1].split("|");
        const altText = altParts[0].trim();
        const widthAttr = altParts[1] && /^\d+$/.test(altParts[1].trim()) ? `max-width:${altParts[1].trim()}px;` : "max-width:100%;";
        const imgUrl = mdImgMatch[2].trim();
        htmlParts.push(
          `<div style="margin:8px 0"><img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(altText)}" loading="lazy" style="${widthAttr}height:auto;border-radius:8px;border:1px solid var(--border-color)" /></div>`
        );
        continue;
      }
      if (trimmed.startsWith("### ")) {
        htmlParts.push(`<h5 style="margin:10px 0 4px;font-size:0.95rem;color:var(--accent-color)">${formatInlineObsidianMd(trimmed.slice(4))}</h5>`);
      } else if (trimmed.startsWith("## ")) {
        htmlParts.push(`<h4 style="margin:12px 0 6px;font-size:1.02rem;border-bottom:1px solid var(--border-color);padding-bottom:3px">${formatInlineObsidianMd(trimmed.slice(3))}</h4>`);
      } else if (trimmed.startsWith("# ")) {
        htmlParts.push(`<h3 style="margin:14px 0 6px;font-size:1.1rem;color:#9333ea">${formatInlineObsidianMd(trimmed.slice(2))}</h3>`);
      } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        htmlParts.push(`<div style="padding-left:14px;margin:2px 0">• ${formatInlineObsidianMd(trimmed.slice(2))}</div>`);
      } else if (trimmed.startsWith("> ")) {
        htmlParts.push(`<blockquote style="margin:6px 0;padding:6px 12px;border-left:3px solid #a855f7;background:rgba(168,85,247,0.06);border-radius:4px">${formatInlineObsidianMd(trimmed.slice(2))}</blockquote>`);
      } else {
        htmlParts.push(`<p style="margin:4px 0">${formatInlineObsidianMd(trimmed)}</p>`);
      }
    }
    return htmlParts.join("\n");
  }

  function formatInlineObsidianMd(text) {
    let safe = escapeHtml(text || "");
    // Imágenes inline ![[...]]
    safe = safe.replace(/!\[\[([^\]]+)\]\]/g, (_, inner) => {
      const p = inner.split("|");
      const name = p[0].trim();
      const src = `/api/obsidian/attachment?name=${encodeURIComponent(name)}`;
      return `<img src="${src}" alt="${ name }" style="max-width:100%;height:auto;border-radius:6px;margin:4px 0" />`;
    });
    // Negrita **texto**
    safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // Cursiva *texto* o _texto_
    safe = safe.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    // Enlaces internos de Obsidian [[Nota]]
    safe = safe.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
      return `<span style="color:#9333ea;font-weight:600">🟣 ${alias || target}</span>`;
    });
    return safe;
  }

  function updateStudyRichNotesView(notesText, autoShowIfRich = false) {
    const richBox = document.getElementById("study-book-notes-rich-view");
    if (!richBox) return;
    const raw = (notesText || "").trim();
    richBox.innerHTML = renderObsidianRichMarkdownToHtml(raw);
    if (autoShowIfRich) {
      const hasRichSyntax = /(^#+\s|!\[\[|!\[|\*\*|^-\s)/m.test(raw);
      if (hasRichSyntax && raw.length > 0) {
        richBox.classList.remove("hidden");
      } else {
        richBox.classList.add("hidden");
      }
    }
  }

  function renderObsidianVaultConfigUi(obsCfg, study) {
    const vaultSelect = document.getElementById("obsidian-vault-select");
    const subfolderInput = document.getElementById("obsidian-subfolder-input");
    const linkFileInput = document.getElementById("obsidian-link-file-select");
    const filesDatalist = document.getElementById("obsidian-vault-files-datalist");
    const badgeTop = document.getElementById("obsidian-sync-status-badge");
    const activePathBadge = document.getElementById("obsidian-vault-active-path");
    const notesHint = document.getElementById("study-notes-sync-hint");
    const btnOpenInObsidian = document.getElementById("btn-open-in-obsidian-app");

    const vaults = Array.isArray(obsCfg.available_vaults) ? obsCfg.available_vaults : [];
    const activeVaultName = obsCfg.vault_name || "Personal";
    const linkedRel = obsCfg.book_linked_relpath || (study && study.obsidian_linked_relpath) || "";

    if (vaultSelect) {
      vaultSelect.innerHTML = "";
      if (vaults.length === 0) {
        const opt = document.createElement("option");
        opt.value = obsCfg.vault_path || "";
        opt.textContent = `📁 ${obsCfg.display_path || "Carpeta local obsidian_notes"}`;
        vaultSelect.appendChild(opt);
      } else {
        for (const v of vaults) {
          const opt = document.createElement("option");
          opt.value = v.path;
          opt.textContent = `🟣 Bóveda «${v.name}» (${v.display_path})`;
          vaultSelect.appendChild(opt);
        }
      }
      if (obsCfg.vault_path) {
        vaultSelect.value = obsCfg.vault_path;
      }
    }

    if (subfolderInput && obsCfg.books_subfolder !== undefined) {
      subfolderInput.value = obsCfg.books_subfolder;
    }

    if (linkFileInput) {
      linkFileInput.value = linkedRel;
    }

    if (filesDatalist && Array.isArray(obsCfg.vault_md_files)) {
      filesDatalist.innerHTML = "";
      for (const relFile of obsCfg.vault_md_files) {
        const opt = document.createElement("option");
        opt.value = relFile;
        filesDatalist.appendChild(opt);
      }
    }

    if (badgeTop) {
      badgeTop.textContent = linkedRel
        ? `🟣 Conectado a Obsidian (${activeVaultName} → ${linkedRel})`
        : `🟣 Conectado a Bóveda Obsidian: ${activeVaultName}`;
    }

    if (activePathBadge) {
      activePathBadge.textContent = `Bóveda: ${activeVaultName}`;
      activePathBadge.title = obsCfg.display_path || "";
    }

    if (notesHint) {
      notesHint.innerHTML = linkedRel
        ? `🟣 Sincronizado en ambos sentidos con tu archivo de Obsidian: <code>${escapeHtml(activeVaultName)}/${escapeHtml(linkedRel)}</code>`
        : `🟣 Lo que escribas aquí se guarda directamente en tu bóveda de Obsidian (<strong>${escapeHtml(activeVaultName)}</strong>), y lo que edites en Obsidian aparece integrado aquí automáticamente.`;
    }

    if (btnOpenInObsidian) {
      if (obsCfg.obsidian_uri) {
        btnOpenInObsidian.href = obsCfg.obsidian_uri;
        btnOpenInObsidian.classList.remove("hidden");
      } else {
        btnOpenInObsidian.href = "obsidian://open";
      }
    }
  }

  function renderStudyPairedBanner(study) {
    const banner = document.getElementById("study-paired-banner");
    const infoSpan = document.getElementById("study-paired-partner-info");
    const openBtn = document.getElementById("btn-study-open-partner");
    if (!banner || !infoSpan || !openBtn) return;

    const targetBook = state.studyTargetBook || state.currentBook;
    const pairInfo =
      (study && study.pairing_info && study.pairing_info.paired_book_id
        ? study.pairing_info
        : null) ||
      (targetBook && targetBook.pairing && targetBook.pairing.paired_book_id
        ? targetBook.pairing
        : null);

    if (!pairInfo || !pairInfo.paired_book_id) {
      banner.classList.add("hidden");
      openBtn.dataset.partnerId = "";
      return;
    }

    const pLang = String(pairInfo.paired_book_lang || "").toLowerCase();
    const pFlag = pLang.startsWith("es") ? "🇪🇸" : "🇬🇧";
    const pTitle = pairInfo.paired_book_title || pairInfo.paired_book_id;
    const pNote = pairInfo.partner_obsidian_note || pTitle;
    infoSpan.innerHTML = `${pFlag} <strong>${escapeHtml(pTitle)}</strong> (<code>[[${escapeHtml(pNote)}]]</code>)`;
    openBtn.dataset.partnerId = pairInfo.paired_book_id;
    openBtn.dataset.partnerTitle = pTitle;
    openBtn.dataset.partnerLang = pairInfo.paired_book_lang || "";
    banner.classList.remove("hidden");
  }

  async function syncBookObsidianNow() {
    const target = state.studyTargetBook || state.currentBook;
    if (!target) return;
    const linkFileInput = document.getElementById("obsidian-link-file-select");
    const customRel = linkFileInput && linkFileInput.value ? linkFileInput.value.trim() : undefined;
    try {
      const res = await fetch(`/api/books/${encodeURIComponent(target.id)}/study/obsidian-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link_relpath: customRel }),
      });
      if (!res.ok) throw new Error("No se pudo sincronizar con Obsidian");
      const data = await res.json();
      state.obsidianMarkdown = data.obsidian_markdown || "";
      if (state.currentBook && state.currentBook.id === target.id) {
        state.currentStudy = data.study;
        applyStudyDecorationsToChapter();
        updateStudyHeaderBadge();
      }
      renderStudyModalData(data.study, state.obsidianMarkdown, data.obsidian_config || null);
      await fetchLibrary();
      showToast("🟣 Notas sincronizadas bidireccionalmente con tu bóveda de Obsidian");
    } catch (err) {
      showToast(`Error sincronizando con Obsidian: ${err.message}`);
    }
  }

  async function saveObsidianVaultConfigAndLink() {
    const vaultSelect = document.getElementById("obsidian-vault-select");
    const subfolderInput = document.getElementById("obsidian-subfolder-input");
    try {
      const res = await fetch("/api/obsidian/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vault_path: vaultSelect ? vaultSelect.value : undefined,
          books_subfolder: subfolderInput ? subfolderInput.value.trim() : "Libros",
          auto_sync: true,
        }),
      });
      if (!res.ok) throw new Error("No se pudo guardar la configuración de bóveda");
      await syncBookObsidianNow();
    } catch (err) {
      showToast(`Error: ${err.message}`);
    }
  }

  async function saveRawObsidianMarkdownFromModal() {
    const target = state.studyTargetBook || state.currentBook;
    if (!target || !els.studyObsidianPreview) return;
    try {
      const res = await fetch(`/api/books/${encodeURIComponent(target.id)}/study/obsidian-raw`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: els.studyObsidianPreview.value }),
      });
      if (!res.ok) throw new Error("No se pudo guardar el Markdown");
      const data = await res.json();
      state.obsidianMarkdown = data.obsidian_markdown || "";
      if (state.currentBook && state.currentBook.id === target.id) {
        state.currentStudy = data.study;
        applyStudyDecorationsToChapter();
        updateStudyHeaderBadge();
      }
      renderStudyModalData(data.study, state.obsidianMarkdown, data.obsidian_config || null);
      await fetchLibrary();
      fetchReadingAnalytics().catch(() => {});
      showToast("🟣 Markdown integrado en las notas del libro y guardado en Obsidian");
    } catch (err) {
      showToast(`Error: ${err.message}`);
    }
  }

  async function importObsidianMdFileFromDevice(file) {
    const target = state.studyTargetBook || state.currentBook;
    if (!target || !file) return;
    try {
      const mdText = await file.text();
      if (!mdText.trim()) {
        showToast("El archivo .md seleccionado está vacío");
        return;
      }
      const res = await fetch(`/api/books/${encodeURIComponent(target.id)}/study/obsidian-raw`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: mdText }),
      });
      if (!res.ok) throw new Error("No se pudo importar la nota .md");
      const data = await res.json();
      state.obsidianMarkdown = data.obsidian_markdown || "";
      if (state.currentBook && state.currentBook.id === target.id) {
        state.currentStudy = data.study;
        applyStudyDecorationsToChapter();
        updateStudyHeaderBadge();
      }
      renderStudyModalData(data.study, state.obsidianMarkdown, data.obsidian_config || null);
      await fetchLibrary();
      showToast(`🟣 Nota «${file.name}» integrada directamente en las notas del libro`);
    } catch (err) {
      showToast(`Error importando .md: ${err.message}`);
    }
  }

  async function saveStudyMetaFromModal() {
    if (!state.studyTargetBook) return;
    try {
      const newStatus = els.studyStatus.value;
      const res = await fetch(`/api/books/${state.studyTargetBook.id}/study/meta`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reading_status: newStatus,
          started_date: els.studyStartedAt.value,
          started_at: els.studyStartedAt.value,
          finished_date: els.studyFinishedAt.value,
          finished_at: els.studyFinishedAt.value,
          times_read: Number(els.studyTimesRead.value || 1),
          rating: Number(els.studyRating.value || 0),
          genre: els.studyGenre ? els.studyGenre.value.trim() : undefined,
          published_date: els.studyPublishedDate ? els.studyPublishedDate.value.trim() : undefined,
          auto_underline_lookups: els.chkStudyAutoUnderline.checked,
          general_notes: els.studyBookNotes.value,
          book_notes: els.studyBookNotes.value,
        }),
      });
      if (!res.ok) throw new Error("No se pudieron guardar los datos");
      const data = await res.json();

      // Si el usuario marca el libro como Terminado (completed), ajustar también su progreso local al 100%
      if (newStatus === "completed") {
        state.studyTargetBook.reading_status = "completed";
        const lastChIdx = Math.max(0, Number(state.studyTargetBook.chapter_count || 1) - 1);
        const chSum = state.studyTargetBook.chapters_summary || [];
        const lastSentIdx =
          chSum[lastChIdx] && Number(chSum[lastChIdx].sentence_count) > 0
            ? Number(chSum[lastChIdx].sentence_count) - 1
            : 999;
        const completedProg = {
          ...(state.studyTargetBook.progress || {}),
          chapter_index: lastChIdx,
          sentence_index: lastSentIdx,
          updated_at: Math.floor(Date.now() / 1000),
        };
        state.studyTargetBook.progress = completedProg;
        if (state.currentBook && state.currentBook.id === state.studyTargetBook.id) {
          state.currentBook.reading_status = "completed";
          state.currentBook.progress = completedProg;
          state.currentStudy = data.study;
        }
        OfflineStore.updateBookProgress(state.studyTargetBook.id, completedProg);
      }

      showToast(
        newStatus === "completed"
          ? "✅ Libro marcado como Terminado (100%) y sincronizado con tu bóveda de Obsidian"
          : "💾 Notas y metadatos guardados y sincronizados con Obsidian"
      );
      await fetchLibrary();
      updateReaderBottomBookProgress();
      fetchReadingAnalytics().catch(() => {});
      await openStudyModal(state.studyTargetBook, "habits");
    } catch (err) {
      showToast(`Error: ${err.message}`);
    }
  }

  async function addManualReadingSession() {
    if (!state.studyTargetBook) return;
    const minsStr = prompt("Duración de la sesión de lectura (en minutos):", "25");
    if (!minsStr) return;
    const mins = Math.max(1, Number(minsStr) || 25);
    const note = prompt("Nota opcional sobre esta sesión (ej. Leídos capítulos 1 y 2):", "") || "";

    const chIdx =
      state.currentBook && state.currentBook.id === state.studyTargetBook.id
        ? state.chapterIndex
        : 0;
    const chTitle =
      state.currentBook && state.currentBook.id === state.studyTargetBook.id && state.currentChapter
        ? state.currentChapter.title
        : `Cap. ${chIdx + 1}`;

    await fetch(`/api/books/${state.studyTargetBook.id}/study/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        duration_seconds: Math.round(mins * 60),
        duration_minutes: mins,
        start_chapter: chIdx,
        end_chapter: chIdx,
        chapter_title: chTitle,
        start_chapter_index: chIdx,
        end_chapter_index: chIdx,
        start_chapter_title: chTitle,
        end_chapter_title: chTitle,
        sentences_read: 0,
        note: note.trim(),
      }),
    });
    showToast("⏱️ Sesión de lectura añadida");
    await openStudyModal(state.studyTargetBook, "habits");
  }

  function downloadObsidianMarkdownFile() {
    const target = state.studyTargetBook || state.currentBook;
    if (!target) return;
    window.location.href = `/api/books/${encodeURIComponent(target.id)}/study/obsidian.md`;
    showToast("⬇️ Descargando nota Markdown (.md) para Obsidian...");
  }

  async function copyObsidianMarkdownToClipboard() {
    if (!state.obsidianMarkdown) return;
    try {
      await navigator.clipboard.writeText(state.obsidianMarkdown);
      showToast("📋 Nota Markdown copiada al portapapeles (lista para pegar en Obsidian)");
    } catch (_) {
      if (els.studyObsidianPreview) {
        els.studyObsidianPreview.select();
        document.execCommand("copy");
        showToast("📋 Nota Markdown copiada al portapapeles");
      }
    }
  }

  // =========================================================================
  // CENTRO DE HÁBITOS, CALENDARIO, VALORACIONES, AUTORES Y RESUMEN ANUAL
  // =========================================================================
  let analyticsDataCache = null;
  let analyticsCalYear = new Date().getFullYear();
  let analyticsCalMonth = new Date().getMonth(); // 0..11
  let analyticsSelectedDate = new Date().toISOString().slice(0, 10);
  let analyticsSelectedAnnualYear = String(new Date().getFullYear());

  const MONTH_NAMES_FULL_ES = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
  ];
  const WEEKDAY_SHORT_ES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

  function toIsoDateLocal(dObj) {
    const y = dObj.getFullYear();
    const m = String(dObj.getMonth() + 1).padStart(2, "0");
    const d = String(dObj.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function formatDurationMinutesShort(totalMinutes) {
    const mins = Math.round(Number(totalMinutes) || 0);
    if (mins <= 0) return "0 min";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m} min`;
  }

  async function fetchReadingAnalytics() {
    if (state.activeSession) {
      await flushActiveReadingSession({ keepActive: true }).catch(() => {});
    }
    try {
      const res = await fetchWithTimeout("/api/reading-analytics", {}, 8000);
      if (res && res.ok) {
        const data = await res.json();
        analyticsDataCache = data;
        try {
          localStorage.setItem("vozlectura_cached_analytics", JSON.stringify(data));
        } catch (_) {}
        updateAnalyticsStreakBadge(data);
        return data;
      }
    } catch (_) {}

    if (!analyticsDataCache) {
      try {
        const raw = localStorage.getItem("vozlectura_cached_analytics");
        if (raw) analyticsDataCache = JSON.parse(raw);
      } catch (_) {}
    }
    if (analyticsDataCache) {
      updateAnalyticsStreakBadge(analyticsDataCache);
    }
    return analyticsDataCache;
  }

  function updateAnalyticsStreakBadge(data) {
    const badge = document.getElementById("analytics-streak-badge");
    if (!badge || !data || !data.overview) return;
    const streak = Number(data.overview.current_streak_days || 0);
    if (streak > 0) {
      badge.textContent = `🔥 ${streak}d`;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  async function openAnalyticsModal(initialTab = "calendar") {
    const modal = document.getElementById("analytics-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    switchAnalyticsTab(initialTab);
    if (state.activeSession) {
      await flushActiveReadingSession({ keepActive: true });
    }
    await syncPendingOfflineSessions();
    const data = await fetchReadingAnalytics();
    if (data) {
      renderAllAnalyticsTabs(data);
    }
  }

  function switchAnalyticsTab(tabName) {
    document.querySelectorAll("[data-analytics-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.analyticsTab === tabName);
    });
    const panes = {
      calendar: document.getElementById("analytics-pane-calendar"),
      rankings: document.getElementById("analytics-pane-rankings"),
      stats: document.getElementById("analytics-pane-stats"),
      annual: document.getElementById("analytics-pane-annual"),
    };
    Object.entries(panes).forEach(([k, el]) => {
      if (el) el.classList.toggle("hidden", k !== tabName);
    });
  }

  function renderAllAnalyticsTabs(data) {
    if (!data) return;
    renderAnalyticsCalendarTab(data);
    renderAnalyticsRankingsTab(data);
    renderAnalyticsStatsTab(data);
    renderAnalyticsAnnualTab(data);
  }

  function renderAnalyticsCalendarTab(data) {
    const ov = data.overview || {};
    const goals = data.goals || { daily_minutes_goal: 30, yearly_books_goal: 12, yearly_pages_goal: 3600 };

    const gDailyInput = document.getElementById("goal-daily-minutes");
    const gBooksInput = document.getElementById("goal-yearly-books");
    const gPagesInput = document.getElementById("goal-yearly-pages");
    if (gDailyInput) gDailyInput.value = String(goals.daily_minutes_goal || 30);
    if (gBooksInput) gBooksInput.value = String(goals.yearly_books_goal || 12);
    if (gPagesInput) gPagesInput.value = String(goals.yearly_pages_goal || 3600);

    const kpiBox = document.getElementById("analytics-kpis-top");
    if (kpiBox) {
      const dailyGoal = Math.max(5, Number(goals.daily_minutes_goal || 30));
      const todayMins = Math.round(Number(ov.today_minutes || 0));
      const dailyPct = Math.min(100, Math.round((todayMins / dailyGoal) * 100));
      kpiBox.innerHTML = `
        <div class="analytics-kpi-card">
          <span class="kpi-label">🔥 Racha de Lectura</span>
          <span class="kpi-value" style="color:${ov.current_streak_days > 0 ? "#f59e0b" : "var(--text-primary)"}">${ov.current_streak_days || 0} ${ov.current_streak_days === 1 ? "día" : "días"}</span>
          <span class="kpi-sub">Mejor racha histórica: <strong>${ov.best_streak_days || 0} días</strong></span>
        </div>
        <div class="analytics-kpi-card">
          <span class="kpi-label">🎯 Lectura de Hoy</span>
          <span class="kpi-value" style="color:${dailyPct >= 100 ? "#16a34a" : "var(--text-primary)"}">${ov.today_time_human || "0 min"}</span>
          <span class="kpi-sub">Meta diaria: ${todayMins}/${dailyGoal} min (${dailyPct}%) ${dailyPct >= 100 ? "✅" : ""}</span>
        </div>
        <div class="analytics-kpi-card">
          <span class="kpi-label">📅 Esta Semana / Este Mes</span>
          <span class="kpi-value">${ov.week_time_human || "0 min"}</span>
          <span class="kpi-sub">Este mes: <strong>${ov.month_time_human || "0 min"}</strong> (${ov.avg_daily_minutes_active || 0} min/día activo)</span>
        </div>
        <div class="analytics-kpi-card">
          <span class="kpi-label">📚 Total Acumulado</span>
          <span class="kpi-value">${ov.total_reading_time_human || "0 min"}</span>
          <span class="kpi-sub"><strong>${ov.completed_books || 0}</strong> terminados • <strong>${(ov.total_pages_read || 0).toLocaleString("es-ES")}</strong> págs.</span>
        </div>
      `;
    }

    // Selector rápido de libro para añadir sesión manual
    const quickBookSel = document.getElementById("analytics-quick-book");
    if (quickBookSel) {
      const prevVal = quickBookSel.value;
      quickBookSel.innerHTML = "";
      for (const b of data.books || []) {
        const opt = document.createElement("option");
        opt.value = b.book_id;
        opt.textContent = `📖 ${b.title}`;
        quickBookSel.appendChild(opt);
      }
      if (prevVal && [...quickBookSel.options].some((o) => o.value === prevVal)) {
        quickBookSel.value = prevVal;
      } else if (state.currentBook) {
        quickBookSel.value = state.currentBook.id;
      }
    }

    renderAnalyticsWeekBars(data);
    renderAnalyticsMonthGrid(data);
    renderAnalyticsSelectedDayDetail(data, analyticsSelectedDate);
  }

  function renderAnalyticsWeekBars(data) {
    const weekBox = document.getElementById("analytics-week-bars");
    const weekLbl = document.getElementById("analytics-week-label");
    const weekBadge = document.getElementById("analytics-week-total-badge");
    if (!weekBox) return;

    const dailyMap = data.daily_map || {};
    const dailyGoal = Number((data.goals && data.goals.daily_minutes_goal) || 30);

    // Usar la semana que contiene la fecha seleccionada en el calendario
    const selParts = (analyticsSelectedDate || toIsoDateLocal(new Date())).split("-").map(Number);
    const refDate = new Date(selParts[0], (selParts[1] || 1) - 1, selParts[2] || 1);
    const jsDay = refDate.getDay(); // 0=Dom .. 6=Sáb
    const diffToMonday = jsDay === 0 ? -6 : 1 - jsDay;
    const monday = new Date(refDate);
    monday.setDate(refDate.getDate() + diffToMonday);

    const daysArr = [];
    let maxMins = dailyGoal;
    let totalWeekMins = 0;

    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const iso = toIsoDateLocal(d);
      const entry = dailyMap[iso];
      const mins = entry ? Math.round(entry.total_minutes || 0) : 0;
      if (mins > maxMins) maxMins = mins;
      totalWeekMins += mins;
      daysArr.push({
        iso,
        dayNum: d.getDate(),
        shortName: WEEKDAY_SHORT_ES[i],
        mins,
        books: entry ? entry.books || [] : [],
      });
    }

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    if (weekLbl) {
      weekLbl.textContent = `${monday.getDate()} ${MONTH_NAMES_FULL_ES[monday.getMonth()].slice(0, 3)} – ${sunday.getDate()} ${MONTH_NAMES_FULL_ES[sunday.getMonth()].slice(0, 3)}`;
    }
    if (weekBadge) {
      weekBadge.textContent = `Total semana: ${formatDurationMinutesShort(totalWeekMins)}`;
    }

    weekBox.innerHTML = "";
    for (const item of daysArr) {
      const col = document.createElement("div");
      col.className = "week-bar-col";
      const pct = maxMins > 0 ? Math.min(100, Math.round((item.mins / maxMins) * 100)) : 0;
      const isSelected = item.iso === analyticsSelectedDate;
      const booksTip =
        item.books.length > 0
          ? item.books.map((b) => `${b.title} (${Math.round(b.minutes)} min)`).join(", ")
          : "Sin lecturas registradas";
      col.title = `${item.shortName} ${item.dayNum}: ${item.mins} min — ${booksTip}`;
      col.innerHTML = `
        <span class="week-bar-val">${item.mins > 0 ? `${item.mins}m` : ""}</span>
        <div class="week-bar-track" style="${isSelected ? "border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)" : ""}">
          <div class="week-bar-fill ${item.mins >= dailyGoal ? "goal-reached" : ""}" style="height:${item.mins > 0 ? Math.max(8, pct) : 0}%"></div>
        </div>
        <span class="week-bar-lbl" style="${isSelected ? "color:var(--accent);font-weight:800" : ""}">${item.shortName} ${item.dayNum}</span>
      `;
      col.addEventListener("click", () => {
        analyticsSelectedDate = item.iso;
        renderAnalyticsWeekBars(data);
        renderAnalyticsMonthGrid(data);
        renderAnalyticsSelectedDayDetail(data, item.iso);
      });
      weekBox.appendChild(col);
    }
  }

  function renderAnalyticsMonthGrid(data) {
    const grid = document.getElementById("analytics-cal-grid");
    const titleEl = document.getElementById("analytics-cal-month-title");
    const sumEl = document.getElementById("analytics-cal-month-summary");
    if (!grid) return;

    const dailyMap = data.daily_map || {};
    const dailyGoal = Number((data.goals && data.goals.daily_minutes_goal) || 30);
    const todayIso = toIsoDateLocal(new Date());

    if (titleEl) {
      titleEl.textContent = `${MONTH_NAMES_FULL_ES[analyticsCalMonth]} ${analyticsCalYear}`;
    }

    const firstDay = new Date(analyticsCalYear, analyticsCalMonth, 1);
    const lastDay = new Date(analyticsCalYear, analyticsCalMonth + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startOffset = (firstDay.getDay() + 6) % 7; // Lunes = 0 .. Domingo = 6

    grid.innerHTML = "";
    for (let i = 0; i < startOffset; i++) {
      const empty = document.createElement("div");
      empty.className = "analytics-cal-cell empty-cell";
      grid.appendChild(empty);
    }

    let monthActiveDays = 0;
    let monthTotalMinutes = 0;

    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${analyticsCalYear}-${String(analyticsCalMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const entry = dailyMap[iso];
      const mins = entry ? Math.round(entry.total_minutes || 0) : 0;
      if (mins > 0) {
        monthActiveDays++;
        monthTotalMinutes += mins;
      }

      let heatClass = "";
      if (mins >= dailyGoal * 1.5) heatClass = "heat-3";
      else if (mins >= dailyGoal) heatClass = "heat-2";
      else if (mins > 0) heatClass = "heat-1";

      const cell = document.createElement("div");
      cell.className = `analytics-cal-cell ${heatClass} ${iso === todayIso ? "today-cell" : ""} ${iso === analyticsSelectedDate ? "selected-day" : ""}`;

      const booksArr = entry && entry.books ? entry.books : [];
      const pillsHtml = booksArr
        .slice(0, 2)
        .map((b) => `<span class="cal-book-pill" title="${escapeHtml(b.title)} (${Math.round(b.minutes)} min)">${escapeHtml(b.title)}</span>`)
        .join("");

      cell.innerHTML = `
        <div class="cal-day-top">
          <span class="cal-day-num">${day}</span>
          ${mins > 0 ? `<span class="cal-day-mins">${mins >= dailyGoal ? "✅" : ""}${mins}m</span>` : ""}
        </div>
        <div class="cal-day-books">${pillsHtml}</div>
      `;

      cell.addEventListener("click", () => {
        analyticsSelectedDate = iso;
        renderAnalyticsMonthGrid(data);
        renderAnalyticsWeekBars(data);
        renderAnalyticsSelectedDayDetail(data, iso);
      });
      grid.appendChild(cell);
    }

    if (sumEl) {
      sumEl.textContent = `${monthActiveDays} ${monthActiveDays === 1 ? "día leído" : "días leídos"} este mes • ${formatDurationMinutesShort(monthTotalMinutes)}`;
    }
  }

  function renderAnalyticsSelectedDayDetail(data, isoDate) {
    const titleEl = document.getElementById("analytics-selected-day-title");
    const badgeEl = document.getElementById("analytics-selected-day-badge");
    const contentEl = document.getElementById("analytics-selected-day-content");
    const quickDateLbl = document.getElementById("analytics-quick-date-label");
    if (!contentEl) return;

    if (titleEl) titleEl.textContent = `📅 Lecturas del ${isoDate}`;
    if (quickDateLbl) quickDateLbl.textContent = isoDate;

    const entry = (data.daily_map || {})[isoDate];
    if (!entry || !entry.books || entry.books.length === 0) {
      if (badgeEl) badgeEl.textContent = "0 min";
      contentEl.innerHTML = `
        <p style="font-size:0.84rem;color:var(--text-secondary);margin:4px 0">
          No hay sesiones de lectura registradas el <strong>${escapeHtml(isoDate)}</strong>.
          Puedes escuchar cualquier libro para que se anote solo o registrar abajo una lectura manual en esta fecha.
        </p>
      `;
      return;
    }

    if (badgeEl) {
      badgeEl.textContent = `${formatDurationMinutesShort(entry.total_minutes)} • ${entry.sentences_read || 0} frases`;
    }

    const booksHtml = entry.books
      .map(
        (b) => `
        <div class="study-item-card" style="padding:9px 11px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <strong>📖 ${escapeHtml(b.title)}</strong>
            <span class="badge-pill" style="color:#16a34a;border-color:#16a34a">⏱️ ${Math.max(1, Math.round(b.minutes))} min</span>
          </div>
          <div style="font-size:0.78rem;color:var(--text-secondary);margin-top:3px">
            ${escapeHtml(b.author)} • ${(b.chapters || []).map(escapeHtml).join(", ")} (${b.sentences_read || 0} frases)
          </div>
        </div>
      `
      )
      .join("");

    const sessionsHtml = (entry.sessions || [])
      .map(
        (s) => `
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.76rem;padding:4px 6px;border-radius:6px;background:var(--bg-elevated)">
          <span>🕒 ${escapeHtml(s.time_str)} — <strong>${escapeHtml(s.book_title)}</strong> (${s.duration_minutes} min • ${escapeHtml(s.chapter_range)}) ${s.note ? `• 📝 ${escapeHtml(s.note)}` : ""}</span>
          <button class="delete-book-btn btn-del-cal-session" data-book="${s.book_id}" data-sid="${s.id}" style="padding:2px 6px;font-size:0.7rem" title="Eliminar esta sesión">🗑</button>
        </div>
      `
      )
      .join("");

    contentEl.innerHTML = `
      ${booksHtml}
      <details style="margin-top:4px">
        <summary style="cursor:pointer;font-size:0.78rem;color:var(--text-secondary)">Ver desglose de sesiones del día (${(entry.sessions || []).length})</summary>
        <div style="display:flex;flex-direction:column;gap:4px;margin-top:6px">${sessionsHtml}</div>
      </details>
    `;

    contentEl.querySelectorAll(".btn-del-cal-session").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const bId = btn.dataset.book;
        const sId = btn.dataset.sid;
        if (!bId || !sId) return;
        const res = await fetch(`/api/books/${encodeURIComponent(bId)}/study/sessions/${encodeURIComponent(sId)}`, {
          method: "DELETE",
        });
        if (res.ok) {
          showToast("Sesión eliminada");
          const updated = await fetchReadingAnalytics();
          if (updated) renderAllAnalyticsTabs(updated);
        }
      });
    });
  }

  function getFilteredAndSortedRankingBooks(data) {
    const books = [...(data.books || [])];
    const statusFilter = (document.getElementById("rank-filter-status") || {}).value || "all";
    const ratingFilter = (document.getElementById("rank-filter-rating") || {}).value || "all";
    const langFilter = (document.getElementById("rank-filter-lang") || {}).value || "all";
    const sortBy = (document.getElementById("rank-sort-by") || {}).value || "rating_desc";

    const filtered = books.filter((b) => {
      if (statusFilter === "archived") {
        if (!b.is_archived) return false;
      } else if (statusFilter !== "all" && b.reading_status !== statusFilter) {
        return false;
      }
      const rVal = normalizeHalfStarRating(b.rating);
      if (ratingFilter === "5" && rVal < 5) return false;
      if (ratingFilter === "4.5plus" && rVal < 4.5) return false;
      if (ratingFilter === "4plus" && rVal < 4) return false;
      if (ratingFilter === "3.5plus" && rVal < 3.5) return false;
      if (ratingFilter === "rated" && rVal <= 0) return false;
      if (ratingFilter === "unrated" && rVal > 0) return false;
      if (langFilter !== "all" && !(b.language || "").toLowerCase().startsWith(langFilter)) return false;
      return true;
    });

    filtered.sort((a, b) => {
      if (sortBy === "rating_desc") {
        return b.rating - a.rating || b.total_seconds - a.total_seconds || b.total_words - a.total_words;
      }
      if (sortBy === "time_desc") {
        return b.total_seconds - a.total_seconds || b.rating - a.rating;
      }
      if (sortBy === "length_desc") {
        return b.total_words - a.total_words;
      }
      if (sortBy === "length_asc") {
        return a.total_words - b.total_words;
      }
      if (sortBy === "finished_desc") {
        return (b.finished_at || 0) - (a.finished_at || 0) || b.total_seconds - a.total_seconds;
      }
      return String(a.title || "").localeCompare(String(b.title || ""), "es");
    });

    return filtered;
  }

  function renderAnalyticsRankingsTab(data) {
    const listEl = document.getElementById("analytics-rankings-list");
    if (!listEl) return;

    const books = getFilteredAndSortedRankingBooks(data);
    listEl.innerHTML = "";

    if (books.length === 0) {
      listEl.innerHTML = `
        <div class="analytics-panel-card">
          <p style="margin:0;color:var(--text-secondary)">No hay libros que coincidan con los filtros seleccionados.</p>
        </div>
      `;
      return;
    }

    books.forEach((b, idx) => {
      const card = document.createElement("div");
      card.className = "study-item-card";
      const rVal = normalizeHalfStarRating(b.rating);
      const starsBtns = [1, 2, 3, 4, 5]
        .map((starNum) => {
          const isFull = rVal >= starNum;
          const isHalf = !isFull && rVal >= starNum - 0.5;
          const cls = isFull ? "active" : isHalf ? "half" : "";
          return `<button type="button" class="star-btn-inline ${cls}" data-book="${b.book_id}" data-star="${starNum}" title="Pulsa 1 vez para ${starNum} ★ o 2 veces para ${formatRatingValueEs(starNum - 0.5)} ★">★</button>`;
        })
        .join("") + (rVal > 0 ? `<span class="card-rating-num">${formatRatingValueEs(rVal)}</span>` : "");

      card.innerHTML = `
        <div class="study-item-header" style="gap:12px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span class="badge-pill" style="font-weight:800">#${idx + 1}</span>
            <div>
              <strong style="font-size:1rem">${escapeHtml(b.title)}</strong>
              ${b.is_archived ? `<span class="badge-pill" style="margin-left:6px;font-size:0.72rem" title="Archivos pesados eliminados del servidor; historial conservado">🗄️ Archivado</span>` : ""}
              <span style="color:var(--text-secondary);font-size:0.84rem;margin-left:6px">por ${escapeHtml(b.author)}</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <div class="star-rating-inline" title="Haz clic para cambiar la valoración de este libro">
              ${starsBtns}
            </div>
            <select class="player-select rank-inline-status" data-book="${b.book_id}" style="padding:4px 8px;font-size:0.78rem">
              <option value="reading" ${b.reading_status === "reading" ? "selected" : ""}>📖 Leyendo</option>
              <option value="completed" ${b.reading_status === "completed" ? "selected" : ""}>✅ Terminado</option>
              <option value="paused" ${b.reading_status === "paused" ? "selected" : ""}>⏸️ En pausa</option>
              <option value="wishlist" ${b.reading_status === "wishlist" ? "selected" : ""}>📌 Pendiente</option>
            </select>
            <button class="secondary-btn btn-rank-open-notes" data-book="${b.book_id}" style="padding:4px 9px;font-size:0.76rem">📓 Ficha / Notas</button>
          </div>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:0.8rem;color:var(--text-secondary);margin-top:4px">
          <span>📏 <strong>${b.estimated_pages.toLocaleString("es-ES")} págs.</strong> (${b.total_words.toLocaleString("es-ES")} palabras • ~${b.estimated_listen_hours} h de audiolibro)</span>
          <span>⏱️ Tiempo dedicado: <strong>${b.total_time_human}</strong> (${b.days_read_count} días)</span>
          <span>📈 Avance: <strong>${Math.round(Number(b.progress_percent) || 0)}%</strong></span>
          ${b.finished_date ? `<span>🏁 Terminado: <strong>${escapeHtml(b.finished_date)}</strong></span>` : ""}
        </div>
        ${b.general_notes ? `<div style="font-size:0.82rem;margin-top:4px">💭 <em>${escapeHtml(b.general_notes)}</em></div>` : ""}
      `;

      card.querySelectorAll(".star-btn-inline").forEach((starBtn) => {
        starBtn.addEventListener("click", async (e) => {
          const starNum = Number(starBtn.dataset.star || 0);
          const finalRating = computeNextStarRatingFromClick(b.rating, starNum, e);
          await fetch(`/api/books/${encodeURIComponent(b.book_id)}/study/meta`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rating: finalRating }),
          });
          showToast(
            finalRating > 0
              ? `⭐ Valorado «${b.title}» con ${formatStarsText(finalRating)}`
              : "Valoración borrada"
          );
          await fetchLibrary();
          const updated = await fetchReadingAnalytics();
          if (updated) renderAllAnalyticsTabs(updated);
        });
      });

      const statusSel = card.querySelector(".rank-inline-status");
      if (statusSel) {
        statusSel.addEventListener("change", async () => {
          const newStatus = statusSel.value;
          const bodyPayload = { reading_status: newStatus };
          if (newStatus === "completed" && !b.finished_date) {
            bodyPayload.finished_date = toIsoDateLocal(new Date());
          }
          await fetch(`/api/books/${encodeURIComponent(b.book_id)}/study/meta`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bodyPayload),
          });
          showToast(`Estado de «${b.title}» actualizado`);
          const updated = await fetchReadingAnalytics();
          if (updated) renderAllAnalyticsTabs(updated);
        });
      }

      const notesBtn = card.querySelector(".btn-rank-open-notes");
      if (notesBtn) {
        notesBtn.addEventListener("click", () => {
          const found =
            state.books.find((x) => x.id === b.book_id) ||
            (state.archivedBooks || []).find((x) => x.id === b.book_id) || {
              id: b.book_id,
              title: b.title,
              author: b.author,
              is_archived: Boolean(b.is_archived),
            };
          document.getElementById("analytics-modal").classList.add("hidden");
          openStudyModal(found, "habits");
        });
      }

      listEl.appendChild(card);
    });
  }

  function renderAnalyticsStatsTab(data) {
    const ov = data.overview || {};
    const recGrid = document.getElementById("analytics-records-grid");
    const authorsList = document.getElementById("analytics-authors-list");
    const lengthBars = document.getElementById("analytics-length-bars");

    if (recGrid) {
      const topAuthorTime = ov.most_read_author_by_time;
      const bestAuthor = ov.best_rated_author;
      const longest = ov.longest_book;
      const shortest = ov.shortest_book;

      recGrid.innerHTML = `
        <div class="analytics-kpi-card">
          <span class="kpi-label">👨‍💼 Autor Más Leído</span>
          <span class="kpi-value" style="font-size:1.08rem">${topAuthorTime ? escapeHtml(topAuthorTime.author) : "—"}</span>
          <span class="kpi-sub">${topAuthorTime ? `${topAuthorTime.total_time_human} • ${topAuthorTime.book_count} ${topAuthorTime.book_count === 1 ? "libro" : "libros"} (${topAuthorTime.pages_read.toLocaleString("es-ES")} págs.)` : "Sin datos"}</span>
        </div>
        <div class="analytics-kpi-card">
          <span class="kpi-label">⭐ Autor Mejor Valorado</span>
          <span class="kpi-value" style="font-size:1.08rem">${bestAuthor ? `${escapeHtml(bestAuthor.author)} (${bestAuthor.avg_rating} ⭐)` : "—"}</span>
          <span class="kpi-sub">${bestAuthor ? `${bestAuthor.rated_count} ${bestAuthor.rated_count === 1 ? "libro valorado" : "libros valorados"}` : "Valora tus libros con ⭐"}</span>
        </div>
        <div class="analytics-kpi-card">
          <span class="kpi-label">📏 Libro Más Extenso</span>
          <span class="kpi-value" style="font-size:1.05rem">${longest ? escapeHtml(longest.title) : "—"}</span>
          <span class="kpi-sub">${longest ? `<strong>${longest.estimated_pages.toLocaleString("es-ES")} págs.</strong> (${longest.total_words.toLocaleString("es-ES")} palabras)` : "—"}</span>
        </div>
        <div class="analytics-kpi-card">
          <span class="kpi-label">📐 Longitud Media y Más Corto</span>
          <span class="kpi-value" style="font-size:1.08rem">${(ov.avg_book_pages || 0).toLocaleString("es-ES")} págs./libro</span>
          <span class="kpi-sub">Media: ${(ov.avg_book_words || 0).toLocaleString("es-ES")} pal. • Más corto: ${shortest ? `${escapeHtml(shortest.title)} (${shortest.estimated_pages} págs.)` : "—"}</span>
        </div>
      `;
    }

    if (authorsList) {
      const authors = data.authors || [];
      authorsList.innerHTML = authors
        .map(
          (a, i) => `
          <div class="study-item-card" style="padding:10px 12px">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
              <div>
                <span class="badge-pill" style="margin-right:6px">#${i + 1}</span>
                <strong>${escapeHtml(a.author)}</strong>
                <span style="font-size:0.8rem;color:var(--text-secondary);margin-left:8px">${a.book_count} ${a.book_count === 1 ? "libro" : "libros"} (${a.completed_count} terminados)</span>
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                ${a.avg_rating > 0 ? `<span class="badge-pill" style="color:#f59e0b;border-color:#f59e0b">⭐ ${a.avg_rating}</span>` : ""}
                <span class="badge-pill">⏱️ ${a.total_time_human}</span>
                <span class="badge-pill">📄 ${a.total_pages.toLocaleString("es-ES")} págs. (${a.total_words.toLocaleString("es-ES")} pal.)</span>
              </div>
            </div>
          </div>
        `
        )
        .join("");
    }

    if (lengthBars) {
      const sortedBooks = [...(data.books || [])].sort((a, b) => b.total_words - a.total_words);
      const maxWords = sortedBooks.length > 0 ? Math.max(1, sortedBooks[0].total_words) : 1;
      lengthBars.innerHTML = sortedBooks
        .map((b) => {
          const pct = Math.max(4, Math.round((b.total_words / maxWords) * 100));
          return `
            <div style="display:flex;flex-direction:column;gap:4px">
              <div style="display:flex;justify-content:space-between;font-size:0.82rem;gap:8px;flex-wrap:wrap">
                <span><strong>${escapeHtml(b.title)}</strong> <small style="color:var(--text-secondary)">(${escapeHtml(b.author)})</small></span>
                <span><strong>${b.estimated_pages.toLocaleString("es-ES")} págs.</strong> • ${b.total_words.toLocaleString("es-ES")} palabras • ~${b.estimated_listen_hours} h audio</span>
              </div>
              <div class="export-bar-bg" style="height:9px">
                <div class="export-bar-fill" style="width:${pct}%"></div>
              </div>
            </div>
          `;
        })
        .join("");
    }
  }

  function renderAnalyticsAnnualTab(data) {
    const yearSel = document.getElementById("analytics-year-select");
    const container = document.getElementById("analytics-annual-content");
    if (!container) return;

    const years = data.available_years || [String(new Date().getFullYear())];
    if (yearSel) {
      yearSel.innerHTML = "";
      for (const y of years) {
        const opt = document.createElement("option");
        opt.value = y;
        opt.textContent = `Año ${y}`;
        yearSel.appendChild(opt);
      }
      if (!years.includes(analyticsSelectedAnnualYear)) {
        analyticsSelectedAnnualYear = years[0];
      }
      yearSel.value = analyticsSelectedAnnualYear;
    }

    const yrData = (data.yearly_stats || {})[analyticsSelectedAnnualYear];
    if (!yrData) {
      container.innerHTML = `<p style="color:var(--text-secondary)">No hay registros para el año ${escapeHtml(analyticsSelectedAnnualYear)}.</p>`;
      return;
    }

    const goals = data.goals || { yearly_books_goal: 12, yearly_pages_goal: 3600 };
    const bookGoal = Math.max(1, Number(goals.yearly_books_goal || 12));
    const booksDone = yrData.books_completed_count || 0;
    const goalPct = Math.min(100, Math.round((booksDone / bookGoal) * 100));

    const monthly = yrData.monthly_breakdown || [];
    const maxMonthMins = Math.max(30, ...monthly.map((m) => Number(m.minutes || 0)));
    const monthsBarsHtml = monthly
      .map((m) => {
        const pct = Math.round(((Number(m.minutes) || 0) / maxMonthMins) * 100);
        return `
          <div class="week-bar-col" title="${m.name}: ${Math.round(m.minutes)} min (${m.hours} h) • ${m.active_days} días activos • ${m.books_completed} libros terminados">
            <span class="week-bar-val">${m.minutes > 0 ? `${Math.round(m.minutes)}m` : ""}</span>
            <div class="week-bar-track">
              <div class="week-bar-fill ${m.books_completed > 0 ? "goal-reached" : ""}" style="height:${m.minutes > 0 ? Math.max(8, pct) : 0}%"></div>
            </div>
            <span class="week-bar-lbl">${m.name}${m.books_completed > 0 ? ` (${m.books_completed}📕)` : ""}</span>
          </div>
        `;
      })
      .join("");

    const completedCardsHtml =
      (yrData.books_completed || []).length > 0
        ? yrData.books_completed
            .map(
              (b) => `
              <div class="study-item-card" style="padding:10px 12px">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
                  <div>
                    <strong>✅ ${escapeHtml(b.title)}</strong>
                    <span style="font-size:0.82rem;color:var(--text-secondary);margin-left:6px">— ${escapeHtml(b.author)}</span>
                  </div>
                  <div style="display:flex;gap:8px;align-items:center">
                    <span>${b.rating > 0 ? formatStarsEmoji(b.rating) : "Sin valorar"}</span>
                    <span class="badge-pill">${b.estimated_pages} págs.</span>
                    <span class="badge-pill">⏱️ ${b.total_time_human}</span>
                  </div>
                </div>
              </div>
            `
            )
            .join("")
        : `<p style="font-size:0.84rem;color:var(--text-secondary);margin:0">Aún no has marcado libros como «✅ Terminado» en ${analyticsSelectedAnnualYear}. Puedes marcarlos en la pestaña «🏆 Valoraciones y Listados».</p>`;

    container.innerHTML = `
      <!-- Barra de Reto Anual de Libros -->
      <div class="analytics-panel-card" style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          <strong>🎯 Reto Lector ${analyticsSelectedAnnualYear}: ${booksDone} de ${bookGoal} libros terminados (${goalPct}%)</strong>
          <span class="badge-pill">${yrData.books_interacted_count || 0} libros leídos/en curso este año</span>
        </div>
        <div class="export-bar-bg" style="height:12px">
          <div class="export-bar-fill" style="width:${goalPct}%"></div>
        </div>
      </div>

      <!-- KPIs del Año -->
      <div class="analytics-kpi-grid">
        <div class="analytics-kpi-card">
          <span class="kpi-label">📚 Libros en ${analyticsSelectedAnnualYear}</span>
          <span class="kpi-value">${booksDone} terminados</span>
          <span class="kpi-sub">${yrData.books_interacted_count} libros abiertos en el año</span>
        </div>
        <div class="analytics-kpi-card">
          <span class="kpi-label">⏱️ Tiempo de Lectura en ${analyticsSelectedAnnualYear}</span>
          <span class="kpi-value">${yrData.total_time_human}</span>
          <span class="kpi-sub">${yrData.active_days_count} días leyendo (${yrData.sessions_count} sesiones)</span>
        </div>
        <div class="analytics-kpi-card">
          <span class="kpi-label">📄 Páginas y Palabras (${analyticsSelectedAnnualYear})</span>
          <span class="kpi-value">${(yrData.pages_read || 0).toLocaleString("es-ES")} págs.</span>
          <span class="kpi-sub">${(yrData.words_read || 0).toLocaleString("es-ES")} palabras leídas</span>
        </div>
        <div class="analytics-kpi-card">
          <span class="kpi-label">🏅 Hitos del Año ${analyticsSelectedAnnualYear}</span>
          <span class="kpi-value" style="font-size:1rem">${yrData.best_rated_book ? `⭐ ${escapeHtml(yrData.best_rated_book.title)}` : `👨‍💼 ${escapeHtml(yrData.top_author || "—")}`}</span>
          <span class="kpi-sub">Autor del año: <strong>${escapeHtml(yrData.top_author || "—")}</strong>${yrData.best_month ? ` • Mejor mes: ${yrData.best_month.name}` : ""}</span>
        </div>
      </div>

      <!-- Gráfico Mensual (Enero a Diciembre) -->
      <div class="analytics-panel-card" style="margin-bottom:14px">
        <h3 style="margin:0 0 8px 0;font-size:0.95rem">📊 Evolución Mensual en ${analyticsSelectedAnnualYear} (Minutos leídos y 📕 libros terminados por mes)</h3>
        <div class="annual-months-chart">${monthsBarsHtml}</div>
      </div>

      <!-- Libros terminados en el año -->
      <div class="analytics-panel-card">
        <h3 style="margin:0 0 10px 0;font-size:0.95rem">✅ Libros Terminados en ${analyticsSelectedAnnualYear} (${booksDone})</h3>
        <div style="display:flex;flex-direction:column;gap:8px">${completedCardsHtml}</div>
      </div>
    `;
  }

  function downloadTextBlob(filename, content, mimeType = "text/markdown;charset=utf-8") {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function exportRankingsAsMarkdown() {
    if (!analyticsDataCache) return;
    const books = getFilteredAndSortedRankingBooks(analyticsDataCache);
    const lines = [
      "---",
      `title: "Ranking y Valoraciones de Libros — VozLectura"`,
      `date: ${toIsoDateLocal(new Date())}`,
      "tags: [libros, ranking, lecturas]",
      "---",
      "",
      "# 🏆 Listado y Valoraciones de Libros",
      "",
      "| # | Libro | Autor | Valoración | Estado | Páginas | Palabras | Tiempo leído | Finalizado |",
      "| :-: | :--- | :--- | :-: | :--- | --: | --: | --: | :-: |",
    ];
    books.forEach((b, i) => {
      const stars = b.rating > 0 ? formatStarsEmoji(b.rating) : "—";
      lines.push(
        `| ${i + 1} | **${b.title}** | ${b.author} | ${stars} | ${b.reading_status} | ${b.estimated_pages} | ${b.total_words} | ${b.total_time_human} | ${b.finished_date || "—"} |`
      );
    });
    downloadTextBlob("Ranking_Libros_VozLectura.md", lines.join("\n"));
    showToast("📝 Listado exportado a Markdown (.md) para Obsidian");
  }

  function exportRankingsAsCsv() {
    if (!analyticsDataCache) return;
    const books = getFilteredAndSortedRankingBooks(analyticsDataCache);
    const rows = [
      ["Posicion", "Titulo", "Autor", "Idioma", "Valoracion_Estrellas", "Estado", "Paginas_Estimadas", "Palabras", "Tiempo_Minutos", "Dias_Leidos", "Fecha_Inicio", "Fecha_Fin"],
    ];
    books.forEach((b, i) => {
      rows.push([
        i + 1,
        `"${String(b.title || "").replace(/"/g, '""')}"`,
        `"${String(b.author || "").replace(/"/g, '""')}"`,
        b.language,
        b.rating,
        b.reading_status,
        b.estimated_pages,
        b.total_words,
        b.total_minutes,
        b.days_read_count,
        b.started_date || "",
        b.finished_date || "",
      ]);
    });
    const csvContent = "\uFEFF" + rows.map((r) => r.join(",")).join("\n");
    downloadTextBlob("Ranking_Libros_VozLectura.csv", csvContent, "text/csv;charset=utf-8");
    showToast("📊 Listado exportado a CSV para Excel / Google Sheets");
  }

  function exportAnnualSummaryAsMarkdown() {
    if (!analyticsDataCache) return;
    const yr = analyticsSelectedAnnualYear;
    const yrData = (analyticsDataCache.yearly_stats || {})[yr];
    if (!yrData) return;
    const lines = [
      "---",
      `title: "Resumen Lector Anual ${yr}"`,
      `year: ${yr}`,
      `books_completed: ${yrData.books_completed_count}`,
      `reading_hours: ${yrData.total_hours}`,
      `pages_read: ${yrData.pages_read}`,
      "tags: [lectura, resumen-anual, vozlectura]",
      "---",
      "",
      `# 🗓️ Resumen de Lecturas del Año ${yr}`,
      "",
      `- **Libros terminados:** ${yrData.books_completed_count}`,
      `- **Libros leídos / abiertos en el año:** ${yrData.books_interacted_count}`,
      `- **Tiempo total de lectura:** ${yrData.total_time_human} (${yrData.active_days_count} días activos en ${yrData.sessions_count} sesiones)`,
      `- **Páginas estimadas leídas:** ${(yrData.pages_read || 0).toLocaleString("es-ES")} págs. (${(yrData.words_read || 0).toLocaleString("es-ES")} palabras)`,
      `- **Autor más leído del año:** ${yrData.top_author || "—"}`,
      `- **Libro mejor valorado del año:** ${yrData.best_rated_book ? `${yrData.best_rated_book.title} (${formatStarsEmoji(yrData.best_rated_book.rating)})` : "—"}`,
      `- **Libro más extenso del año:** ${yrData.longest_book ? `${yrData.longest_book.title} (${yrData.longest_book.estimated_pages} págs.)` : "—"}`,
      "",
      "## 📊 Desglose Mensual",
      "",
      "| Mes | Tiempo leído | Días activos | Libros terminados |",
      "| :--- | --: | :-: | :-: |",
    ];
    for (const m of yrData.monthly_breakdown || []) {
      lines.push(`| ${m.name} | ${Math.round(m.minutes)} min (${m.hours} h) | ${m.active_days} | ${m.books_completed} |`);
    }
    lines.push("", "## ✅ Libros Terminados en el Año", "");
    for (const b of yrData.books_completed || []) {
      lines.push(`- **${b.title}** — *${b.author}* (${b.rating > 0 ? formatStarsEmoji(b.rating) : "Sin valorar"} • ${b.estimated_pages} págs. • ${b.total_time_human})`);
    }
    downloadTextBlob(`Resumen_Lector_${yr}_Obsidian.md`, lines.join("\n"));
    showToast(`📥 Resumen Anual ${yr} descargado en formato Markdown (.md) para Obsidian`);
  }

  // =========================================================================
  // MODAL DE MODO SIN CONEXIÓN (DESCARGA DE LIBROS Y AUDIO A INDEXEDDB)
  // =========================================================================
  async function openOfflineModal(bookObj = null) {
    await refreshOfflineMap();
    const target = bookObj || state.currentBook || state.books[0] || null;

    if (els.offlineBookSelect) {
      els.offlineBookSelect.innerHTML = "";
      if (state.books.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "— No hay libros disponibles —";
        els.offlineBookSelect.appendChild(opt);
      } else {
        for (const b of state.books) {
          const opt = document.createElement("option");
          opt.value = b.id;
          const flag = (b.language || "").startsWith("es") ? "🇪🇸" : "🇬🇧";
          const isSaved = state.offlineBooksMap.has(b.id) ? " [✓ En memoria local]" : "";
          opt.textContent = `📚 ${flag} ${b.title} (${b.chapter_count} cap.)${isSaved}`;
          els.offlineBookSelect.appendChild(opt);
        }
        if (target) {
          els.offlineBookSelect.value = target.id;
        }
      }
    }

    if (els.offlineServerUrlInput) {
      els.offlineServerUrlInput.value = state.serverUrl || window.location.origin;
    }
    updateSwStatusUi();
    syncOfflineVoiceSelector(target);
    updateOfflineVoiceRowVisibility();
    renderOfflineBooksList();
    els.offlineModal.classList.remove("hidden");
  }

  function syncOfflineVoiceSelector(bookObj) {
    if (!els.offlineVoiceSelect) return;
    els.offlineVoiceSelect.innerHTML = "";
    if (bookObj && bookObj.has_imported_audiobook) {
      const optAb = document.createElement("option");
      optAb.value = "audiobook:original";
      optAb.textContent =
        bookObj.imported_audiobook_name || "🎧 Audiolibro Original (Sincronizado)";
      els.offlineVoiceSelect.appendChild(optAb);
    }
    for (const v of state.voices) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = `${getEngineBadgeLabel(v)} ${v.name}`;
      els.offlineVoiceSelect.appendChild(opt);
    }
    const preferredVoice =
      (bookObj && bookObj.progress && bookObj.progress.voice_id) || state.selectedVoice;
    if (
      preferredVoice &&
      !preferredVoice.startsWith("browser:") &&
      [...els.offlineVoiceSelect.options].some((o) => o.value === preferredVoice)
    ) {
      els.offlineVoiceSelect.value = preferredVoice;
    }

    syncOfflinePairedOptionUi(bookObj);
  }

  function syncOfflinePairedOptionUi(bookObj) {
    const pairedBox = document.getElementById("offline-paired-option-box");
    const chkIncludePartner = document.getElementById("chk-offline-include-partner");
    const chkLabel = document.getElementById("offline-paired-checkbox-label");
    const partnerVoiceSelect = document.getElementById("offline-partner-voice-select");
    if (!pairedBox || !chkIncludePartner) return;

    const partnerId =
      bookObj && bookObj.pairing && bookObj.pairing.paired_book_id
        ? bookObj.pairing.paired_book_id
        : null;
    const partnerBook = partnerId
      ? state.books.find((b) => b.id === partnerId) || null
      : null;

    if (!partnerBook) {
      pairedBox.classList.add("hidden");
      chkIncludePartner.checked = false;
      updateOfflineVoiceRowVisibility();
      return;
    }

    pairedBox.classList.remove("hidden");
    chkIncludePartner.checked = true;
    const pIsEs = (partnerBook.language || "").toLowerCase().startsWith("es");
    const pFlag = pIsEs ? "🇪🇸" : "🇬🇧";
    const pSaved = state.offlineBooksMap.has(partnerBook.id)
      ? " [ya en local — actualizar/completar]"
      : "";
    if (chkLabel) {
      chkLabel.textContent = `Descargar también su pareja bilingüe: ${pFlag} «${partnerBook.title}» (${partnerBook.chapter_count} cap.)${pSaved}`;
    }

    if (partnerVoiceSelect) {
      partnerVoiceSelect.innerHTML = "";
      if (partnerBook.has_imported_audiobook) {
        const optAb = document.createElement("option");
        optAb.value = "audiobook:original";
        optAb.textContent =
          partnerBook.imported_audiobook_name || "🎧 Audiolibro Original (Sincronizado)";
        partnerVoiceSelect.appendChild(optAb);
      }
      for (const v of state.voices) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = `${getEngineBadgeLabel(v)} ${v.name}`;
        partnerVoiceSelect.appendChild(opt);
      }
      const partnerPrefVoice =
        (partnerBook.progress && partnerBook.progress.voice_id) || "";
      if (
        partnerPrefVoice &&
        !partnerPrefVoice.startsWith("browser:") &&
        [...partnerVoiceSelect.options].some((o) => o.value === partnerPrefVoice)
      ) {
        partnerVoiceSelect.value = partnerPrefVoice;
      } else {
        const langPrefix = pIsEs ? "es" : "en";
        const matchedVoice = state.voices.find((v) =>
          String(v.language || v.id || "")
            .toLowerCase()
            .includes(langPrefix)
        );
        if (
          matchedVoice &&
          [...partnerVoiceSelect.options].some((o) => o.value === matchedVoice.id)
        ) {
          partnerVoiceSelect.value = matchedVoice.id;
        }
      }
    }

    updateOfflineVoiceRowVisibility();
  }

  function updateOfflineVoiceRowVisibility() {
    if (!els.offlineModeSelect || !els.offlineVoiceRow) return;
    const mode = els.offlineModeSelect.value;
    els.offlineVoiceRow.classList.toggle("hidden", mode === "text_only");
    const pairedBox = document.getElementById("offline-paired-option-box");
    const partnerVoiceRow = document.getElementById("offline-partner-voice-row");
    const chkIncludePartner = document.getElementById("chk-offline-include-partner");
    const isPairedVisible = Boolean(pairedBox && !pairedBox.classList.contains("hidden"));
    const includeBoth = Boolean(isPairedVisible && chkIncludePartner && chkIncludePartner.checked);
    if (partnerVoiceRow) {
      const showPartnerVoice = mode !== "text_only" && includeBoth;
      partnerVoiceRow.classList.toggle("hidden", !showPartnerVoice);
    }
    if (els.btnStartOfflineDl && !state.isDownloadingOffline) {
      els.btnStartOfflineDl.textContent = includeBoth
        ? "📲 Guardar ambos idiomas en este dispositivo"
        : "📲 Guardar en este dispositivo";
    }
  }

  async function downloadSingleBookOffline(
    targetBookId,
    mode,
    voiceId,
    speed,
    stepPrefix = ""
  ) {
    const voiceObj = state.voices.find((v) => v.id === voiceId);
    const voiceName = voiceObj ? voiceObj.name : voiceId;

    els.offlineDlPhase.textContent = `${stepPrefix}Descargando texto, capítulos y notas del EPUB...`;
    els.offlineDlPct.textContent = "5%";
    els.offlineDlBar.style.width = "5%";
    els.offlineDlDetail.textContent = "Verificando capítulos previos en IndexedDB...";

    const resBundle = await fetch(
      `/api/books/${encodeURIComponent(targetBookId)}/offline-bundle`
    );
    if (!resBundle.ok) {
      const errInfo = await resBundle.json().catch(() => ({}));
      throw new Error(
        errInfo.detail || "No se pudo descargar el paquete del libro desde el servidor"
      );
    }
    const bundleData = await resBundle.json();
    if (mode !== "text_only" && bundleData.book) {
      bundleData.book.progress = bundleData.book.progress || {
        chapter_index: 0,
        sentence_index: 0,
      };
      bundleData.book.progress.voice_id = voiceId;
      bundleData.book.progress.speed = speed;
    }
    await OfflineStore.saveBookBundle(bundleData);
    await refreshOfflineMap();

    // Pre-cachear portada e ilustraciones del EPUB para que se vean también sin conexión
    if (Array.isArray(bundleData.assets) && bundleData.assets.length > 0 && "caches" in window) {
      caches
        .open("vozlectura-book-assets-v1")
        .then(async (cache) => {
          for (const assetUrl of bundleData.assets) {
            try {
              const fullUrl = resolveApiUrl(assetUrl);
              const existing = await cache.match(fullUrl, { ignoreSearch: true });
              if (!existing) {
                const resp = await fetch(fullUrl);
                if (resp && resp.ok) {
                  await cache.put(fullUrl, resp);
                }
              }
            } catch (_) {}
          }
        })
        .catch(() => {});
    }

    if (mode === "text_only") {
      els.offlineDlPct.textContent = "100%";
      els.offlineDlBar.style.width = "100%";
      els.offlineDlPhase.textContent = `${stepPrefix}✓ «${bundleData.book.title}» guardado en la memoria local`;
      els.offlineDlDetail.textContent = `${bundleData.chapters.length} capítulos listos para leer sin conexión`;
      showToast(
        `📲 «${bundleData.book.title}» guardado en este dispositivo para uso sin conexión`
      );
      return bundleData.book;
    }

    const totalCh = bundleData.chapters.length;
    const startCh =
      state.currentBook && state.currentBook.id === targetBookId
        ? state.chapterIndex
        : (bundleData.book.progress && bundleData.book.progress.chapter_index) || 0;

    let countToDownload = totalCh;
    let fromIdx = 0;
    if (mode === "audio_next_3") {
      fromIdx = startCh;
      countToDownload = Math.min(3, totalCh - fromIdx);
    } else if (mode === "audio_next_5") {
      fromIdx = startCh;
      countToDownload = Math.min(5, totalCh - fromIdx);
    }

    const isAlreadyCachedOnServer =
      voiceId === "audiobook:original" ||
      (Array.isArray(bundleData.exports) &&
        bundleData.exports.some(
          (ex) =>
            ex.voice_id === voiceId &&
            Math.abs(Number(ex.speed || 1.0) - speed) < 0.02 &&
            Number(ex.cached_sentences || 0) >=
              Number(bundleData.book.total_sentences || 1) * 0.85
        ));
    const batchSize = isAlreadyCachedOnServer ? 80 : 24;

    let skippedChaptersCount = 0;
    let resumedFromSentence = null;

    for (let i = 0; i < countToDownload; i++) {
      if (state.offlineDlCancel) {
        showToast(
          "⏸ Descarga local en pausa — Puedes pulsar «▶️ Continuar descarga» cuando quieras"
        );
        break;
      }
      const chIdx = fromIdx + i;
      const chObj = bundleData.chapters[chIdx] || {};
      const chSentences = chObj.sentences || [];
      const chTotalSents = Number(chObj.sentence_count || chSentences.length || 1);

      const existingPack = await OfflineStore.getChapterAudioPack(
        targetBookId,
        voiceId,
        speed,
        chIdx
      );
      const existingMap = (existingPack && existingPack.sentences_b64) || {};
      const existingCount = Object.keys(existingMap).length;

      if (existingCount >= chTotalSents && chTotalSents > 0) {
        skippedChaptersCount++;
        const donePct = Math.round(((i + 1) / Math.max(1, countToDownload)) * 100);
        els.offlineDlPct.textContent = `${donePct}%`;
        els.offlineDlBar.style.width = `${donePct}%`;
        els.offlineDlDetail.textContent = `${stepPrefix}✓ Cap. ${chIdx + 1}/${totalCh} ya estaba completo en memoria local (${existingCount} frases) — saltando...`;
        continue;
      }

      let firstMissingIdx = 0;
      while (
        firstMissingIdx < chTotalSents &&
        existingMap[String(firstMissingIdx)]
      ) {
        firstMissingIdx++;
      }
      if (firstMissingIdx > 0 && resumedFromSentence === null) {
        resumedFromSentence = { chapter: chIdx + 1, sentence: firstMissingIdx + 1 };
        showToast(
          `▶️ Reanudando «${bundleData.book.title}» desde Cap. ${chIdx + 1}, Frase ${firstMissingIdx + 1} (${existingCount} frases previas conservadas)`,
          5000
        );
      }

      for (let sStart = firstMissingIdx; sStart < chTotalSents; sStart += batchSize) {
        if (state.offlineDlCancel) break;

        const sEnd = Math.min(chTotalSents, sStart + batchSize);
        const chFraction = sStart / chTotalSents;
        const pct = Math.max(
          1,
          Math.round(((i + chFraction) / Math.max(1, countToDownload)) * 100)
        );
        els.offlineDlPhase.textContent = `${stepPrefix}«${bundleData.book.title}» (${voiceName}) — Cap. ${chIdx + 1} de ${totalCh}...`;
        els.offlineDlPct.textContent = `${pct}%`;
        els.offlineDlBar.style.width = `${pct}%`;
        els.offlineDlDetail.textContent = `Cap. ${chIdx + 1}: guardando frases ${sStart + 1}–${sEnd} de ${chTotalSents}...`;

        let audioPack = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= 4; attempt++) {
          if (state.offlineDlCancel) break;
          try {
            await startBackgroundKeepAlive();
            const resAudio = await fetch(
              `/api/books/${encodeURIComponent(targetBookId)}/chapters/${chIdx}/offline-audio`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  voice_id: voiceId,
                  speed,
                  start_sentence: sStart,
                  limit: batchSize,
                }),
              }
            );
            if (!resAudio.ok) {
              const err = await resAudio.json().catch(() => ({}));
              throw new Error(
                err.detail || `Error HTTP ${resAudio.status} en capítulo ${chIdx + 1}`
              );
            }
            audioPack = await resAudio.json();
            lastErr = null;
            break;
          } catch (batchErr) {
            lastErr = batchErr;
            if (state.offlineDlCancel) break;
            if (attempt < 4) {
              const waitSec = attempt * 2;
              els.offlineDlDetail.textContent = `⏳ Pausa momentánea de red/pantalla en Cap. ${chIdx + 1} (frase ${sStart + 1}) — Reintentando automáticamente (${attempt}/4 en ${waitSec}s)...`;
              await new Promise((r) => setTimeout(r, waitSec * 1000));
            }
          }
        }

        if (lastErr) {
          throw new Error(
            `Descarga pausada en «${bundleData.book.title}» Cap. ${chIdx + 1}, Frase ${sStart + 1} (${lastErr.message}). Todo lo anterior quedó guardado: pulsa «▶️ Continuar descarga» para retomar desde aquí.`
          );
        }

        if (
          audioPack &&
          Array.isArray(audioPack.sentences_audio) &&
          audioPack.sentences_audio.length > 0
        ) {
          await OfflineStore.saveChapterAudioPack(
            targetBookId,
            voiceId,
            speed,
            chIdx,
            voiceName,
            audioPack.sentences_audio,
            chTotalSents
          );
        }
      }

      if (state.offlineDlCancel) {
        showToast(
          "⏸ Descarga en pausa — Se han guardado todas las frases descargadas hasta este instante"
        );
        break;
      }

      const donePct = Math.round(((i + 1) / Math.max(1, countToDownload)) * 100);
      els.offlineDlPct.textContent = `${donePct}%`;
      els.offlineDlBar.style.width = `${donePct}%`;
    }

    if (!state.offlineDlCancel) {
      els.offlineDlPhase.textContent = `${stepPrefix}✅ «${bundleData.book.title}» y audios IA 100% verificados en este dispositivo`;
      els.offlineDlDetail.textContent =
        skippedChaptersCount > 0
          ? `Descarga completada (${skippedChaptersCount} cap. previos reutilizados sin volver a bajar)`
          : "Todos los capítulos solicitados están 100% completos para escuchar sin conexión";
      showToast(
        `📲 Audio IA y texto de «${bundleData.book.title}» 100% completos en local`,
        5500
      );
    }
    return bundleData.book;
  }

  async function startOfflineDownload() {
    const bookId = els.offlineBookSelect ? els.offlineBookSelect.value : "";
    if (!bookId) {
      showToast("Selecciona un libro primero");
      return;
    }
    if (state.isServerOffline) {
      showToast("Conéctate al servidor para descargar o reanudar libros en la memoria del dispositivo");
      return;
    }

    const mode = els.offlineModeSelect ? els.offlineModeSelect.value : "audio_all";
    const voiceId = els.offlineVoiceSelect ? els.offlineVoiceSelect.value : state.selectedVoice;
    const speed = Number(els.offlineSpeedSelect ? els.offlineSpeedSelect.value : 1.0) || 1.0;

    const chkIncludePartner = document.getElementById("chk-offline-include-partner");
    const pairedBox = document.getElementById("offline-paired-option-box");
    const partnerVoiceSelect = document.getElementById("offline-partner-voice-select");
    const selectedBookObj = state.books.find((b) => b.id === bookId) || null;
    const partnerBookId =
      selectedBookObj && selectedBookObj.pairing && selectedBookObj.pairing.paired_book_id
        ? selectedBookObj.pairing.paired_book_id
        : null;
    const includePartner = Boolean(
      partnerBookId &&
        chkIncludePartner &&
        chkIncludePartner.checked &&
        pairedBox &&
        !pairedBox.classList.contains("hidden")
    );
    const partnerVoiceId =
      (partnerVoiceSelect && partnerVoiceSelect.value) || voiceId;

    state.offlineDlCancel = false;
    state.isDownloadingOffline = true;
    await startBackgroundKeepAlive();

    const wlBadge = document.getElementById("offline-wakelock-badge");
    if (wlBadge) {
      wlBadge.textContent = wakeLockSentinel
        ? "🔆 Pantalla mantenida activa (no se apagará)"
        : "🔊 Red activa en segundo plano";
      wlBadge.classList.remove("hidden");
    }

    els.btnStartOfflineDl.disabled = true;
    els.offlineDlBox.classList.remove("hidden");

    try {
      await downloadSingleBookOffline(
        bookId,
        mode,
        voiceId,
        speed,
        includePartner ? "[1/2] " : ""
      );

      if (includePartner && !state.offlineDlCancel) {
        await downloadSingleBookOffline(
          partnerBookId,
          mode,
          partnerVoiceId,
          speed,
          "[2/2 Pareja bilingüe] "
        );
        if (!state.offlineDlCancel) {
          showToast(
            "🇬🇧↔🇪🇸 ¡Ambos libros de la pareja bilingüe están guardados en la memoria de este dispositivo!",
            6000
          );
        }
      }

      await refreshOfflineMap();
      renderLibrary();
      renderOfflineBooksList();
    } catch (err) {
      await refreshOfflineMap();
      renderLibrary();
      renderOfflineBooksList();
      showToast(`⚠️ ${err.message}`, 8000);
      els.offlineDlPhase.textContent = `⚠️ ${err.message}`;
    } finally {
      state.isDownloadingOffline = false;
      if (!state.isPlaying) {
        stopBackgroundKeepAlive();
      }
      els.btnStartOfflineDl.disabled = false;
      updateOfflineVoiceRowVisibility();
    }
  }

  function renderOfflineBooksList() {
    if (!els.offlineBooksList) return;
    els.offlineBooksList.innerHTML = "";
    const records = [...state.offlineBooksMap.values()];

    if (records.length === 0) {
      els.offlineBooksList.innerHTML = `
        <div class="model-row">
          <div class="model-info">
            <h4>Aún no tienes libros descargados en la memoria de este dispositivo</h4>
            <p>Elige un libro arriba y pulsa «📲 Guardar en este dispositivo» para poder abrirlo, leerlo y escucharlo incluso sin conexión al servidor.</p>
          </div>
        </div>
      `;
      return;
    }

    for (const rec of records) {
      const b = rec.book || {};
      const totalBookCh = (rec.chapters || []).length || Number(b.chapter_count || 0);
      const packs = Object.values(rec.audio_packs || {});
      let needsResumePack = null;

      const packsDesc =
        packs.length > 0
          ? packs
              .map((p) => {
                const completeArr = Array.isArray(p.complete_chapters)
                  ? p.complete_chapters
                  : p.chapters || [];
                const partials = Array.isArray(p.partial_chapters) ? p.partial_chapters : [];
                const savedSents = Number(p.saved_sentences_total || 0);
                const totalSents = Number(p.book_sentences_total || b.total_sentences || 0);
                const pctSents =
                  totalSents > 0 ? Math.min(100, Math.round((savedSents / totalSents) * 100)) : 0;

                if (partials.length > 0 || (totalBookCh > 0 && completeArr.length < totalBookCh)) {
                  if (!needsResumePack) needsResumePack = p;
                }

                if (partials.length > 0) {
                  const pt = partials[0];
                  return `⚠️ <strong>${escapeHtml(p.voice_name)}</strong> (${p.speed}×): <strong>${completeArr.length}/${totalBookCh} cap. completos</strong> (${pctSents}% del libro) • <span style="color:#f59e0b;font-weight:600">Se interrumpió en Cap. ${pt.chapter_index + 1} (frase ${pt.saved} de ${pt.total})</span>`;
                }
                if (totalBookCh > 0 && completeArr.length < totalBookCh) {
                  return `⏳ <strong>${escapeHtml(p.voice_name)}</strong> (${p.speed}×): <strong>${completeArr.length}/${totalBookCh} cap. descargados</strong> (${pctSents}% del libro — faltan ${totalBookCh - completeArr.length} cap.)`;
                }
                return `✅ <strong>${escapeHtml(p.voice_name)}</strong> (${p.speed}×): <strong>100% completo (${completeArr.length}/${totalBookCh} cap. • ${savedSents} frases verificadas)</strong>`;
              })
              .join("<br/>")
          : "📖 Solo texto y notas (sin pistas de audio IA descargadas)";

      const resumeBtnHtml = needsResumePack
        ? `<button class="primary-btn btn-resume-offline-book" data-id="${rec.id}" data-voice="${escapeHtml(needsResumePack.voice_id)}" data-speed="${needsResumePack.speed || 1.0}" style="padding:6px 12px;font-size:0.78rem;background:#d97706;border-color:#d97706" title="Continúa descargando exactamente desde el capítulo y frase donde se interrumpió">▶️ Continuar descarga</button>`
        : "";

      const row = document.createElement("div");
      row.className = "model-row";
      row.innerHTML = `
        <div class="model-info">
          <h4>📲 <strong>${escapeHtml(b.title || rec.id)}</strong> <small style="color:var(--text-secondary)">(${totalBookCh} capítulos en memoria local)</small></h4>
          <p style="line-height:1.45">${packsDesc}</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${resumeBtnHtml}
          <button class="primary-btn btn-open-offline-book" data-id="${rec.id}" style="padding:6px 12px;font-size:0.78rem">📖 Abrir</button>
          <button class="secondary-btn btn-export-vozbook" data-id="${rec.id}" style="padding:6px 10px;font-size:0.78rem;font-weight:600" title="Guardar una copia de este libro local y sus audios como archivo .vozbook en la carpeta Descargas del teléfono">💾 Archivo .vozbook</button>
          <button class="delete-book-btn btn-del-offline-book" data-id="${rec.id}" data-title="${escapeHtml(b.title || rec.id)}" style="padding:6px 10px;font-size:0.78rem;font-weight:600">🗑 Quitar</button>
        </div>
      `;

      const resumeBtn = row.querySelector(".btn-resume-offline-book");
      if (resumeBtn) {
        resumeBtn.addEventListener("click", async () => {
          const bId = resumeBtn.dataset.id;
          const vId = resumeBtn.dataset.voice;
          const spd = resumeBtn.dataset.speed || "1.0";
          if (els.offlineBookSelect) els.offlineBookSelect.value = bId;
          syncOfflineVoiceSelector(rec.book || { id: bId });
          if (els.offlineModeSelect) els.offlineModeSelect.value = "audio_all";
          updateOfflineVoiceRowVisibility();
          if (els.offlineVoiceSelect && vId) {
            if (![...els.offlineVoiceSelect.options].some((o) => o.value === vId)) {
              const opt = document.createElement("option");
              opt.value = vId;
              opt.textContent = needsResumePack.voice_name || vId;
              els.offlineVoiceSelect.appendChild(opt);
            }
            els.offlineVoiceSelect.value = vId;
          }
          if (els.offlineSpeedSelect) els.offlineSpeedSelect.value = String(spd);
          await startOfflineDownload();
        });
      }

      row.querySelector(".btn-open-offline-book").addEventListener("click", async () => {
        state.offlineDlCancel = true;
        els.offlineModal.classList.add("hidden");
        await openBook(rec.id, { preferLocal: true });
      });

      row.querySelector(".btn-export-vozbook").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = "Empaquetando...";
        try {
          await exportBookAsVozbookFile(rec.id, b.title || rec.id);
        } finally {
          btn.disabled = false;
          btn.textContent = "💾 Archivo .vozbook";
        }
      });

      row.querySelector(".btn-del-offline-book").addEventListener("click", async () => {
        if (
          !confirm(
            `¿Borrar «${b.title || rec.id}» de la memoria local de este dispositivo?\n(El libro seguirá intacto en tu servidor)`
          )
        ) {
          return;
        }
        await OfflineStore.deleteBook(rec.id);
        cachedLocalChapterPack = null;
        await refreshOfflineMap();
        renderLibrary();
        renderOfflineBooksList();
        showToast("Libro eliminado de la memoria local de este dispositivo");
      });

      els.offlineBooksList.appendChild(row);
    }
  }

  async function exportBookAsVozbookFile(bookId, bookTitle) {
    try {
      showToast("Empaquetando libro y audios locales en archivo .vozbook...");
      const archiveObj = await OfflineStore.exportFullBookArchive(bookId);
      const jsonStr = JSON.stringify(archiveObj);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const safeTitle =
        String(bookTitle || bookId)
          .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ _-]/g, "")
          .trim() || bookId;
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeTitle}.vozbook`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast(`💾 Archivo «${safeTitle}.vozbook» guardado en tu dispositivo`, 4500);
    } catch (err) {
      showToast(`Error exportando .vozbook: ${err.message}`, 4500);
    }
  }

  async function importVozbookFile(file) {
    if (!file) return;
    try {
      showToast(`Importando «${file.name}» a la memoria local...`, 4000);
      const text = await file.text();
      const archiveData = JSON.parse(text);
      const bookRec = await OfflineStore.importFullBookArchive(archiveData);
      await refreshOfflineMap();
      await fetchLibrary();
      renderOfflineBooksList();
      showToast(`✅ Libro «${(bookRec.book && bookRec.book.title) || file.name}» importado en memoria local`, 4500);
    } catch (err) {
      showToast(`Error al importar archivo .vozbook: ${err.message}`, 5000);
    }
  }

  async function copyTextToClipboard(text, successMsg) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMsg, 4200);
      return;
    } catch (_) {}
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
      showToast(successMsg, 4200);
    } catch (_) {
      prompt("Copia este texto:", text);
    }
    ta.remove();
  }

  async function saveCustomServerUrl(rawUrl) {
    let cleaned = String(rawUrl || "").trim();
    if (!cleaned) {
      cleaned = window.location.origin;
    } else if (!/^https?:\/\//i.test(cleaned)) {
      cleaned = `http://${cleaned}`;
    }
    if (!/:\d+\/?$/.test(cleaned) && /^http:\/\/\d+\.\d+\.\d+\.\d+\/?$/.test(cleaned)) {
      const defaultPort = window.location.port || "8085";
      cleaned = `${cleaned.replace(/\/+$/, "")}:${defaultPort}`;
    }
    cleaned = cleaned.replace(/\/+$/, "");

    if (els.serverScanStatus) {
      els.serverScanStatus.textContent = `Probando conexión con ${cleaned}...`;
    }
    try {
      const res = await nativeFetch(`${cleaned}/api/ping`, {
        method: "GET",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.serverUrl = cleaned;
      localStorage.setItem("vozlectura_server_url", cleaned);
      if (els.offlineServerUrlInput) els.offlineServerUrlInput.value = cleaned;
      if (els.serverScanStatus) {
        els.serverScanStatus.textContent = `✓ Conectado correctamente a ${cleaned}`;
        els.serverScanStatus.style.color = "#16a34a";
      }
      showToast(`✅ Conectado al servidor en ${cleaned} (conservando tus libros locales)`, 4500);
      await Promise.all([fetchLibrary(), fetchVoices()]);
      return true;
    } catch (err) {
      state.serverUrl = cleaned;
      localStorage.setItem("vozlectura_server_url", cleaned);
      if (els.serverScanStatus) {
        els.serverScanStatus.textContent = `⚠️ Guardado ${cleaned}, pero el servidor no responde aún en esa IP.`;
        els.serverScanStatus.style.color = "#f59e0b";
      }
      showToast(`Guardada IP ${cleaned}, pero no hubo respuesta del servidor`, 4200);
      return false;
    }
  }

  async function scanLocalNetworkForServer() {
    const port = window.location.port || "8085";
    const prefixes = new Set();
    const hostMatch = (state.serverUrl || "").match(/(\d+\.\d+\.\d+)\.\d+/);
    if (hostMatch) prefixes.add(hostMatch[1]);
    const locMatch = (window.location.hostname || "").match(/^(\d+\.\d+\.\d+)\.\d+$/);
    if (locMatch) prefixes.add(locMatch[1]);
    prefixes.add("192.168.1");
    prefixes.add("192.168.0");

    if (els.btnScanServerIp) els.btnScanServerIp.disabled = true;
    if (els.btnBannerScanIp) els.btnBannerScanIp.disabled = true;
    showToast("🔍 Buscando servidor VozLectura en tu red Wi-Fi...", 4000);

    try {
      for (const prefix of prefixes) {
        const candidates = [DEFAULT_STATIC_SERVER_URL];
        for (let lastOctet = 2; lastOctet <= 254; lastOctet++) {
          const u = `http://${prefix}.${lastOctet}:${port}`;
          if (u !== DEFAULT_STATIC_SERVER_URL) {
            candidates.push(u);
          }
        }

        const batchSize = 36;
        for (let i = 0; i < candidates.length; i += batchSize) {
          const batch = candidates.slice(i, i + batchSize);
          if (els.serverScanStatus) {
            els.serverScanStatus.textContent = `Escaneando Wi-Fi ${prefix}.${i + 2}–${Math.min(254, i + batchSize + 1)}:${port}...`;
            els.serverScanStatus.style.color = "var(--text-secondary)";
          }

          const foundUrl = await new Promise((resolve) => {
            let pending = batch.length;
            let resolved = false;
            for (const candidateUrl of batch) {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 950);
              nativeFetch(`${candidateUrl}/api/ping`, { signal: controller.signal })
                .then(async (r) => {
                  clearTimeout(timer);
                  if (!resolved && r.ok) {
                    const data = await r.json().catch(() => ({}));
                    if (data && data.app === "vozlectura") {
                      resolved = true;
                      resolve(candidateUrl);
                      return;
                    }
                  }
                })
                .catch(() => {})
                .finally(() => {
                  clearTimeout(timer);
                  pending--;
                  if (pending <= 0 && !resolved) {
                    resolve(null);
                  }
                });
            }
          });

          if (foundUrl) {
            await saveCustomServerUrl(foundUrl);
            return foundUrl;
          }
        }
      }

      if (els.serverScanStatus) {
        els.serverScanStatus.textContent =
          "No se encontró el servidor encendido en la red Wi-Fi. Puedes seguir leyendo tus libros locales sin conexión.";
        els.serverScanStatus.style.color = "#f59e0b";
      }
      showToast("No se detectó el servidor en el Wi-Fi (verifica que el PC esté encendido)", 4500);
      return null;
    } finally {
      if (els.btnScanServerIp) els.btnScanServerIp.disabled = false;
      if (els.btnBannerScanIp) els.btnBannerScanIp.disabled = false;
    }
  }

  async function speakDictionaryWord() {
    if (!currentDictWord) return;
    if (!state.isServerOffline) {
      const voiceForWord =
        state.selectedVoice &&
        !state.selectedVoice.startsWith("browser:") &&
        !state.selectedVoice.startsWith("audiobook:")
          ? state.selectedVoice
          : currentDictLang === "es"
          ? "piper:es_ES-davefx-medium"
          : "piper:en_GB-cori-medium";
      try {
        const url = `/api/tts?text=${encodeURIComponent(currentDictWord)}&voice_id=${encodeURIComponent(voiceForWord)}&speed=0.95`;
        dictAudio.src = resolveApiUrl(url);
        await dictAudio.play();
        return;
      } catch (_) {}
    }
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(currentDictWord);
        u.lang = currentDictLang === "es" ? "es-ES" : "en-US";
        u.rate = 0.95;
        window.speechSynthesis.speak(u);
      } catch (_) {}
    }
  }

  let lightboxZoom = 1;

  function applyLightboxZoom() {
    const imgEl = document.getElementById("lightbox-img");
    const resetBtn = document.getElementById("btn-lightbox-zoom-reset");
    if (!imgEl) return;
    if (lightboxZoom <= 1.01) {
      imgEl.style.transform = "";
      imgEl.style.maxWidth = "96%";
      imgEl.style.maxHeight = "92%";
      if (resetBtn) resetBtn.textContent = "100%";
    } else {
      imgEl.style.maxWidth = "none";
      imgEl.style.maxHeight = "none";
      imgEl.style.transform = `scale(${lightboxZoom.toFixed(2)})`;
      if (resetBtn) resetBtn.textContent = `${Math.round(lightboxZoom * 100)}%`;
    }
  }

  function openImageLightbox(sourceImgEl) {
    const modal = document.getElementById("image-lightbox-modal");
    const imgEl = document.getElementById("lightbox-img");
    const capEl = document.getElementById("lightbox-caption");
    if (!modal || !imgEl || !sourceImgEl) return;
    lightboxZoom = 1;
    imgEl.src = sourceImgEl.currentSrc || sourceImgEl.src || "";
    imgEl.alt = sourceImgEl.alt || "Ilustración del libro";
    if (capEl) {
      capEl.textContent =
        (sourceImgEl.alt && sourceImgEl.alt.trim()) ||
        (state.currentBook ? `${state.currentBook.title} — Ilustración` : "Ilustración");
    }
    applyLightboxZoom();
    modal.classList.remove("hidden");
  }

  function closeImageLightbox() {
    const modal = document.getElementById("image-lightbox-modal");
    if (modal) modal.classList.add("hidden");
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Eventos de interfaz
  function bindEvents() {
    const lbModal = document.getElementById("image-lightbox-modal");
    const lbStage = document.getElementById("image-lightbox-stage");
    const lbImg = document.getElementById("lightbox-img");
    const btnLbClose = document.getElementById("btn-lightbox-close");
    const btnLbIn = document.getElementById("btn-lightbox-zoom-in");
    const btnLbOut = document.getElementById("btn-lightbox-zoom-out");
    const btnLbReset = document.getElementById("btn-lightbox-zoom-reset");
    if (btnLbClose) btnLbClose.addEventListener("click", closeImageLightbox);
    if (btnLbIn) {
      btnLbIn.addEventListener("click", () => {
        lightboxZoom = Math.min(3.5, lightboxZoom + 0.35);
        applyLightboxZoom();
      });
    }
    if (btnLbOut) {
      btnLbOut.addEventListener("click", () => {
        lightboxZoom = Math.max(1, lightboxZoom - 0.35);
        applyLightboxZoom();
      });
    }
    if (btnLbReset) {
      btnLbReset.addEventListener("click", () => {
        lightboxZoom = 1;
        applyLightboxZoom();
      });
    }
    if (lbImg) {
      lbImg.addEventListener("dblclick", () => {
        lightboxZoom = lightboxZoom > 1.05 ? 1 : 2;
        applyLightboxZoom();
      });
    }
    if (lbStage) {
      lbStage.addEventListener("click", (e) => {
        if (e.target === lbStage) closeImageLightbox();
      });
    }
    if (lbModal) {
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !lbModal.classList.contains("hidden")) {
          closeImageLightbox();
        }
      });
    }

    els.btnSelectEpub.addEventListener("click", (e) => {
      e.stopPropagation();
      els.fileInput.click();
    });
    if (els.btnTopbarAddBook) {
      els.btnTopbarAddBook.addEventListener("click", (e) => {
        e.stopPropagation();
        els.fileInput.click();
      });
    }
    if (els.btnOpenAudiobookSync) {
      els.btnOpenAudiobookSync.addEventListener("click", (e) => {
        e.stopPropagation();
        openAudiobookSyncModal({ mode: "new" });
      });
    }
    if (els.btnOpenAudiobookSyncFromExports) {
      els.btnOpenAudiobookSyncFromExports.addEventListener("click", () => {
        closeExportsModal();
        openAudiobookSyncModal({
          mode: "existing",
          bookObj: state.exportTargetBook || state.currentBook || state.books[0] || null,
        });
      });
    }
    if (els.btnCloseAudiobookSync) {
      els.btnCloseAudiobookSync.addEventListener("click", () => {
        els.audiobookSyncModal.classList.add("hidden");
      });
    }
    if (els.audiobookSyncModal) {
      els.audiobookSyncModal.addEventListener("click", (e) => {
        if (e.target === els.audiobookSyncModal) {
          els.audiobookSyncModal.classList.add("hidden");
        }
      });
    }
    if (els.syncTargetMode) {
      els.syncTargetMode.addEventListener("change", updateSyncModalModeUi);
    }
    if (els.btnPickSyncEpub && els.syncEpubInput) {
      els.btnPickSyncEpub.addEventListener("click", () => els.syncEpubInput.click());
      els.syncEpubInput.addEventListener("change", () => {
        const f = els.syncEpubInput.files && els.syncEpubInput.files[0];
        if (f) {
          pendingSyncEpubFile = f;
          if (els.syncEpubFilename) els.syncEpubFilename.textContent = `✓ ${f.name}`;
        }
      });
    }
    if (els.btnPickSyncAudio && els.syncAudioInput) {
      els.btnPickSyncAudio.addEventListener("click", () => els.syncAudioInput.click());
      els.syncAudioInput.addEventListener("change", () => {
        if (els.syncAudioInput.files && els.syncAudioInput.files.length > 0) {
          pendingSyncAudioFiles = Array.from(els.syncAudioInput.files);
          if (els.syncAudioFilenames) {
            els.syncAudioFilenames.textContent =
              pendingSyncAudioFiles.length === 1
                ? `✓ ${pendingSyncAudioFiles[0].name}`
                : `✓ ${pendingSyncAudioFiles.length} archivos de audio seleccionados`;
          }
        }
      });
    }
    if (els.btnStartAudiobookSync) {
      els.btnStartAudiobookSync.addEventListener("click", submitAudiobookSync);
    }

    els.fileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleIncomingUploadFiles(e.target.files);
        e.target.value = "";
      }
    });

    if (els.dropZone) {
      els.dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        els.dropZone.classList.add("dragover");
      });
      els.dropZone.addEventListener("dragleave", () => {
        els.dropZone.classList.remove("dragover");
      });
      els.dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        els.dropZone.classList.remove("dragover");
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          handleIncomingUploadFiles(e.dataTransfer.files);
        }
      });
    }

    els.btnBackLibrary.addEventListener("click", async () => {
      const wasPlaying = state.isPlaying;
      hideDictionaryPopover();
      hideSelectionToolbar();
      await saveReadingProgress({ immediate: true });
      await flushActiveReadingSession({ keepActive: wasPlaying });
      els.readerView.classList.add("hidden");
      els.libraryView.classList.remove("hidden");
      els.btnBackLibrary.classList.add("hidden");
      els.btnToggleToc.classList.add("hidden");
      if (els.btnTopbarAddBook) els.btnTopbarAddBook.classList.remove("hidden");
      if (els.btnOpenStudy) els.btnOpenStudy.classList.add("hidden");
      if (els.btnOpenPairing) els.btnOpenPairing.classList.add("hidden");
      els.tocSidebar.classList.add("hidden");
      els.brandLogo.classList.remove("hide-mobile");
      els.currentBookTitle.textContent = "";
      els.currentBookTitle.title = "";
      applyAppearance();
      if (wasPlaying && state.currentBook) {
        showToast(`🎧 «${state.currentBook.title}» sigue reproduciéndose en el mini-reproductor`, 3200);
      }
      await Promise.all([fetchLibrary(), refreshExportsStatus()]);
    });

    // Conmutadores de Modo Audiolibro, Mini-reproductor y Temporizador de Apagado
    if (els.btnToggleAudiobookMode) {
      els.btnToggleAudiobookMode.addEventListener("click", () => {
        setReaderUiMode(state.readerUiMode === "audiobook" ? "reading" : "audiobook");
      });
    }
    if (els.btnPlayerAudiobookToggle) {
      els.btnPlayerAudiobookToggle.addEventListener("click", () => {
        if (!state.currentBook) return;
        if (els.readerView.classList.contains("hidden")) {
          returnToActiveBookView("audiobook");
        } else {
          setReaderUiMode(state.readerUiMode === "audiobook" ? "reading" : "audiobook");
        }
      });
    }
    if (els.playerSleepBadge) {
      els.playerSleepBadge.addEventListener("click", () => {
        if (!state.currentBook) return;
        returnToActiveBookView("audiobook");
      });
    }
    if (els.miniPlayerOpenBook) {
      els.miniPlayerOpenBook.addEventListener("click", () => returnToActiveBookView(null));
    }
    if (els.btnMiniOpenReading) {
      els.btnMiniOpenReading.addEventListener("click", () => returnToActiveBookView("reading"));
    }
    if (els.btnMiniOpenAudiobook) {
      els.btnMiniOpenAudiobook.addEventListener("click", () => returnToActiveBookView("audiobook"));
    }
    if (els.btnMiniClosePlayer) {
      els.btnMiniClosePlayer.addEventListener("click", () => {
        closeMiniPlayerAndStop();
      });
    }
    if (els.abBtnBackLibrary && els.btnBackLibrary) {
      els.abBtnBackLibrary.addEventListener("click", () => els.btnBackLibrary.click());
    }
    if (els.abBtnBackReading) {
      els.abBtnBackReading.addEventListener("click", () => setReaderUiMode("reading"));
    }
    if (els.abBtnOpenToc) {
      els.abBtnOpenToc.addEventListener("click", () => {
        els.tocSidebar.classList.toggle("hidden");
      });
    }
    if (els.abChapterBtn) {
      els.abChapterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        els.tocSidebar.classList.toggle("hidden");
      });
    }
    if (els.audiobookPlayerView) {
      els.audiobookPlayerView.addEventListener("click", (e) => {
        if (
          els.tocSidebar &&
          !els.tocSidebar.classList.contains("hidden") &&
          (!els.abChapterBtn || !els.abChapterBtn.contains(e.target))
        ) {
          els.tocSidebar.classList.add("hidden");
        }
      });
    }
    if (els.abBtnSwitchPaired) {
      els.abBtnSwitchPaired.addEventListener("click", switchToPairedBookNow);
    }
    if (els.abBtnPlayPause) {
      els.abBtnPlayPause.addEventListener("click", () => {
        if (state.isPlaying) stopPlayback();
        else startPlayback();
      });
    }
    if (els.abBtnPrevSent) {
      els.abBtnPrevSent.addEventListener("click", () => jumpBySentences(-1));
    }
    if (els.abBtnNextSent) {
      els.abBtnNextSent.addEventListener("click", () => jumpBySentences(1));
    }
    if (els.abBtnBackFast) {
      els.abBtnBackFast.addEventListener("click", () => jumpBySentences(-3));
    }
    if (els.abBtnFwdFast) {
      els.abBtnFwdFast.addEventListener("click", () => jumpBySentences(3));
    }
    if (els.abBtnPrevChapter) {
      els.abBtnPrevChapter.addEventListener("click", async () => {
        if (!state.currentBook || state.chapterIndex <= 0) return;
        const wasPlaying = state.isPlaying;
        stopPlayback();
        await loadChapter(state.chapterIndex - 1, 0, wasPlaying);
      });
    }
    if (els.abBtnNextChapter) {
      els.abBtnNextChapter.addEventListener("click", async () => {
        if (!state.currentBook) return;
        const wasPlaying = state.isPlaying;
        stopPlayback();
        await advanceAfterChapterEnd(wasPlaying);
      });
    }
    if (els.abBtnToggleSubtitle) {
      els.abBtnToggleSubtitle.addEventListener("click", () => {
        state.abShowSubtitle = !state.abShowSubtitle;
        saveAppearancePrefs();
        syncAudiobookAndMiniPlayerUi();
      });
    }
    if (els.abChapterSlider) {
      els.abChapterSlider.addEventListener("input", () => {
        const val = Number(els.abChapterSlider.value || 0);
        if (els.abSubtitleText) {
          const preview = getSentenceText(val);
          if (preview) els.abSubtitleText.textContent = preview;
        }
      });
      els.abChapterSlider.addEventListener("change", () => {
        const val = Number(els.abChapterSlider.value || 0);
        jumpToSentence(val);
      });
    }
    if (els.abSelectSpeed && els.selectSpeed) {
      els.abSelectSpeed.addEventListener("change", () => {
        els.selectSpeed.value = els.abSelectSpeed.value;
        els.selectSpeed.dispatchEvent(new Event("change"));
      });
    }
    if (els.abSelectVoice && els.selectVoice) {
      els.abSelectVoice.addEventListener("change", () => {
        els.selectVoice.value = els.abSelectVoice.value;
        els.selectVoice.dispatchEvent(new Event("change"));
      });
    }
    if (els.abBtnCarMode && els.btnQuickCarMode) {
      els.abBtnCarMode.addEventListener("click", () => {
        els.btnQuickCarMode.click();
      });
    }
    if (els.abSelectSleepTimer) {
      els.abSelectSleepTimer.addEventListener("change", () => {
        setSleepTimer(els.abSelectSleepTimer.value);
      });
    }
    if (els.btnCheckTtsUpdates) {
      els.btnCheckTtsUpdates.addEventListener("click", () => {
        checkTtsEngineUpdates({ force: true, notifyToast: false });
      });
    }

    window.addEventListener("beforeunload", () => {
      flushActiveReadingSession();
    });
    window.addEventListener("pagehide", () => {
      flushActiveReadingSession({ keepActive: true });
    });
    window.addEventListener("online", () => {
      state.isServerOffline = false;
      syncPendingOfflineSessions().then((cnt) => {
        if (cnt > 0) {
          fetchReadingAnalytics().catch(() => {});
        }
      });
      syncPendingOfflineStudyItems().catch(() => {});
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushActiveReadingSession({ keepActive: true });
      } else if (document.visibilityState === "visible") {
        if (state.activeSession) {
          const todayIso = getLocalIsoDateStr(new Date());
          if (state.activeSession.dateStr && state.activeSession.dateStr !== todayIso) {
            flushActiveReadingSession({ keepActive: false }).finally(() => {
              if (state.currentBook && (!els.readerView || !els.readerView.classList.contains("hidden"))) {
                startReadingSessionForCurrentBook();
              }
            });
          } else {
            state.activeSession.lastTickMs = Date.now();
          }
        }
        syncPendingOfflineSessions().catch(() => {});
        syncPendingOfflineStudyItems().catch(() => {});
        if (state.isServerOffline) {
          verifyServerOnline().catch(() => {});
        }
      }
    });
    window.addEventListener("focus", () => {
      if (state.isServerOffline) {
        verifyServerOnline().catch(() => {});
      }
    });

    els.btnToggleToc.addEventListener("click", () => {
      els.tocSidebar.classList.toggle("hidden");
    });
    els.btnCloseToc.addEventListener("click", () => {
      els.tocSidebar.classList.add("hidden");
    });

    els.btnPlayPause.addEventListener("click", () => {
      if (state.isPlaying) {
        stopPlayback();
      } else {
        startPlayback();
      }
    });

    els.btnPrevSentence.addEventListener("click", () => {
      jumpToSentence(state.sentenceIndex - 1);
    });
    els.btnNextSentence.addEventListener("click", () => {
      jumpToSentence(state.sentenceIndex + 1);
    });

    els.btnPrevChapter.addEventListener("click", async () => {
      if (state.chapterIndex > 0) {
        const wasPlaying = state.isPlaying;
        stopPlayback();
        await loadChapter(state.chapterIndex - 1, 0, wasPlaying);
      }
    });

    els.btnNextChapter.addEventListener("click", async () => {
      if (!state.currentBook) return;
      const wasPlaying = state.isPlaying;
      stopPlayback();
      await advanceAfterChapterEnd(wasPlaying);
    });

    // Eventos de Emparejamiento Bilingüe y Diccionario Contextual (Clic Derecho)
    if (els.btnOpenPairing) {
      els.btnOpenPairing.addEventListener("click", () => openPairingModal(state.currentBook));
    }
    if (els.btnClosePairing) {
      els.btnClosePairing.addEventListener("click", () => els.pairingModal.classList.add("hidden"));
    }
    if (els.pairingModal) {
      els.pairingModal.addEventListener("click", (e) => {
        if (e.target === els.pairingModal) els.pairingModal.classList.add("hidden");
      });
    }
    if (els.pairPartnerSelect) {
      els.pairPartnerSelect.addEventListener("change", updatePairingModalFields);
    }
    if (els.pairChSource) {
      els.pairChSource.addEventListener("change", () => {
        syncTargetSelectWithSourceChapter(Number(els.pairChSource.value || 0));
      });
    }
    if (els.pairChTarget) {
      els.pairChTarget.addEventListener("change", () => {
        const sIdx = Number(els.pairChSource.value || 0);
        const tIdx = Number(els.pairChTarget.value || 0);
        pairingWorkingMap[String(sIdx)] = tIdx;
        renderPairingMapTable();
        updatePairingOffsetLabel();
      });
    }
    const btnAutoAlignCh = document.getElementById("btn-auto-align-chapters");
    if (btnAutoAlignCh) {
      btnAutoAlignCh.addEventListener("click", applyAutoAlignmentInModal);
    }
    const btnApplyOffHere = document.getElementById("btn-apply-offset-from-here");
    if (btnApplyOffHere) {
      btnApplyOffHere.addEventListener("click", applyOffsetFromCurrentChapterOnwards);
    }
    const btnPairPrevSrc = document.getElementById("btn-pair-prev-src");
    const btnPairNextSrc = document.getElementById("btn-pair-next-src");
    const btnPairPrevTgt = document.getElementById("btn-pair-prev-tgt");
    const btnPairNextTgt = document.getElementById("btn-pair-next-tgt");
    if (btnPairPrevSrc) {
      btnPairPrevSrc.addEventListener("click", () => {
        const cur = Number(els.pairChSource.value || 0);
        if (cur > 0) {
          els.pairChSource.value = String(cur - 1);
          syncTargetSelectWithSourceChapter(cur - 1);
        }
      });
    }
    if (btnPairNextSrc) {
      btnPairNextSrc.addEventListener("click", () => {
        const cur = Number(els.pairChSource.value || 0);
        const maxIdx = Math.max(0, els.pairChSource.options.length - 1);
        if (cur < maxIdx) {
          els.pairChSource.value = String(cur + 1);
          syncTargetSelectWithSourceChapter(cur + 1);
        }
      });
    }
    if (btnPairPrevTgt) {
      btnPairPrevTgt.addEventListener("click", () => {
        const cur = Number(els.pairChTarget.value || 0);
        if (cur > 0) {
          els.pairChTarget.value = String(cur - 1);
          const sIdx = Number(els.pairChSource.value || 0);
          pairingWorkingMap[String(sIdx)] = cur - 1;
          renderPairingMapTable();
          updatePairingOffsetLabel();
        }
      });
    }
    if (btnPairNextTgt) {
      btnPairNextTgt.addEventListener("click", () => {
        const cur = Number(els.pairChTarget.value || 0);
        const maxIdx = Math.max(0, els.pairChTarget.options.length - 1);
        if (cur < maxIdx) {
          els.pairChTarget.value = String(cur + 1);
          const sIdx = Number(els.pairChSource.value || 0);
          pairingWorkingMap[String(sIdx)] = cur + 1;
          renderPairingMapTable();
          updatePairingOffsetLabel();
        }
      });
    }
    if (els.btnSavePairing) {
      els.btnSavePairing.addEventListener("click", saveBookPairing);
    }
    if (els.btnUnpairBooks) {
      els.btnUnpairBooks.addEventListener("click", unpairCurrentBook);
    }
    if (els.btnSwitchPaired) {
      els.btnSwitchPaired.addEventListener("click", switchToPairedBookNow);
    }

    if (els.chapterContent) {
      els.chapterContent.addEventListener("contextmenu", handleReaderContextMenu);
      els.chapterContent.addEventListener("mouseup", handleReaderSelectionEnd);
      els.chapterContent.addEventListener("keyup", handleReaderSelectionEnd);
      els.chapterContent.addEventListener("touchend", handleReaderSelectionEnd, { passive: true });
    }
    const btnSelectionDict = document.getElementById("btn-selection-dict");
    if (btnSelectionDict) {
      btnSelectionDict.addEventListener("mousedown", (e) => e.preventDefault());
      btnSelectionDict.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!pendingSelectionInfo || !pendingSelectionInfo.selectedText) return;
        const rawWord = pendingSelectionInfo.selectedText
          .trim()
          .split(/\s+/)[0]
          .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        if (!rawWord) return;
        const sIdx = pendingSelectionInfo.startSentenceIndex;
        const sentEl = document.getElementById(`sent-${sIdx}`);
        const contextSentence = sentEl
          ? sentEl.textContent.trim()
          : pendingSelectionInfo.selectedText;
        const bookLang = state.currentBook ? state.currentBook.language : "en";
        currentDictSentence = contextSentence;
        currentDictSentenceIdx = sIdx;
        const tbRect = els.selectionToolbar
          ? els.selectionToolbar.getBoundingClientRect()
          : { left: window.innerWidth / 2, bottom: window.innerHeight / 3 };
        hideSelectionToolbar();
        await showDictionaryPopover(
          rawWord,
          bookLang,
          contextSentence,
          tbRect.left + 40,
          tbRect.bottom
        );
      });
    }
    if (els.btnCloseDict) {
      els.btnCloseDict.addEventListener("click", hideDictionaryPopover);
    }
    if (els.btnDictSpeak) {
      els.btnDictSpeak.addEventListener("click", speakDictionaryWord);
    }
    if (els.btnDictUnderline) {
      els.btnDictUnderline.addEventListener("click", () =>
        saveCurrentDictWordToVocab({ silent: false })
      );
    }
    if (els.dictVocabNote) {
      els.dictVocabNote.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          saveCurrentDictWordToVocab({ silent: false });
        }
      });
    }

    // Eventos de la barra flotante de selección de pasajes y notas
    document.querySelectorAll(".hl-color-btn").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const col = btn.dataset.hlColor || "yellow";
        saveSelectionHighlight(col, false);
      });
    });
    if (els.btnSelectionNote) {
      els.btnSelectionNote.addEventListener("mousedown", (e) => e.preventDefault());
      els.btnSelectionNote.addEventListener("click", (e) => {
        e.stopPropagation();
        saveSelectionHighlight("yellow", true);
      });
    }

    // Eventos del Cuaderno de Lectura y Exportación a Obsidian (.md)
    if (els.btnOpenStudy) {
      els.btnOpenStudy.addEventListener("click", () => openStudyModal(state.currentBook, "habits"));
    }
    if (els.btnCloseStudy) {
      els.btnCloseStudy.addEventListener("click", () => els.studyModal.classList.add("hidden"));
    }
    if (els.studyModal) {
      els.studyModal.addEventListener("click", (e) => {
        if (e.target === els.studyModal) els.studyModal.classList.add("hidden");
      });
    }
    const btnStudyOpenPartner = document.getElementById("btn-study-open-partner");
    if (btnStudyOpenPartner) {
      btnStudyOpenPartner.addEventListener("click", () => {
        const pid = btnStudyOpenPartner.dataset.partnerId;
        if (!pid) return;
        const found =
          state.books.find((b) => b.id === pid) ||
          (state.archivedBooks || []).find((b) => b.id === pid) || {
            id: pid,
            title: btnStudyOpenPartner.dataset.partnerTitle || pid,
            language: btnStudyOpenPartner.dataset.partnerLang || "es",
          };
        openStudyModal(found, currentActiveStudyTab || "habits");
      });
    }
    document.querySelectorAll(".study-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        switchStudyTab(btn.dataset.studyTab || "habits");
      });
    });
    if (els.btnSaveStudyMeta) {
      els.btnSaveStudyMeta.addEventListener("click", saveStudyMetaFromModal);
    }
    if (els.btnAddManualSession) {
      els.btnAddManualSession.addEventListener("click", addManualReadingSession);
    }
    if (els.btnDownloadObsidianTop) {
      els.btnDownloadObsidianTop.addEventListener("click", downloadObsidianMarkdownFile);
    }
    if (els.btnDownloadObsidianMd) {
      els.btnDownloadObsidianMd.addEventListener("click", downloadObsidianMarkdownFile);
    }
    if (els.btnCopyObsidianMd) {
      els.btnCopyObsidianMd.addEventListener("click", copyObsidianMarkdownToClipboard);
    }
    const btnSyncObsidianNow = document.getElementById("btn-sync-obsidian-now");
    const btnPullObsidianNotes = document.getElementById("btn-pull-obsidian-notes");
    const btnToggleNotesRichView = document.getElementById("btn-toggle-notes-rich-view");
    const btnSaveObsidianConfig = document.getElementById("btn-save-obsidian-config");
    const btnSaveObsidianRawMd = document.getElementById("btn-save-obsidian-raw-md");
    const btnImportObsidianMdFile = document.getElementById("btn-import-obsidian-md-file");
    const obsidianMdFileInput = document.getElementById("obsidian-md-file-input");

    if (btnToggleNotesRichView) {
      btnToggleNotesRichView.addEventListener("click", () => {
        const richBox = document.getElementById("study-book-notes-rich-view");
        if (!richBox) return;
        updateStudyRichNotesView(els.studyBookNotes ? els.studyBookNotes.value : "", false);
        richBox.classList.toggle("hidden");
      });
    }
    if (els.studyBookNotes) {
      els.studyBookNotes.addEventListener("input", () => {
        const richBox = document.getElementById("study-book-notes-rich-view");
        if (richBox && !richBox.classList.contains("hidden")) {
          updateStudyRichNotesView(els.studyBookNotes.value, false);
        }
      });
    }

    if (btnSyncObsidianNow) {
      btnSyncObsidianNow.addEventListener("click", () => syncBookObsidianNow());
    }
    if (btnPullObsidianNotes) {
      btnPullObsidianNotes.addEventListener("click", () => syncBookObsidianNow());
    }
    if (btnSaveObsidianConfig) {
      btnSaveObsidianConfig.addEventListener("click", () => saveObsidianVaultConfigAndLink());
    }
    if (btnSaveObsidianRawMd) {
      btnSaveObsidianRawMd.addEventListener("click", () => saveRawObsidianMarkdownFromModal());
    }
    if (btnImportObsidianMdFile && obsidianMdFileInput) {
      btnImportObsidianMdFile.addEventListener("click", () => obsidianMdFileInput.click());
      obsidianMdFileInput.addEventListener("change", async () => {
        const f = obsidianMdFileInput.files && obsidianMdFileInput.files[0];
        if (f) {
          await importObsidianMdFileFromDevice(f);
          obsidianMdFileInput.value = "";
        }
      });
    }

    // Eventos del Modal de Modo Sin Conexión (Offline IndexedDB)
    if (els.btnOpenOffline) {
      els.btnOpenOffline.addEventListener("click", () => openOfflineModal(state.currentBook));
    }
    if (els.btnCloseOffline) {
      els.btnCloseOffline.addEventListener("click", () => els.offlineModal.classList.add("hidden"));
    }
    if (els.offlineModal) {
      els.offlineModal.addEventListener("click", (e) => {
        if (e.target === els.offlineModal) els.offlineModal.classList.add("hidden");
      });
    }
    if (els.offlineBookSelect) {
      els.offlineBookSelect.addEventListener("change", () => {
        const bId = els.offlineBookSelect.value;
        const found = state.books.find((b) => b.id === bId) || null;
        syncOfflineVoiceSelector(found);
      });
    }
    if (els.offlineModeSelect) {
      els.offlineModeSelect.addEventListener("change", updateOfflineVoiceRowVisibility);
    }
    const chkOfflinePartner = document.getElementById("chk-offline-include-partner");
    if (chkOfflinePartner) {
      chkOfflinePartner.addEventListener("change", updateOfflineVoiceRowVisibility);
    }
    if (els.btnStartOfflineDl) {
      els.btnStartOfflineDl.addEventListener("click", startOfflineDownload);
    }
    if (els.btnCancelOfflineDl) {
      els.btnCancelOfflineDl.addEventListener("click", () => {
        state.offlineDlCancel = true;
      });
    }

    document.addEventListener("click", (e) => {
      if (
        els.dictPopover &&
        !els.dictPopover.classList.contains("hidden") &&
        !els.dictPopover.contains(e.target) &&
        Date.now() - dictOpenedAtMs > 450
      ) {
        hideDictionaryPopover();
      }
      if (
        els.selectionToolbar &&
        !els.selectionToolbar.classList.contains("hidden") &&
        !els.selectionToolbar.contains(e.target)
      ) {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
          hideSelectionToolbar();
        }
      }
    });

    els.selectVoice.addEventListener("change", () => {
      state.selectedVoice = els.selectVoice.value;
      saveReadingProgress();
      if (state.isPlaying) {
        stopPlayback();
        startPlayback();
      } else {
        prefetchNextSentences(state.sentenceIndex - 1);
      }
    });

    els.selectSpeed.addEventListener("change", () => {
      state.speed = Number(els.selectSpeed.value);
      saveReadingProgress();
      if (state.isPlaying) {
        stopPlayback();
        startPlayback();
      }
    });

    // Popover de Apariencia
    els.btnOpenAppearance.addEventListener("click", (e) => {
      e.stopPropagation();
      els.appearancePopover.classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!els.appearancePopover.contains(e.target) && e.target !== els.btnOpenAppearance) {
        els.appearancePopover.classList.add("hidden");
      }
    });

    document.querySelectorAll(".theme-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.theme = btn.dataset.theme;
        applyAppearance();
        saveAppearancePrefs();
      });
    });

    document.querySelectorAll(".font-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.fontFamily = btn.dataset.font;
        applyAppearance();
        saveAppearancePrefs();
      });
    });

    els.btnFontDec.addEventListener("click", () => {
      state.fontSize = Math.max(14, state.fontSize - 1);
      applyAppearance();
      saveAppearancePrefs();
    });
    els.btnFontInc.addEventListener("click", () => {
      state.fontSize = Math.min(30, state.fontSize + 1);
      applyAppearance();
      saveAppearancePrefs();
    });

    if (els.btnLhDec) {
      els.btnLhDec.addEventListener("click", () => {
        state.lineHeight = Math.max(1.2, Math.round((state.lineHeight - 0.1) * 100) / 100);
        applyAppearance();
        saveAppearancePrefs();
      });
    }
    if (els.btnLhInc) {
      els.btnLhInc.addEventListener("click", () => {
        state.lineHeight = Math.min(2.6, Math.round((state.lineHeight + 0.1) * 100) / 100);
        applyAppearance();
        saveAppearancePrefs();
      });
    }

    document.querySelectorAll(".flow-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.flowMode = btn.dataset.flow === "paginated" ? "paginated" : "scroll";
        applyAppearance();
        saveAppearancePrefs();
      });
    });

    if (els.btnToggleFlow) {
      els.btnToggleFlow.addEventListener("click", () => {
        state.flowMode = state.flowMode === "paginated" ? "scroll" : "paginated";
        applyAppearance();
        saveAppearancePrefs();
      });
    }

    const btnQuickTheme = document.getElementById("btn-quick-theme");
    if (btnQuickTheme) {
      btnQuickTheme.addEventListener("click", () => {
        if (state.theme === "theme-sepia") state.theme = "theme-dark";
        else if (state.theme === "theme-dark") state.theme = "theme-light";
        else state.theme = "theme-sepia";
        applyAppearance();
        saveAppearancePrefs();
      });
    }

    if (els.btnPagePrev) {
      els.btnPagePrev.addEventListener("click", () => turnPage(-1));
    }
    if (els.btnPageNext) {
      els.btnPageNext.addEventListener("click", () => turnPage(1));
    }
    if (els.btnFooterPagePrev) {
      els.btnFooterPagePrev.addEventListener("click", () => turnPage(-1));
    }
    if (els.btnFooterPageNext) {
      els.btnFooterPageNext.addEventListener("click", () => turnPage(1));
    }

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.flowMode === "paginated") {
          updatePaginationLayout(true);
        }
      }, 120);
    });

    // Soporte de gesto swipe horizontal en Android / pantallas táctiles para pasar de hoja
    if (els.chapterViewport) {
      let touchStartX = 0;
      let touchStartY = 0;
      els.chapterViewport.addEventListener(
        "touchstart",
        (e) => {
          if (state.flowMode !== "paginated" || !e.touches[0]) return;
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
        },
        { passive: true }
      );
      els.chapterViewport.addEventListener(
        "touchend",
        (e) => {
          if (state.flowMode !== "paginated" || !e.changedTouches[0]) return;
          const dx = e.changedTouches[0].clientX - touchStartX;
          const dy = e.changedTouches[0].clientY - touchStartY;
          if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
            if (dx < 0) turnPage(1);
            else turnPage(-1);
          }
        },
        { passive: true }
      );
    }

    document.querySelectorAll(".col-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.columns = Number(btn.dataset.cols) || 1;
        applyAppearance();
        saveAppearancePrefs();
      });
    });

    document.querySelectorAll(".align-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.textAlign = btn.dataset.align === "left" ? "left" : "justify";
        applyAppearance();
        saveAppearancePrefs();
      });
    });

    document.querySelectorAll(".indent-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.textIndent = btn.dataset.indent || "normal";
        applyAppearance();
        saveAppearancePrefs();
      });
    });

    document.querySelectorAll(".margin-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.marginSize = btn.dataset.margin || "normal";
        applyAppearance();
        saveAppearancePrefs();
      });
    });

    els.chkAutoscroll.addEventListener("change", () => {
      state.autoScroll = els.chkAutoscroll.checked;
      saveAppearancePrefs();
    });

    if (els.chkAutoFullscreen) {
      els.chkAutoFullscreen.addEventListener("change", () => {
        state.autoFullscreen = els.chkAutoFullscreen.checked;
        saveAppearancePrefs();
      });
    }
    if (els.chkImmersiveReader) {
      els.chkImmersiveReader.addEventListener("change", () => {
        state.immersiveReader = els.chkImmersiveReader.checked;
        applyAppearance();
        saveAppearancePrefs();
      });
    }
    if (els.selectSentenceGap) {
      els.selectSentenceGap.addEventListener("change", () => {
        state.sentenceGapMode = els.selectSentenceGap.value || "auto";
        state.carBluetoothManualOverride = null;
        standbyPreparedUrl = null;
        saveAppearancePrefs();
        updateCarModeUi();
        if (state.sentenceGapMode === "auto") {
          evaluateCarBluetoothConnection({ notifyChange: false });
        }
        if (state.isPlaying) {
          prefetchNextSentences(state.sentenceIndex);
        }
        const labels = {
          auto: state.isCarBluetoothDetected
            ? "🚗 Modo Automático: Bluetooth del coche detectado (Recortes activos)"
            : "🚗 Modo Automático: Audio original en la app (activará recortes al detectar el Bluetooth del coche)",
          car: "🚗 Modo Coche siempre activo: silencios recortados y transición sin pausas",
          tight: "⚡ Modo Rápido activo: silencios entre frases recortados",
          normal: "📖 Modo Normal siempre activo: audiolibro tal cual se genera en la app",
        };
        showToast(labels[state.sentenceGapMode] || labels.auto, 4200);
      });
    }
    if (els.btnDetectCarBt) {
      els.btnDetectCarBt.addEventListener("click", (e) => {
        e.stopPropagation();
        requestCarBluetoothPermissionAndScan();
      });
    }
    if (els.inputCarBtName) {
      els.inputCarBtName.addEventListener("change", () => {
        state.carBluetoothCustomName = els.inputCarBtName.value.trim();
        saveAppearancePrefs();
        evaluateCarBluetoothConnection({ notifyChange: true });
      });
      els.inputCarBtName.addEventListener("input", () => {
        state.carBluetoothCustomName = els.inputCarBtName.value.trim();
        saveAppearancePrefs();
        evaluateCarBluetoothConnection({ notifyChange: false });
      });
    }
    if (els.btnQuickCarMode) {
      els.btnQuickCarMode.addEventListener("click", () => {
        const currentlyCar = getEffectiveSentenceGapMode() === "car";
        state.carBluetoothManualOverride = !currentlyCar;
        standbyPreparedUrl = null;
        updateCarModeUi();
        if (state.isPlaying) {
          prefetchNextSentences(state.sentenceIndex);
        }
        showToast(
          !currentlyCar
            ? "🚗 Modo Coche ACTIVADO (Recorte de pausas y transición rápida)"
            : "📖 Modo Normal ACTIVADO (Audiolibro tal cual se genera en la app, sin recortes)",
          3800
        );
      });
    }
    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
      navigator.mediaDevices.addEventListener("devicechange", () => {
        evaluateCarBluetoothConnection({ notifyChange: true });
      });
    }
    if (els.btnToggleFullscreen) {
      els.btnToggleFullscreen.addEventListener("click", () => {
        toggleNativeFullscreen();
      });
    }
    if (els.btnToggleImmersive) {
      els.btnToggleImmersive.addEventListener("click", () => {
        state.immersiveReader = true;
        enterFullscreenIfAllowed();
        applyAppearance();
        saveAppearancePrefs();
      });
    }
    if (els.btnExitImmersive) {
      els.btnExitImmersive.addEventListener("click", () => {
        state.immersiveReader = false;
        applyAppearance();
        saveAppearancePrefs();
      });
    }

    // Modal de Cola de Conversión M4B / EPUB3 Media Overlay
    if (els.btnOpenExports) {
      els.btnOpenExports.addEventListener("click", () => openExportsModal(state.currentBook));
    }
    if (els.btnLibraryOpenQueue) {
      els.btnLibraryOpenQueue.addEventListener("click", () => openExportsModal(null));
    }
    if (els.btnBannerOpenQueue) {
      els.btnBannerOpenQueue.addEventListener("click", () => openExportsModal(null));
    }
    if (els.exportBookSelect) {
      els.exportBookSelect.addEventListener("change", () => {
        const bId = els.exportBookSelect.value;
        const found = state.books.find((b) => b.id === bId) || null;
        state.exportTargetBook = found;
        syncExportVoiceSelectorForBook(found);
        refreshExportsStatus();
      });
    }
    if (els.chkExportFilterBook) {
      els.chkExportFilterBook.addEventListener("change", () => {
        refreshExportsStatus();
      });
    }
    if (els.btnCloseExports) {
      els.btnCloseExports.addEventListener("click", closeExportsModal);
    }
    if (els.exportsModal) {
      els.exportsModal.addEventListener("click", (e) => {
        if (e.target === els.exportsModal) closeExportsModal();
      });
    }
    if (els.btnStartExport) {
      els.btnStartExport.addEventListener("click", async () => {
        const selectedBookId = els.exportBookSelect
          ? els.exportBookSelect.value
          : state.exportTargetBook
          ? state.exportTargetBook.id
          : "";
        if (!selectedBookId) {
          showToast("Selecciona primero un libro de la biblioteca");
          return;
        }
        const vid = els.exportVoiceSelect.value;
        const spd = Number(els.exportSpeedSelect.value) || 1.0;
        const wantM4b = els.chkExportM4b ? els.chkExportM4b.checked : true;
        const wantEpub = els.chkExportEpub ? els.chkExportEpub.checked : true;
        els.btnStartExport.disabled = true;
        try {
          const res = await fetch(`/api/books/${selectedBookId}/exports/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              voice_id: vid,
              speed: spd,
              build_m4b: wantM4b,
              build_epub_overlay: wantEpub,
            }),
          });
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "No se pudo iniciar la codificación");
          }
          showToast("Codificación iniciada en segundo plano");
          await refreshExportsStatus();
        } catch (err) {
          showToast(`Error: ${err.message}`);
          els.btnStartExport.disabled = false;
        }
      });
    }
    if (els.btnCancelExport) {
      els.btnCancelExport.addEventListener("click", async () => {
        const bId =
          els.btnCancelExport.dataset.book ||
          (state.exportTargetBook ? state.exportTargetBook.id : "");
        if (!bId) return;
        try {
          await fetch(`/api/books/${bId}/exports/cancel`, {
            method: "POST",
          });
          showToast("Pausando tras completar la frase actual...");
          await refreshExportsStatus();
        } catch (_) {}
      });
    }
    if (els.btnDeleteActiveExport) {
      els.btnDeleteActiveExport.addEventListener("click", async () => {
        const bId =
          els.btnDeleteActiveExport.dataset.book ||
          (state.exportTargetBook ? state.exportTargetBook.id : "");
        const vhash = els.btnDeleteActiveExport.dataset.vhash;
        if (!bId || !vhash) return;
        if (!confirm("¿Cancelar esta conversión y borrar los archivos generados hasta ahora?")) return;
        try {
          const res = await fetch(
            `/api/books/${encodeURIComponent(bId)}/exports/${encodeURIComponent(vhash)}`,
            { method: "DELETE" }
          );
          const data = await res.json();
          showToast(`Conversión cancelada y borrada (${data.freed_mb || 0} MB liberados)`);
          await refreshExportsStatus();
        } catch (_) {}
      });
    }

    // Modal de Modelos TTS Locales (Piper MIT & Kokoro 82M Apache 2.0)
    els.btnOpenModels.addEventListener("click", async () => {
      els.modelsModal.classList.remove("hidden");
      renderTtsUpdatesPanel();
      if (!state.ttsUpdatesData) {
        checkTtsEngineUpdates({ force: false, notifyToast: false }).catch(() => {});
      }
      await fetchVoices();
    });
    els.btnCloseModels.addEventListener("click", () => {
      els.modelsModal.classList.add("hidden");
    });
    els.modelsModal.addEventListener("click", (e) => {
      if (e.target === els.modelsModal) {
        els.modelsModal.classList.add("hidden");
      }
    });

    // Eventos del Centro de Hábitos, Calendario, Valoraciones y Resumen Anual
    const btnOpenAnalytics = document.getElementById("btn-open-analytics");
    const btnLibOpenAnalytics = document.getElementById("btn-library-open-analytics");
    const btnCloseAnalytics = document.getElementById("btn-close-analytics");
    const analyticsModalEl = document.getElementById("analytics-modal");

    if (btnOpenAnalytics) {
      btnOpenAnalytics.addEventListener("click", () => openAnalyticsModal("calendar"));
    }
    if (btnLibOpenAnalytics) {
      btnLibOpenAnalytics.addEventListener("click", () => openAnalyticsModal("calendar"));
    }
    if (btnCloseAnalytics && analyticsModalEl) {
      btnCloseAnalytics.addEventListener("click", () => analyticsModalEl.classList.add("hidden"));
    }
    if (analyticsModalEl) {
      analyticsModalEl.addEventListener("click", (e) => {
        if (e.target === analyticsModalEl) analyticsModalEl.classList.add("hidden");
      });
    }
    document.querySelectorAll("[data-analytics-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        switchAnalyticsTab(btn.dataset.analyticsTab || "calendar");
      });
    });

    const btnCalPrev = document.getElementById("btn-cal-prev-month");
    const btnCalNext = document.getElementById("btn-cal-next-month");
    const btnCalToday = document.getElementById("btn-cal-today");
    if (btnCalPrev) {
      btnCalPrev.addEventListener("click", () => {
        analyticsCalMonth--;
        if (analyticsCalMonth < 0) {
          analyticsCalMonth = 11;
          analyticsCalYear--;
        }
        if (analyticsDataCache) renderAnalyticsMonthGrid(analyticsDataCache);
      });
    }
    if (btnCalNext) {
      btnCalNext.addEventListener("click", () => {
        analyticsCalMonth++;
        if (analyticsCalMonth > 11) {
          analyticsCalMonth = 0;
          analyticsCalYear++;
        }
        if (analyticsDataCache) renderAnalyticsMonthGrid(analyticsDataCache);
      });
    }
    if (btnCalToday) {
      btnCalToday.addEventListener("click", () => {
        const now = new Date();
        analyticsCalYear = now.getFullYear();
        analyticsCalMonth = now.getMonth();
        analyticsSelectedDate = toIsoDateLocal(now);
        if (analyticsDataCache) {
          renderAnalyticsMonthGrid(analyticsDataCache);
          renderAnalyticsWeekBars(analyticsDataCache);
          renderAnalyticsSelectedDayDetail(analyticsDataCache, analyticsSelectedDate);
        }
      });
    }

    const btnSaveGoals = document.getElementById("btn-save-reading-goals");
    if (btnSaveGoals) {
      btnSaveGoals.addEventListener("click", async () => {
        const dm = Number((document.getElementById("goal-daily-minutes") || {}).value || 30);
        const yb = Number((document.getElementById("goal-yearly-books") || {}).value || 12);
        const yp = Number((document.getElementById("goal-yearly-pages") || {}).value || 3600);
        const res = await fetch("/api/reading-goals", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            daily_minutes_goal: dm,
            yearly_books_goal: yb,
            yearly_pages_goal: yp,
          }),
        });
        if (res.ok) {
          analyticsDataCache = await res.json();
          renderAllAnalyticsTabs(analyticsDataCache);
          showToast("🎯 Metas de lectura actualizadas");
        }
      });
    }

    const btnQuickAddSess = document.getElementById("btn-analytics-add-session");
    if (btnQuickAddSess) {
      btnQuickAddSess.addEventListener("click", async () => {
        const bId = (document.getElementById("analytics-quick-book") || {}).value;
        const mins = Number((document.getElementById("analytics-quick-mins") || {}).value || 30);
        const note = ((document.getElementById("analytics-quick-note") || {}).value || "").trim();
        if (!bId || mins <= 0) {
          showToast("Selecciona un libro e indica los minutos leídos");
          return;
        }
        const res = await fetch(`/api/books/${encodeURIComponent(bId)}/study/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            duration_seconds: Math.round(mins * 60),
            duration_minutes: mins,
            date: analyticsSelectedDate,
            chapter_title: note || "Sesión registrada en calendario",
            note,
          }),
        });
        if (res.ok) {
          showToast(`✅ Añadidos ${mins} min en el calendario (${analyticsSelectedDate})`);
          const noteInput = document.getElementById("analytics-quick-note");
          if (noteInput) noteInput.value = "";
          const updated = await fetchReadingAnalytics();
          if (updated) renderAllAnalyticsTabs(updated);
        }
      });
    }

    ["rank-filter-status", "rank-filter-rating", "rank-filter-lang", "rank-sort-by"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("change", () => {
          if (analyticsDataCache) renderAnalyticsRankingsTab(analyticsDataCache);
        });
      }
    });

    const btnExpRankMd = document.getElementById("btn-export-rankings-md");
    const btnExpRankCsv = document.getElementById("btn-export-rankings-csv");
    const btnExpAnnualMd = document.getElementById("btn-export-annual-md");
    const yearSelEl = document.getElementById("analytics-year-select");

    if (btnExpRankMd) btnExpRankMd.addEventListener("click", exportRankingsAsMarkdown);
    if (btnExpRankCsv) btnExpRankCsv.addEventListener("click", exportRankingsAsCsv);
    if (btnExpAnnualMd) btnExpAnnualMd.addEventListener("click", exportAnnualSummaryAsMarkdown);
    if (yearSelEl) {
      yearSelEl.addEventListener("change", () => {
        analyticsSelectedAnnualYear = yearSelEl.value;
        if (analyticsDataCache) renderAnalyticsAnnualTab(analyticsDataCache);
      });
    }

    // Eventos de filtros y ordenación de la Biblioteca Principal
    const btnToggleLibFilters = document.getElementById("btn-toggle-lib-filters");
    if (btnToggleLibFilters) {
      btnToggleLibFilters.addEventListener("click", () => {
        state.libFiltersCollapsed = state.libFiltersCollapsed === false ? true : false;
        updateLibFiltersCollapseUi();
      });
    }
    if (els.libFilterSearch) {
      els.libFilterSearch.addEventListener("input", () => {
        state.libFilterSearch = els.libFilterSearch.value;
        renderLibrary();
      });
    }
    if (els.libFilterAuthor) {
      els.libFilterAuthor.addEventListener("change", () => {
        state.libFilterAuthor = els.libFilterAuthor.value;
        renderLibrary();
      });
    }
    if (els.libFilterGenre) {
      els.libFilterGenre.addEventListener("change", () => {
        state.libFilterGenre = els.libFilterGenre.value;
        renderLibrary();
      });
    }
    if (els.libFilterStatus) {
      els.libFilterStatus.addEventListener("change", () => {
        state.libFilterStatus = els.libFilterStatus.value;
        renderLibrary();
      });
    }
    if (els.libFilterRating) {
      els.libFilterRating.addEventListener("change", () => {
        state.libFilterRating = els.libFilterRating.value;
        renderLibrary();
      });
    }
    if (els.libSortBy) {
      els.libSortBy.addEventListener("change", () => {
        state.libSortBy = els.libSortBy.value;
        // Por defecto para autor y título resulta más natural ascendente (A-Z), y para última lectura / fechas / nota / páginas descendente (más reciente / mayor primero)
        if (state.libSortBy === "author" || state.libSortBy === "title") {
          state.libSortDir = "asc";
        } else {
          state.libSortDir = "desc";
        }
        renderLibrary();
      });
    }
    if (els.btnLibSortDir) {
      els.btnLibSortDir.addEventListener("click", () => {
        state.libSortDir = state.libSortDir === "asc" ? "desc" : "asc";
        renderLibrary();
      });
    }
    if (els.btnLibResetFilters) {
      els.btnLibResetFilters.addEventListener("click", () => {
        resetLibraryFilters();
      });
    }

    // Banners y Controles de Modo App Sin Servidor / IP Dinámica / Archivos .vozbook
    if (els.btnBannerActivateSw) {
      els.btnBannerActivateSw.addEventListener("click", () => {
        openOfflineModal(state.currentBook);
      });
    }
    if (els.btnBannerOpenOffline) {
      els.btnBannerOpenOffline.addEventListener("click", () => {
        openOfflineModal(state.currentBook);
      });
    }
    if (els.btnBannerScanIp) {
      els.btnBannerScanIp.addEventListener("click", () => {
        scanLocalNetworkForServer();
      });
    }
    document.querySelectorAll(".browser-guide-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedBrowserGuide = btn.dataset.browser || "brave";
        renderBrowserGuideUi();
      });
    });
    if (els.btnCopyAppOrigin) {
      els.btnCopyAppOrigin.addEventListener("click", () => {
        const guide = BROWSER_OFFLINE_GUIDES[selectedBrowserGuide] || BROWSER_OFFLINE_GUIDES.brave;
        copyTextToClipboard(
          window.location.origin,
          `📋 Dirección copiada (${window.location.origin}). Ahora pulsa «${guide.copyBtnLabel}»`
        );
      });
    }
    if (els.btnCopyChromeFlag) {
      els.btnCopyChromeFlag.addEventListener("click", () => {
        const guide = BROWSER_OFFLINE_GUIDES[selectedBrowserGuide] || BROWSER_OFFLINE_GUIDES.brave;
        copyTextToClipboard(guide.flagUrl, guide.copyToastMsg);
      });
    }
    if (els.btnInstallPwaApp) {
      els.btnInstallPwaApp.addEventListener("click", async () => {
        if (!state.deferredInstallPrompt) return;
        state.deferredInstallPrompt.prompt();
        await state.deferredInstallPrompt.userChoice.catch(() => {});
        state.deferredInstallPrompt = null;
        updateSwStatusUi();
      });
    }
    if (els.btnSaveServerUrl) {
      els.btnSaveServerUrl.addEventListener("click", () => {
        saveCustomServerUrl(els.offlineServerUrlInput ? els.offlineServerUrlInput.value : "");
      });
    }
    if (els.btnScanServerIp) {
      els.btnScanServerIp.addEventListener("click", () => {
        scanLocalNetworkForServer();
      });
    }
    if (els.btnImportVozbook && els.vozbookFileInput) {
      els.btnImportVozbook.addEventListener("click", () => els.vozbookFileInput.click());
      els.vozbookFileInput.addEventListener("change", async () => {
        const f = els.vozbookFileInput.files && els.vozbookFileInput.files[0];
        if (f) {
          await importVozbookFile(f);
          els.vozbookFileInput.value = "";
        }
      });
    }

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      updateSwStatusUi();
    });

    // Atajos de teclado en Windows
    document.addEventListener("keydown", (e) => {
      if (els.readerView.classList.contains("hidden")) return;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;

      if (e.code === "Space") {
        e.preventDefault();
        if (state.isPlaying) stopPlayback();
        else startPlayback();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        jumpToSentence(state.sentenceIndex - 1);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        jumpToSentence(state.sentenceIndex + 1);
      } else if (e.code === "PageDown" && state.flowMode === "paginated" && state.readerUiMode !== "audiobook") {
        e.preventDefault();
        turnPage(1);
      } else if (e.code === "PageUp" && state.flowMode === "paginated" && state.readerUiMode !== "audiobook") {
        e.preventDefault();
        turnPage(-1);
      }
    });
  }

  // Registrar Service Worker para instalación PWA en Android y Windows
  async function forceUpdateAppFromServer() {
    showToast("🔄 Comprobando conexión con el servidor para actualizar...", 3500);
    let originReachable = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2200);
      const pingResp = await nativeFetch(`${window.location.origin}/api/ping`, {
        cache: "no-store",
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      originReachable = Boolean(pingResp && pingResp.ok);
    } catch (_) {
      originReachable = false;
    }

    if (!originReachable) {
      // NUNCA borrar el Service Worker ni la caché si la IP actual del navegador no responde (evita ERR_ADDRESS_UNREACHABLE)
      showToast(
        "⚠️ La IP actual no responde (el PC puede haber cambiado de IP en el Wi-Fi). Buscando nueva IP del servidor...",
        5000
      );
      const foundNewUrl = await scanLocalNetworkForServer();
      if (foundNewUrl && foundNewUrl !== window.location.origin) {
        if (
          confirm(
            `Se encontró el servidor encendido en la nueva dirección:\n${foundNewUrl}\n\n¿Quieres abrir la aplicación en esa nueva IP para cargar la última versión (${APP_VERSION})?`
          )
        ) {
          window.location.href = `${foundNewUrl}/?_v=${Date.now()}`;
        }
      }
      return;
    }

    showToast("🔄 Descargando última versión de la aplicación desde el servidor...", 4000);
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) {
          await r.update().catch(() => {});
        }
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        for (const k of keys) {
          if (k.startsWith("vozlectura-pwa-")) {
            await caches.delete(k).catch(() => {});
          }
        }
      }
    } catch (_) {}
    const url = new URL(window.location.href);
    url.searchParams.set("_v", `${APP_VERSION}_${Date.now()}`);
    window.location.replace(url.toString());
  }

  function syncAppVersionBadges(serverVersion = null) {
    const footerNote = document.getElementById("footer-version-note");
    const hasUpdate = Boolean(serverVersion && serverVersion !== APP_VERSION);
    if (footerNote) {
      footerNote.textContent = hasUpdate
        ? `VozLectura ${APP_VERSION} (🔄 Actualizar a ${serverVersion})`
        : `VozLectura ${APP_VERSION}`;
    }
  }

  function registerServiceWorker() {
    syncAppVersionBadges();
    updateSwStatusUi();
    const footerNote = document.getElementById("footer-version-note");
    if (footerNote) {
      footerNote.addEventListener("click", (e) => {
        e.stopPropagation();
        forceUpdateAppFromServer();
      });
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          state.swActive = Boolean(reg.active || reg.installing || reg.waiting);
          updateSwStatusUi();
          reg.update().catch(() => {});
          reg.addEventListener("updatefound", () => {
            state.swActive = true;
            updateSwStatusUi();
          });
        })
        .catch(() => {
          updateSwStatusUi();
        });
      let refreshingFromSw = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        state.swActive = true;
        updateSwStatusUi();
        if (!refreshingFromSw) {
          refreshingFromSw = true;
          window.location.reload();
        }
      });
    }
    // Comprobar versión e IP LAN del servidor en segundo plano
    nativeFetch("/api/ping", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.version) {
          syncAppVersionBadges(d.version);
        }
        if (d && d.lan_url) {
          const ipInput = document.getElementById("offline-server-url-input");
          if (ipInput) {
            ipInput.placeholder = `Ej: ${d.lan_url}`;
          }
          const scanStatus = document.getElementById("server-scan-status");
          if (scanStatus && !scanStatus.textContent.trim()) {
            scanStatus.textContent = `IP Wi-Fi de este PC: ${d.lan_url}`;
          }
        }
      })
      .catch(() => {});
  }

  async function init() {
    loadAppearancePrefs();
    bindEvents();
    setupMediaSessionHandlers();
    registerServiceWorker();
    await Promise.all([fetchVoices(), fetchLibrary()]);
    refreshExportsStatus().catch(() => {});
    fetchReadingAnalytics().catch(() => {});
    checkTtsEngineUpdates({ force: false, notifyToast: true }).catch(() => {});
  }

  init();
})();
