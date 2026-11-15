import hashlib
import html
import io
import json
import logging
import shutil
import subprocess
import threading
import time
import wave
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("vozlectura.exporter")


def get_voice_hash(voice_id: str, speed: float = 1.0) -> str:
    """Genera un identificador seguro de carpeta para una combinación (voz, velocidad)."""
    safe_prefix = "".join(c if c.isalnum() else "_" for c in voice_id)[:28]
    short_hash = hashlib.sha1(f"{voice_id}|{speed:.2f}".encode("utf-8")).hexdigest()[:8]
    return f"{safe_prefix}_{short_hash}"


def format_smil_Clock(seconds: float) -> str:
    """Formatea segundos flotantes como HH:MM:SS.mmm para EPUB 3 SMIL y OPF media:duration."""
    total_ms = int(round(max(0.0, seconds) * 1000))
    ms = total_ms % 1000
    total_sec = total_ms // 1000
    s = total_sec % 60
    total_min = total_sec // 60
    m = total_min % 60
    h = total_min // 60
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def get_wav_info(wav_bytes: bytes) -> Tuple[int, int, int, bytes, float]:
    """
    Extrae (nchannels, sampwidth, framerate, pcm_frames, duration_seconds) de un WAV en memoria.
    """
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        nchannels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        nframes = wf.getnframes()
        pcm_data = wf.readframes(nframes)
    duration = (nframes / float(framerate)) if framerate > 0 else 0.0
    return nchannels, sampwidth, framerate, pcm_data, duration


def normalize_wav_to_24k_mono(wav_bytes: bytes) -> bytes:
    """Garantiza que un WAV sea mono 16-bit 24000Hz para concatenación exacta sin recodificar."""
    try:
        nch, sw, sr, _, _ = get_wav_info(wav_bytes)
        if nch == 1 and sw == 2 and sr == 24000:
            return wav_bytes
    except Exception:
        pass

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "wav",
        "-ac",
        "1",
        "-ar",
        "24000",
        "-sample_fmt",
        "s16",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, input=wav_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode == 0 and len(proc.stdout) > 44:
        return proc.stdout
    return wav_bytes


class BookAudioStore:
    """
    Almacén persistente en disco de frases sintetizadas por (book_id, voice_id, speed)
    y gestor de exportación en segundo plano a M4B y EPUB 3 Media Overlays.
    """

    def __init__(self, books_dir: Path, tts_manager: Any):
        self.books_dir = books_dir
        self.tts_manager = tts_manager
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._cancel_flags: Dict[str, bool] = {}
        self._lock = threading.Lock()
        self._mo_index_cache: Dict[str, Dict[str, Any]] = {}
        self._mo_pcm_cache: Dict[Tuple[str, str], bytes] = {}
        self._wav_count_cache: Dict[Tuple[str, str], Tuple[float, int]] = {}

    def get_sentence_wav_path(
        self, book_id: str, voice_id: str, speed: float, chapter_index: int, sentence_index: int
    ) -> Path:
        vhash = get_voice_hash(voice_id, speed)
        folder = self.books_dir / book_id / "audio_cache" / vhash
        return folder / f"ch{chapter_index:04d}_s{sentence_index:05d}.wav"

    def _slice_embedded_media_overlay_sentence(
        self, book_id: str, chapter_index: int, sentence_index: int
    ) -> Optional[bytes]:
        """
        Recorta en <1 ms el fragmento exacto [clip_begin, clip_end] desde el audio embebido
        de un EPUB 3 Media Overlay sin recalcular ni crear miles de archivos pequeños.
        """
        book_folder = self.books_dir / book_id
        mo_index_path = book_folder / "media_overlay_index.json"
        if not mo_index_path.exists():
            return None

        mo_index = self._mo_index_cache.get(book_id)
        if mo_index is None:
            try:
                mo_index = json.loads(mo_index_path.read_text(encoding="utf-8"))
                self._mo_index_cache[book_id] = mo_index
            except Exception:
                return None

        entry = mo_index.get(f"{chapter_index}:{sentence_index}")
        if not entry:
            return None

        audio_href = entry.get("audio_href")
        if not audio_href:
            return None

        c_begin = float(entry.get("clip_begin", 0.0))
        c_end = float(entry.get("clip_end", 0.0))
        sample_rate = 24000

        cache_key = (book_id, audio_href)
        pcm_data = self._mo_pcm_cache.get(cache_key)
        if pcm_data is None:
            audio_file = book_folder / "media_overlay_audio" / audio_href
            if not audio_file.exists():
                return None
            proc = subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(audio_file),
                    "-f",
                    "s16le",
                    "-ac",
                    "1",
                    "-ar",
                    str(sample_rate),
                    "pipe:1",
                ],
                capture_output=True,
                check=False,
            )
            pcm_data = proc.stdout
            if not pcm_data:
                return None
            # Mantener en RAM las últimas 3 pistas de capítulo decodificadas (~30-80 MB máx)
            if len(self._mo_pcm_cache) >= 3:
                oldest_key = next(iter(self._mo_pcm_cache.keys()))
                self._mo_pcm_cache.pop(oldest_key, None)
            self._mo_pcm_cache[cache_key] = pcm_data

        total_samples = len(pcm_data) // 2
        start_sample = max(0, min(total_samples, int(round(c_begin * sample_rate))))
        if c_end > c_begin:
            end_sample = max(start_sample, min(total_samples, int(round(c_end * sample_rate))))
        else:
            end_sample = min(total_samples, start_sample + int(sample_rate * 2.5))

        slice_bytes = pcm_data[start_sample * 2 : end_sample * 2]
        if len(slice_bytes) < int(sample_rate * 0.04) * 2:
            slice_bytes = b"\x00\x00" * int(sample_rate * 0.08)

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(slice_bytes)
        return buf.getvalue()

    def get_or_synthesize_sentence(
        self,
        book_id: str,
        chapter_index: int,
        sentence_index: int,
        text: str,
        voice_id: str,
        speed: float = 1.0,
    ) -> bytes:
        """
        Si la frase de este libro y voz ya fue codificada previamente, la lee del disco
        en <1 ms sin usar CPU ni GPU. Si no existe, la sintetiza y la guarda en disco.
        """
        if voice_id == "audiobook:original":
            wav_path = self.get_sentence_wav_path(
                book_id, "audiobook:original", 1.0, chapter_index, sentence_index
            )
            if wav_path.exists() and wav_path.stat().st_size > 44:
                return wav_path.read_bytes()
            mo_bytes = self._slice_embedded_media_overlay_sentence(
                book_id, chapter_index, sentence_index
            )
            if mo_bytes:
                return mo_bytes
            # Si aún se está sincronizando este capítulo o es una línea sin locución, devolver silencio breve
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(24000)
                wf.writeframes(b"\x00\x00" * int(24000 * 0.20))
            return buf.getvalue()

        wav_path = self.get_sentence_wav_path(book_id, voice_id, speed, chapter_index, sentence_index)
        if wav_path.exists() and wav_path.stat().st_size > 44:
            return wav_path.read_bytes()

        wav_bytes = self.tts_manager.synthesize(text, voice_id, speed)
        wav_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = wav_path.with_suffix(".wav.tmp")
        tmp_path.write_bytes(wav_bytes)
        tmp_path.replace(wav_path)
        return wav_bytes

    def get_exports_dir(self, book_id: str, voice_id: str, speed: float = 1.0) -> Path:
        vhash = get_voice_hash(voice_id, speed)
        return self.books_dir / book_id / "exports" / vhash

    def _resolve_voice_from_hash(self, vhash: str) -> Tuple[str, str, float]:
        """Intenta identificar (voice_id, voice_name, speed) a partir de un voice_hash cuando no hay export_info.json."""
        if vhash == get_voice_hash("audiobook:original", 1.0) or vhash.startswith("audiobook_original"):
            return "audiobook:original", "🎧 Audiolibro Original (Sincronizado)", 1.0
        try:
            all_voices = self.tts_manager.get_all_voices_map()
            for vid, vinfo in all_voices.items():
                for spd in (1.0, 0.9, 1.15, 1.25, 0.75, 1.5, 1.75, 2.0):
                    if get_voice_hash(vid, spd) == vhash:
                        return vid, vinfo.get("name", vid), spd
        except Exception:
            pass
        return vhash, vhash, 1.0

    def list_book_exports(self, book_id: str) -> Dict[str, Any]:
        """Devuelve las voces ya cacheadas/exportadas para un libro y todos los trabajos activos."""
        book_folder = self.books_dir / book_id
        meta_path = book_folder / "metadata.json"
        total_sentences = 0
        book_title = book_id
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                total_sentences = meta.get("total_sentences", 0)
                book_title = meta.get("title", book_id)
            except Exception:
                pass

        exports_root = book_folder / "exports"
        audio_cache_root = book_folder / "audio_cache"

        voices_status: List[Dict[str, Any]] = []
        seen_hashes = set()

        if exports_root.exists():
            for d in exports_root.iterdir():
                if d.is_dir():
                    seen_hashes.add(d.name)
        if audio_cache_root.exists():
            for d in audio_cache_root.iterdir():
                if d.is_dir():
                    seen_hashes.add(d.name)

        active_job = self._jobs.get(book_id)

        for vhash in sorted(seen_hashes):
            cache_dir = audio_cache_root / vhash
            exp_dir = exports_root / vhash
            info_file = exp_dir / "export_info.json"
            info_data = {}
            if info_file.exists():
                try:
                    info_data = json.loads(info_file.read_text(encoding="utf-8"))
                except Exception:
                    pass

            is_running = bool(
                active_job
                and active_job.get("status") == "running"
                and active_job.get("voice_hash") == vhash
            )

            now_t = time.time()
            ckey = (book_id, vhash)
            cached_entry = self._wav_count_cache.get(ckey)
            ttl = 6.0 if is_running else 45.0
            if cached_entry and (now_t - cached_entry[0]) < ttl:
                cached_count = cached_entry[1]
            elif info_data.get("cached_sentences") and not is_running and not cache_dir.exists():
                cached_count = int(info_data.get("cached_sentences") or 0)
                self._wav_count_cache[ckey] = (now_t, cached_count)
            else:
                cached_count = len(list(cache_dir.glob("ch*_s*.wav"))) if cache_dir.exists() else 0
                self._wav_count_cache[ckey] = (now_t, cached_count)

            if is_running and active_job and active_job.get("processed_sentences"):
                cached_count = max(cached_count, int(active_job.get("processed_sentences") or 0))
            if info_data.get("cached_sentences"):
                cached_count = max(cached_count, int(info_data.get("cached_sentences") or 0))

            vid = info_data.get("voice_id")
            vname = info_data.get("voice_name")
            spd = info_data.get("speed")
            if not vid or not vname:
                r_vid, r_vname, r_spd = self._resolve_voice_from_hash(vhash)
                vid = vid or r_vid
                vname = vname or r_vname
                spd = spd if spd is not None else r_spd

            m4b_file = exp_dir / "audiobook.m4b"
            epub_file = exp_dir / "book_media_overlay.epub"

            voices_status.append(
                {
                    "voice_hash": vhash,
                    "voice_id": vid,
                    "voice_name": vname,
                    "speed": spd,
                    "is_running": is_running,
                    "cached_sentences": cached_count,
                    "total_sentences": total_sentences,
                    "m4b_ready": m4b_file.exists() and m4b_file.stat().st_size > 1000,
                    "m4b_size_mb": round(m4b_file.stat().st_size / (1024 * 1024), 2)
                    if m4b_file.exists()
                    else 0,
                    "epub_overlay_ready": epub_file.exists() and epub_file.stat().st_size > 1000,
                    "epub_size_mb": round(epub_file.stat().st_size / (1024 * 1024), 2)
                    if epub_file.exists()
                    else 0,
                    "m4b_url": f"/api/books/{book_id}/exports/{vhash}/m4b"
                    if m4b_file.exists()
                    else None,
                    "epub_overlay_url": f"/api/books/{book_id}/exports/{vhash}/epub-overlay"
                    if epub_file.exists()
                    else None,
                }
            )

        # Recopilar todas las conversiones activas en cualquier libro del servidor
        all_active_jobs: List[Dict[str, Any]] = []
        for j_book_id, j_info in list(self._jobs.items()):
            if j_info and j_info.get("status") == "running":
                j_copy = dict(j_info)
                if "book_title" not in j_copy:
                    j_meta_path = self.books_dir / j_book_id / "metadata.json"
                    if j_meta_path.exists():
                        try:
                            jm = json.loads(j_meta_path.read_text(encoding="utf-8"))
                            j_copy["book_title"] = jm.get("title", j_book_id)
                        except Exception:
                            j_copy["book_title"] = j_book_id
                    else:
                        j_copy["book_title"] = j_book_id
                all_active_jobs.append(j_copy)

        return {
            "book_id": book_id,
            "book_title": book_title,
            "total_sentences": total_sentences,
            "exports": voices_status,
            "active_job": active_job,
            "all_active_jobs": all_active_jobs,
        }

    def list_all_exports_queue(self) -> Dict[str, Any]:
        """Devuelve la cola global de conversiones (en curso, en pausa/parciales y completadas) de todos los libros."""
        all_items: List[Dict[str, Any]] = []
        active_jobs: List[Dict[str, Any]] = []

        if self.books_dir.exists():
            for book_dir in sorted(self.books_dir.iterdir()):
                if not book_dir.is_dir():
                    continue
                book_id = book_dir.name
                b_data = self.list_book_exports(book_id)
                b_title = b_data.get("book_title", book_id)
                b_total = b_data.get("total_sentences", 0)
                b_job = b_data.get("active_job")

                if b_job and b_job.get("status") == "running":
                    j_copy = dict(b_job)
                    j_copy["book_title"] = b_title
                    active_jobs.append(j_copy)

                for exp in b_data.get("exports", []):
                    item = dict(exp)
                    item["book_id"] = book_id
                    item["book_title"] = b_title
                    item["total_sentences"] = b_total
                    if item.get("is_running") and b_job:
                        item["phase"] = b_job.get("phase", "Codificando...")
                        item["percent"] = b_job.get("percent", 0)
                        item["processed_sentences"] = b_job.get("processed_sentences", item.get("cached_sentences", 0))
                    else:
                        pct = (
                            min(100, round((item.get("cached_sentences", 0) / b_total) * 100))
                            if b_total > 0
                            else 0
                        )
                        item["percent"] = pct
                    all_items.append(item)

        # Ordenar: 1º En ejecución, 2º Parciales/En pausa, 3º Completados
        def sort_key(x: Dict[str, Any]) -> Tuple[int, str, str]:
            if x.get("is_running"):
                prio = 0
            elif not x.get("m4b_ready") and not x.get("epub_overlay_ready"):
                prio = 1
            else:
                prio = 2
            return (prio, str(x.get("book_title", "")).lower(), str(x.get("voice_name", "")).lower())

        all_items.sort(key=sort_key)

        return {
            "active_jobs": active_jobs,
            "items": all_items,
        }

    def delete_book_export(self, book_id: str, voice_hash: str) -> Dict[str, Any]:
        """Cancela si estaba en curso y elimina del disco la conversión y caché de esa voz para el libro."""
        with self._lock:
            job = self._jobs.get(book_id)
            if job and job.get("voice_hash") == voice_hash:
                self._cancel_flags[book_id] = True
                if job.get("status") == "running":
                    job["status"] = "cancelled"
                    job["phase"] = "Cancelado y eliminado por el usuario"
                self._jobs.pop(book_id, None)

        exp_dir = self.books_dir / book_id / "exports" / voice_hash
        cache_dir = self.books_dir / book_id / "audio_cache" / voice_hash

        freed_bytes = 0
        for folder in (exp_dir, cache_dir):
            if folder.exists():
                for f in folder.rglob("*"):
                    if f.is_file():
                        try:
                            freed_bytes += f.stat().st_size
                        except Exception:
                            pass
                shutil.rmtree(folder, ignore_errors=True)

        return {
            "deleted": True,
            "book_id": book_id,
            "voice_hash": voice_hash,
            "freed_mb": round(freed_bytes / (1024 * 1024), 2),
        }

    def start_export_job(
        self,
        book_id: str,
        voice_id: str,
        voice_name: str,
        speed: float = 1.0,
        build_m4b: bool = True,
        build_epub_overlay: bool = True,
    ) -> Dict[str, Any]:
        """Lanza en un hilo de fondo la codificación completa del libro (Caché + M4B + EPUB3 Media Overlay)."""
        with self._lock:
            existing = self._jobs.get(book_id)
            if existing and existing.get("status") == "running":
                return existing

            vhash = get_voice_hash(voice_id, speed)
            job = {
                "book_id": book_id,
                "voice_id": voice_id,
                "voice_name": voice_name,
                "voice_hash": vhash,
                "speed": speed,
                "status": "running",
                "phase": "Iniciando codificación de frases...",
                "processed_sentences": 0,
                "total_sentences": 0,
                "current_chapter": 1,
                "total_chapters": 1,
                "percent": 0.0,
                "error": None,
                "started_at": int(time.time()),
            }
            self._jobs[book_id] = job
            self._cancel_flags[book_id] = False

        t = threading.Thread(
            target=self._run_export_worker,
            args=(book_id, voice_id, voice_name, speed, build_m4b, build_epub_overlay),
            daemon=True,
        )
        t.start()
        return job

    def cancel_export_job(self, book_id: str) -> Dict[str, Any]:
        with self._lock:
            self._cancel_flags[book_id] = True
            job = self._jobs.get(book_id)
            if job and job.get("status") == "running":
                job["phase"] = "Cancelando tras la frase actual..."
            return job or {"status": "idle"}

    def _run_export_worker(
        self,
        book_id: str,
        voice_id: str,
        voice_name: str,
        speed: float,
        build_m4b: bool,
        build_epub_overlay: bool,
    ) -> None:
        job = self._jobs[book_id]
        try:
            book_folder = self.books_dir / book_id
            meta = json.loads((book_folder / "metadata.json").read_text(encoding="utf-8"))
            chapters = json.loads((book_folder / "chapters.json").read_text(encoding="utf-8"))

            total_sentences = sum(len(c.get("sentences", [])) for c in chapters)
            job["total_sentences"] = total_sentences
            job["total_chapters"] = len(chapters)

            vhash = get_voice_hash(voice_id, speed)
            exp_dir = self.get_exports_dir(book_id, voice_id, speed)
            exp_dir.mkdir(parents=True, exist_ok=True)

            (exp_dir / "export_info.json").write_text(
                json.dumps(
                    {
                        "voice_id": voice_id,
                        "voice_name": voice_name,
                        "voice_hash": vhash,
                        "speed": speed,
                        "updated_at": int(time.time()),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )

            # Paso 1: Sintetizar (o recuperar de caché en disco) todas las frases y armar WAV por capítulo con marcas de tiempo
            chapters_audio_meta: List[Dict[str, Any]] = []
            chapters_wav_dir = exp_dir / "chapters_wav"
            chapters_wav_dir.mkdir(parents=True, exist_ok=True)

            processed = 0
            pause_ms = 240
            sample_rate = 24000
            pause_pcm = b"\x00\x00" * int(sample_rate * (pause_ms / 1000.0))
            pause_duration = pause_ms / 1000.0

            for ch_pos, ch in enumerate(chapters):
                if self._cancel_flags.get(book_id):
                    job["status"] = "cancelled"
                    job["phase"] = "Pausado por el usuario (el progreso en caché se ha guardado)"
                    return

                ch_idx = ch["index"]
                ch_title = ch.get("title") or f"Capítulo {ch_idx + 1}"
                job["current_chapter"] = ch_pos + 1
                sentences = ch.get("sentences", [])

                ch_wav_path = chapters_wav_dir / f"ch_{ch_idx:04d}.wav"
                sentence_timings: List[Dict[str, Any]] = []
                cursor_sec = 0.0

                with wave.open(str(ch_wav_path), "wb") as ch_wf:
                    ch_wf.setnchannels(1)
                    ch_wf.setsampwidth(2)
                    ch_wf.setframerate(sample_rate)

                    for s_pos, s_obj in enumerate(sentences):
                        if self._cancel_flags.get(book_id):
                            job["status"] = "cancelled"
                            job["phase"] = "Pausado por el usuario (el progreso en caché se ha guardado)"
                            return

                        s_idx = s_obj["index"]
                        s_text = s_obj["text"]
                        job["phase"] = f"Cap. {ch_pos + 1}/{len(chapters)} — Frase {s_pos + 1}/{len(sentences)}"

                        raw_wav = self.get_or_synthesize_sentence(
                            book_id=book_id,
                            chapter_index=ch_idx,
                            sentence_index=s_idx,
                            text=s_text,
                            voice_id=voice_id,
                            speed=speed,
                        )
                        norm_wav = normalize_wav_to_24k_mono(raw_wav)
                        _, _, _, pcm_data, dur_sec = get_wav_info(norm_wav)

                        start_sec = cursor_sec
                        end_sec = start_sec + dur_sec
                        ch_wf.writeframes(pcm_data)

                        if s_pos < len(sentences) - 1:
                            ch_wf.writeframes(pause_pcm)
                            cursor_sec = end_sec + pause_duration
                        else:
                            cursor_sec = end_sec

                        sentence_timings.append(
                            {
                                "index": s_idx,
                                "text": s_text,
                                "tag": s_obj.get("tag", "p"),
                                "start": start_sec,
                                "end": end_sec,
                            }
                        )

                        processed += 1
                        job["processed_sentences"] = processed
                        job["percent"] = round((processed / max(1, total_sentences)) * 85.0, 1)

                chapters_audio_meta.append(
                    {
                        "index": ch_idx,
                        "title": ch_title,
                        "wav_path": ch_wav_path,
                        "duration": cursor_sec,
                        "timings": sentence_timings,
                    }
                )

            # Paso 2: Empaquetar Audiolibro M4B con índice de capítulos y portada
            if build_m4b:
                job["phase"] = "Empaquetando audiolibro .m4b con índice de capítulos..."
                job["percent"] = 90.0
                m4b_out = exp_dir / "audiobook.m4b"
                self._package_m4b(book_folder, meta, chapters_audio_meta, m4b_out)

            # Paso 3: Empaquetar EPUB 3 con Media Overlays (SMIL sincronizado frase a frase)
            if build_epub_overlay:
                job["phase"] = "Generando EPUB 3 Media Overlay con audio sincronizado (SMIL)..."
                job["percent"] = 95.0
                epub_out = exp_dir / "book_media_overlay.epub"
                self._package_epub3_media_overlay(book_folder, meta, chapters_audio_meta, epub_out)

            # Limpiar WAVs temporales de capítulo (las frases individuales siguen en audio_cache/)
            shutil.rmtree(chapters_wav_dir, ignore_errors=True)

            job["percent"] = 100.0
            job["status"] = "completed"
            job["phase"] = "¡Completado! Caché permanente, M4B y EPUB Media Overlay listos."
        except Exception as exc:
            logger.exception("Error en exportación del libro %s", book_id)
            job["status"] = "error"
            job["error"] = str(exc)
            job["phase"] = f"Error: {exc}"

    def resume_interrupted_jobs(self) -> List[str]:
        """
        Reanuda automáticamente al arrancar el servidor cualquier trabajo de codificación TTS
        que hubiera quedado a medias (carpeta chapters_wav presente sin archivos finales listos).
        """
        resumed: List[str] = []
        if not self.books_dir.exists():
            return resumed
        for book_dir in sorted(self.books_dir.iterdir()):
            if not book_dir.is_dir():
                continue
            book_id = book_dir.name
            exports_root = book_dir / "exports"
            if not exports_root.exists():
                continue
            for exp_dir in sorted(exports_root.iterdir()):
                if not exp_dir.is_dir():
                    continue
                chapters_wav_dir = exp_dir / "chapters_wav"
                info_file = exp_dir / "export_info.json"
                m4b_file = exp_dir / "audiobook.m4b"
                epub_file = exp_dir / "book_media_overlay.epub"
                if chapters_wav_dir.exists() and info_file.exists() and not m4b_file.exists() and not epub_file.exists():
                    try:
                        info_data = json.loads(info_file.read_text(encoding="utf-8"))
                        vid = info_data.get("voice_id")
                        vname = info_data.get("voice_name", vid)
                        spd = float(info_data.get("speed", 1.0))
                        if vid and vid != "audiobook:original":
                            logger.info("Reanudando trabajo de exportación interrumpido para libro %s (%s)", book_id, vname)
                            self.start_export_job(
                                book_id=book_id,
                                voice_id=vid,
                                voice_name=vname,
                                speed=spd,
                                build_m4b=True,
                                build_epub_overlay=True,
                            )
                            resumed.append(book_id)
                            break
                    except Exception as exc:
                        logger.warning("No se pudo reanudar exportación de %s: %s", book_id, exc)
        return resumed

    def start_audiobook_sync_job(
        self,
        book_id: str,
        audio_paths: List[Path],
        voice_name: str = "🎧 Audiolibro Original (Sincronizado)",
        build_m4b: bool = False,
        build_epub_overlay: bool = True,
        on_complete_meta_cb: Optional[Callable[[str, str], None]] = None,
    ) -> Dict[str, Any]:
        """
        Lanza en segundo plano la sincronización acústico-lingüística de un audiolibro externo
        (.mp3, .m4b, .m4a, .wav, .ogg, .flac) con los capítulos y frases del EPUB.
        Genera la caché frase a frase para lectura en vivo en la app y el EPUB 3 Media Overlay (SMIL).
        """
        voice_id = "audiobook:original"
        speed = 1.0
        vhash = get_voice_hash(voice_id, speed)

        with self._lock:
            existing = self._jobs.get(book_id)
            if existing and existing.get("status") == "running":
                self._cancel_flags[book_id] = True

            job = {
                "book_id": book_id,
                "voice_id": voice_id,
                "voice_name": voice_name,
                "voice_hash": vhash,
                "speed": speed,
                "status": "running",
                "phase": "Analizando estructura y pistas del audiolibro...",
                "processed_sentences": 0,
                "total_sentences": 0,
                "current_chapter": 1,
                "total_chapters": 1,
                "percent": 1.0,
                "error": None,
                "started_at": int(time.time()),
            }
            self._jobs[book_id] = job
            self._cancel_flags[book_id] = False

        t = threading.Thread(
            target=self._run_audiobook_sync_worker,
            args=(book_id, audio_paths, voice_id, voice_name, speed, build_m4b, build_epub_overlay, on_complete_meta_cb),
            daemon=True,
        )
        t.start()
        return job

    def _run_audiobook_sync_worker(
        self,
        book_id: str,
        audio_paths: List[Path],
        voice_id: str,
        voice_name: str,
        speed: float,
        build_m4b: bool,
        build_epub_overlay: bool,
        on_complete_meta_cb: Optional[Callable[[str, str], None]] = None,
    ) -> None:
        from backend.audiobook_sync import (
            _natural_sort_key,
            align_chapter_sentences_and_slice,
            build_chapter_wav_from_segments,
            plan_chapter_audio_segments,
            probe_audio_file,
        )

        job = self._jobs[book_id]
        try:
            book_folder = self.books_dir / book_id
            meta_path = book_folder / "metadata.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            chapters = json.loads((book_folder / "chapters.json").read_text(encoding="utf-8"))

            total_sentences = sum(len(c.get("sentences", [])) for c in chapters)
            job["total_sentences"] = total_sentences
            job["total_chapters"] = len(chapters)

            vhash = get_voice_hash(voice_id, speed)
            exp_dir = self.get_exports_dir(book_id, voice_id, speed)
            exp_dir.mkdir(parents=True, exist_ok=True)
            cache_dir = book_folder / "audio_cache" / vhash
            cache_dir.mkdir(parents=True, exist_ok=True)

            (exp_dir / "export_info.json").write_text(
                json.dumps(
                    {
                        "voice_id": voice_id,
                        "voice_name": voice_name,
                        "voice_hash": vhash,
                        "speed": speed,
                        "is_imported_audiobook": True,
                        "updated_at": int(time.time()),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )

            sorted_paths = sorted(audio_paths, key=lambda p: _natural_sort_key(p.name))
            job["phase"] = f"Inspeccionando {len(sorted_paths)} archivo(s) de audio con ffprobe..."
            probed_files = [probe_audio_file(p) for p in sorted_paths]

            job["phase"] = "Emparejando capítulos del EPUB con las pistas/pausas del audiolibro..."
            chapter_plan = plan_chapter_audio_segments(chapters, probed_files)

            chapters_wav_dir = exp_dir / "chapters_wav"
            chapters_wav_dir.mkdir(parents=True, exist_ok=True)

            chapters_audio_meta: List[Dict[str, Any]] = []
            processed = 0

            for ch_pos, ch in enumerate(chapters):
                if self._cancel_flags.get(book_id):
                    job["status"] = "cancelled"
                    job["phase"] = "Sincronización pausada por el usuario"
                    return

                ch_idx = ch["index"]
                ch_title = ch.get("title") or f"Capítulo {ch_idx + 1}"
                sentences = ch.get("sentences", [])
                job["current_chapter"] = ch_pos + 1

                plan_item = chapter_plan[ch_pos] if ch_pos < len(chapter_plan) else {"segments": []}
                segments = plan_item.get("segments", [])

                job["phase"] = f"Decodificando audio Cap. {ch_pos + 1}/{len(chapters)}: {ch_title[:32]}..."
                ch_wav_path = chapters_wav_dir / f"ch_{ch_idx:04d}.wav"
                build_chapter_wav_from_segments(segments, ch_wav_path)

                base_processed = processed

                def _on_sent_progress(done_in_ch: int, total_in_ch: int) -> None:
                    cur = base_processed + done_in_ch
                    job["processed_sentences"] = cur
                    job["percent"] = round((cur / max(1, total_sentences)) * 84.0, 1)
                    job["phase"] = (
                        f"Sincronizando texto y voz: Cap. {ch_pos + 1}/{len(chapters)} "
                        f"— Frase {done_in_ch}/{total_in_ch}"
                    )

                sentence_timings, ch_dur = align_chapter_sentences_and_slice(
                    ch_wav_path=ch_wav_path,
                    sentences=sentences,
                    chapter_index=ch_idx,
                    cache_dir=cache_dir,
                    progress_cb=_on_sent_progress,
                )
                processed = base_processed + len(sentences)
                job["processed_sentences"] = processed
                job["percent"] = round((processed / max(1, total_sentences)) * 84.0, 1)

                chapters_audio_meta.append(
                    {
                        "index": ch_idx,
                        "title": ch_title,
                        "wav_path": ch_wav_path,
                        "duration": ch_dur,
                        "timings": sentence_timings,
                    }
                )

            # Generar EPUB 3 Media Overlay con SMIL sincronizado frase a frase
            if build_epub_overlay:
                job["phase"] = "Generando EPUB 3 Media Overlay con audio sincronizado (SMIL 3.0)..."
                job["percent"] = 90.0
                epub_out = exp_dir / "book_media_overlay.epub"
                self._package_epub3_media_overlay(book_folder, meta, chapters_audio_meta, epub_out)

            # Generar también M4B unificado con índice de capítulos del EPUB
            if build_m4b:
                job["phase"] = "Empaquetando audiolibro .m4b con capítulos sincronizados..."
                job["percent"] = 96.0
                m4b_out = exp_dir / "audiobook.m4b"
                self._package_m4b(book_folder, meta, chapters_audio_meta, m4b_out)

            shutil.rmtree(chapters_wav_dir, ignore_errors=True)
            # Limpiar copias temporales de los audios subidos una vez sincronizados y empaquetados
            raw_upload_dir = book_folder / "imported_audio_raw"
            if raw_upload_dir.exists():
                shutil.rmtree(raw_upload_dir, ignore_errors=True)

            # Marcar el libro como dotado de audiolibro original sincronizado
            meta["has_imported_audiobook"] = True
            meta["imported_audiobook_name"] = voice_name
            meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            if on_complete_meta_cb:
                try:
                    on_complete_meta_cb(book_id, voice_name)
                except Exception:
                    pass

            job["percent"] = 100.0
            job["status"] = "completed"
            job["phase"] = "¡Sincronización completada! Ya puedes leer/escuchar en la app y descargar el EPUB Media Overlay."
        except Exception as exc:
            logger.exception("Error sincronizando audiolibro externo para %s", book_id)
            job["status"] = "error"
            job["error"] = str(exc)
            job["phase"] = f"Error en sincronización: {exc}"

    def _package_m4b(
        self,
        book_folder: Path,
        meta: Dict[str, Any],
        chapters_audio_meta: List[Dict[str, Any]],
        output_m4b: Path,
    ) -> None:
        """Crea un archivo .m4b (AAC en contenedor M4A/M4B) con capítulos FFMETADATA1 y portada."""
        work_dir = output_m4b.parent
        concat_list_path = work_dir / "ffconcat.txt"
        ffmeta_path = work_dir / "ffmetadata.txt"

        concat_lines = []
        for ch in chapters_audio_meta:
            safe_path = str(ch["wav_path"].resolve()).replace("\\", "/")
            concat_lines.append(f"file '{safe_path}'")
        concat_list_path.write_text("\n".join(concat_lines), encoding="utf-8")

        def esc_ffmeta(val: str) -> str:
            return (
                str(val)
                .replace("\\", "\\\\")
                .replace("=", "\\=")
                .replace(";", "\\;")
                .replace("#", "\\#")
                .replace("\n", " ")
            )

        meta_lines = [
            ";FFMETADATA1",
            f"title={esc_ffmeta(meta.get('title', 'Audiolibro'))}",
            f"artist={esc_ffmeta(meta.get('author', 'Autor'))}",
            f"album={esc_ffmeta(meta.get('title', 'Audiolibro'))}",
            "genre=Audiobook",
            "",
        ]

        cursor_ms = 0
        for ch in chapters_audio_meta:
            dur_ms = max(1, int(round(ch["duration"] * 1000)))
            start_ms = cursor_ms
            end_ms = start_ms + dur_ms
            cursor_ms = end_ms
            meta_lines.extend(
                [
                    "[CHAPTER]",
                    "TIMEBASE=1/1000",
                    f"START={start_ms}",
                    f"END={end_ms}",
                    f"title={esc_ffmeta(ch['title'])}",
                    "",
                ]
            )
        ffmeta_path.write_text("\n".join(meta_lines), encoding="utf-8")

        # Buscar portada si existe
        cover_file: Optional[Path] = None
        for p in book_folder.glob("cover.*"):
            cover_file = p
            break

        tmp_m4b = output_m4b.with_suffix(".tmp.m4b")
        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list_path),
            "-i",
            str(ffmeta_path),
        ]
        if cover_file and cover_file.exists():
            cmd.extend(["-i", str(cover_file)])
            cmd.extend(
                [
                    "-map",
                    "0:a",
                    "-map_metadata",
                    "1",
                    "-map_chapters",
                    "1",
                    "-map",
                    "2:v",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-c:v",
                    "copy",
                    "-disposition:v:0",
                    "attached_pic",
                    "-movflags",
                    "+faststart",
                    "-f",
                    "ipod",
                    str(tmp_m4b),
                ]
            )
        else:
            cmd.extend(
                [
                    "-map",
                    "0:a",
                    "-map_metadata",
                    "1",
                    "-map_chapters",
                    "1",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-movflags",
                    "+faststart",
                    "-f",
                    "ipod",
                    str(tmp_m4b),
                ]
            )

        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        concat_list_path.unlink(missing_ok=True)
        ffmeta_path.unlink(missing_ok=True)

        if proc.returncode != 0 or not tmp_m4b.exists():
            err = proc.stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"Error generando archivo M4B con ffmpeg: {err}")

        tmp_m4b.replace(output_m4b)

    def _package_epub3_media_overlay(
        self,
        book_folder: Path,
        meta: Dict[str, Any],
        chapters_audio_meta: List[Dict[str, Any]],
        output_epub: Path,
    ) -> None:
        """
        Genera un archivo EPUB 3.0 estándar con Media Overlays (SMIL 3.0) donde cada frase
        está vinculada a su intervalo exacto (clipBegin / clipEnd) en el MP3 del capítulo.
        """
        title = html.escape(meta.get("title", "Libro"))
        author = html.escape(meta.get("author", "Autor"))
        lang = html.escape(meta.get("language", "es-ES"))
        book_uid = f"vozlectura-mo-{meta.get('id', 'book')}"

        tmp_epub = output_epub.with_suffix(".tmp.epub")

        with zipfile.ZipFile(tmp_epub, "w", zipfile.ZIP_DEFLATED) as zf:
            # 1. mimetype sin comprimir como primer archivo del EPUB
            zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)

            # 2. META-INF/container.xml
            zf.writestr(
                "META-INF/container.xml",
                """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>""",
            )

            # 3. Hoja de estilo con la clase activa de Media Overlay
            zf.writestr(
                "OEBPS/styles.css",
                """body {
  font-family: Georgia, serif;
  line-height: 1.7;
  margin: 5%;
}
h1, h2, h3 {
  line-height: 1.3;
  margin-top: 1.2em;
}
p {
  margin-bottom: 1em;
  text-align: justify;
}
.-epub-media-overlay-active {
  background-color: #fde68a !important;
  color: #1c1917 !important;
  border-radius: 3px;
}
""",
            )

            manifest_items = [
                '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
                '<item id="css" href="styles.css" media-type="text/css"/>',
            ]
            spine_items = []
            duration_metas = []
            nav_links = []
            total_book_duration = 0.0

            # Portada opcional
            for p in book_folder.glob("cover.*"):
                ext = p.suffix.lower()
                mtype = "image/png" if ext == ".png" else "image/jpeg"
                zf.write(p, f"OEBPS/cover{ext}")
                manifest_items.append(
                    f'<item id="cover-img" href="cover{ext}" media-type="{mtype}" properties="cover-image"/>'
                )
                break

            for ch in chapters_audio_meta:
                ch_idx = ch["index"]
                ch_title = html.escape(ch["title"])
                ch_dur = ch["duration"]
                total_book_duration += ch_dur

                xhtml_name = f"ch_{ch_idx:04d}.xhtml"
                smil_name = f"ch_{ch_idx:04d}.smil"
                mp3_rel = f"audio/ch_{ch_idx:04d}.mp3"

                # Codificar el WAV del capítulo a MP3 de alta fidelidad (128kbps mono 24kHz)
                cmd = [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(ch["wav_path"]),
                    "-f",
                    "mp3",
                    "-ac",
                    "1",
                    "-ar",
                    "24000",
                    "-b:a",
                    "128k",
                    "pipe:1",
                ]
                proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
                if proc.returncode != 0 or not proc.stdout:
                    raise RuntimeError(
                        f"Error convirtiendo capítulo {ch_idx} a MP3 para EPUB Media Overlay"
                    )
                zf.writestr(f"OEBPS/{mp3_rel}", proc.stdout)

                # Construir XHTML y SMIL sincronizados frase por frase
                body_paragraphs: List[str] = [f"<h1>{ch_title}</h1>"]
                smil_pars: List[str] = []

                for t_item in ch["timings"]:
                    s_id = f"s_{t_item['index']}"
                    s_text = html.escape(t_item["text"])
                    tag = t_item.get("tag", "p")
                    if tag not in ("h1", "h2", "h3", "blockquote", "li", "p"):
                        tag = "p"
                    if tag == "li":
                        body_paragraphs.append(f'<p><span id="{s_id}">• {s_text}</span></p>')
                    else:
                        body_paragraphs.append(f'<{tag}><span id="{s_id}">{s_text}</span></{tag}>')

                    c_begin = format_smil_Clock(t_item["start"])
                    c_end = format_smil_Clock(t_item["end"])
                    smil_pars.append(
                        f"""      <par id="par_{s_id}">
        <text src="{xhtml_name}#{s_id}"/>
        <audio src="{mp3_rel}" clipBegin="{c_begin}" clipEnd="{c_end}"/>
      </par>"""
                    )

                xhtml_content = f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="{lang}">
<head>
  <meta charset="utf-8"/>
  <title>{ch_title}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <section epub:type="bodymatter chapter">
    {"".join(body_paragraphs)}
  </section>
</body>
</html>"""
                zf.writestr(f"OEBPS/{xhtml_name}", xhtml_content)

                smil_content = f"""<?xml version="1.0" encoding="utf-8"?>
<smil xmlns="http://www.w3.org/ns/SMIL" xmlns:epub="http://www.idpf.org/2007/ops" version="3.0">
  <body>
    <seq id="seq_{ch_idx}" epub:textref="{xhtml_name}" epub:type="bodymatter chapter">
{chr(10).join(smil_pars)}
    </seq>
  </body>
</smil>"""
                zf.writestr(f"OEBPS/{smil_name}", smil_content)

                manifest_items.append(
                    f'<item id="ch_{ch_idx}" href="{xhtml_name}" media-type="application/xhtml+xml" media-overlay="smil_{ch_idx}"/>'
                )
                manifest_items.append(
                    f'<item id="smil_{ch_idx}" href="{smil_name}" media-type="application/smil+xml"/>'
                )
                manifest_items.append(
                    f'<item id="aud_{ch_idx}" href="{mp3_rel}" media-type="audio/mpeg"/>'
                )
                spine_items.append(f'<itemref idref="ch_{ch_idx}"/>')
                duration_metas.append(
                    f'<meta property="media:duration" refines="#smil_{ch_idx}">{format_smil_Clock(ch_dur)}</meta>'
                )
                nav_links.append(f'<li><a href="{xhtml_name}">{ch_title}</a></li>')

            # 4. Documento de navegación EPUB 3 (nav.xhtml)
            nav_xhtml = f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="{lang}">
<head>
  <meta charset="utf-8"/>
  <title>Índice — {title}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>{title}</h1>
    <ol>
      {"".join(nav_links)}
    </ol>
  </nav>
</body>
</html>"""
            zf.writestr("OEBPS/nav.xhtml", nav_xhtml)

            # 5. Package Document OPF 3.0 con metadatos Media Overlay
            modified_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            opf_content = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" prefix="media: http://www.idpf.org/epub/vocab/overlays/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">{book_uid}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:language>{lang}</dc:language>
    <meta property="dcterms:modified">{modified_iso}</meta>
    <meta property="media:active-class">-epub-media-overlay-active</meta>
    <meta property="media:duration">{format_smil_Clock(total_book_duration)}</meta>
    {chr(10).join("    " + m for m in duration_metas)}
  </metadata>
  <manifest>
    {chr(10).join("    " + it for it in manifest_items)}
  </manifest>
  <spine>
    {chr(10).join("    " + sp for sp in spine_items)}
  </spine>
</package>"""
            zf.writestr("OEBPS/content.opf", opf_content)

        tmp_epub.replace(output_epub)
