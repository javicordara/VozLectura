import io
import json
import logging
import math
import re
import subprocess
import wave
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger("epub_tts.audiobook_sync")

SAMPLE_RATE = 24000


def _natural_sort_key(s: str) -> List[Any]:
    return [
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", str(s))
    ]


def probe_audio_file(audio_path: Path) -> Dict[str, Any]:
    """
    Ejecuta ffprobe sobre un archivo de audio (.m4b, .m4a, .mp3, .wav, .ogg, .flac)
    y devuelve su duración total en segundos y la lista de capítulos incrustados si existen.
    """
    cmd = [
        "ffprobe",
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_chapters",
        str(audio_path),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError(f"No se pudo analizar el archivo de audio {audio_path.name} con ffprobe")

    info = json.loads(proc.stdout.decode("utf-8", errors="replace"))
    fmt = info.get("format") or {}
    duration = float(fmt.get("duration") or 0.0)

    raw_chapters = info.get("chapters") or []
    chapters: List[Dict[str, Any]] = []
    for idx, ch in enumerate(raw_chapters):
        start_t = float(ch.get("start_time") or 0.0)
        end_t = float(ch.get("end_time") or duration)
        if end_t <= start_t + 0.2:
            continue
        tags = ch.get("tags") or {}
        title = str(tags.get("title") or tags.get("TITLE") or f"Capítulo {idx + 1}").strip()
        chapters.append(
            {
                "index": idx,
                "start": start_t,
                "end": end_t,
                "duration": end_t - start_t,
                "title": title,
            }
        )

    return {
        "path": audio_path,
        "filename": audio_path.name,
        "duration": duration,
        "chapters": chapters,
    }


def extract_wav_segment(
    audio_path: Path,
    output_wav: Path,
    start_sec: Optional[float] = None,
    end_sec: Optional[float] = None,
) -> float:
    """
    Extrae un fragmento (o el archivo completo) de un audio a WAV PCM 16-bit mono 24000 Hz
    y devuelve su duración exacta en segundos.
    """
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
    ]
    if start_sec is not None and start_sec > 0.0:
        cmd.extend(["-ss", f"{start_sec:.3f}"])
    if end_sec is not None and end_sec > 0.0:
        if start_sec is not None and start_sec > 0.0:
            cmd.extend(["-t", f"{max(0.1, end_sec - start_sec):.3f}"])
        else:
            cmd.extend(["-to", f"{end_sec:.3f}"])

    cmd.extend(
        [
            "-i",
            str(audio_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-sample_fmt",
            "s16",
            "-f",
            "wav",
            str(output_wav),
        ]
    )
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0 or not output_wav.exists():
        err = proc.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"Error decodificando audio con ffmpeg: {err}")

    with wave.open(str(output_wav), "rb") as wf:
        nframes = wf.getnframes()
        sr = wf.getframerate() or SAMPLE_RATE
        return nframes / float(sr)


def compute_sentence_spoken_weight(text: str) -> float:
    """
    Estima el peso fonético/prosódico relativo de una frase hablada en español o inglés:
    - Sílabas/caracteres alfabéticos
    - Expansión de cifras numéricas (los números se pronuncian con varias sílabas)
    - Pausas prosódicas internas (, ; : —) y de final de frase (. ? ! …)
    """
    clean = (text or "").strip()
    if not clean:
        return 1.0

    alpha_count = sum(1 for c in clean if c.isalpha())
    digit_groups = re.findall(r"\d+", clean)
    digit_weight = sum(max(4, len(g) * 5) for g in digit_groups)

    internal_pauses = sum(clean.count(p) for p in (",", ";", ":", "—", "–", "(", ")"))
    terminal_pauses = 1 if clean[-1:] in (".", "?", "!", "…", "»", '"', "'") else 0

    # Peso base en unidades equivalentes a caracteres hablados (~14-16 chars/seg)
    weight = (
        max(3.0, float(alpha_count + digit_weight))
        + internal_pauses * 4.5
        + terminal_pauses * 7.5
    )
    return weight


def compute_chapter_spoken_weight(ch: Dict[str, Any]) -> float:
    sentences = ch.get("sentences") or []
    if not sentences:
        return 0.0
    return sum(compute_sentence_spoken_weight(s.get("text", "")) for s in sentences)


def _normalize_title_tokens(title: str) -> List[str]:
    clean = re.sub(r"[^\w\s]", " ", (title or "").lower())
    stop = {"capítulo", "capitulo", "chapter", "cap", "parte", "part", "track", "pista", "el", "la", "los", "las", "the", "of", "de"}
    return [t for t in clean.split() if t and t not in stop]


def _extract_chapter_number(title: str) -> Optional[int]:
    m = re.search(r"\b(\d{1,3})\b", title or "")
    if m:
        return int(m.group(1))
    roman_map = {
        "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5,
        "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10,
        "xi": 11, "xii": 12, "xiii": 13, "xiv": 14, "xv": 15,
        "xvi": 16, "xvii": 17, "xviii": 18, "xix": 19, "xx": 20,
        "xxi": 21, "xxii": 22, "xxiii": 23, "xxiv": 24, "xxv": 25,
        "xxvi": 26, "xxvii": 27, "xxviii": 28, "xxix": 29, "xxx": 30,
    }
    for tok in re.findall(r"\b([ivxlc]+)\b", (title or "").lower()):
        if tok in roman_map:
            return roman_map[tok]
    return None


def _title_similarity_score(epub_title: str, audio_title: str) -> float:
    """Devuelve una puntuación [0.0, 1.0] de similitud entre el título del capítulo EPUB y la pista de audio."""
    n1 = _extract_chapter_number(epub_title)
    n2 = _extract_chapter_number(audio_title)
    score = 0.0
    if n1 is not None and n2 is not None and n1 == n2:
        score += 0.65

    t1 = set(_normalize_title_tokens(epub_title))
    t2 = set(_normalize_title_tokens(audio_title))
    if t1 and t2:
        overlap = len(t1 & t2) / float(max(len(t1), len(t2)))
        score += 0.55 * overlap
    return min(1.0, score)


def detect_long_pauses_in_audio(
    audio_path: Path, min_silence_sec: float = 1.1, noise_db: float = -36.0
) -> List[Tuple[float, float, float]]:
    """
    Usa el filtro silencedetect de ffmpeg para localizar pausas largas (cambios de capítulo)
    en un archivo de audio único que no tiene marcas de capítulos incrustadas.
    Devuelve lista de (silence_start, silence_end, midpoint).
    """
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i",
        str(audio_path),
        "-af",
        f"silencedetect=noise={noise_db}dB:d={min_silence_sec}",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    stderr_txt = proc.stderr.decode("utf-8", errors="replace")

    starts: List[float] = []
    pauses: List[Tuple[float, float, float]] = []
    for line in stderr_txt.splitlines():
        m_start = re.search(r"silence_start:\s*([0-9.]+)", line)
        if m_start:
            starts.append(float(m_start.group(1)))
            continue
        m_end = re.search(r"silence_end:\s*([0-9.]+)", line)
        if m_end and starts:
            s_start = starts.pop(0)
            s_end = float(m_end.group(1))
            mid = 0.5 * (s_start + s_end)
            pauses.append((s_start, s_end, mid))
    return pauses


def plan_chapter_audio_segments(
    epub_chapters: List[Dict[str, Any]],
    probed_files: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Empareja los capítulos del EPUB con los archivos o capítulos del audiolibro.
    Soporta:
    1. Varios archivos .mp3/.m4a (uno por capítulo o por pistas).
    2. Un único .m4b/.m4a/.mp3 con capítulos incrustados en sus metadatos.
    3. Un único .mp3/.m4b/.m4a continuo sin capítulos incrustados (dividiendo por peso fonético + pausas largas).
    """
    m_epub = len(epub_chapters)
    if m_epub == 0:
        return []

    ch_weights = [compute_chapter_spoken_weight(ch) for ch in epub_chapters]
    total_weight = sum(ch_weights) or 1.0

    # Construir lista plana de segmentos de audio explícitos si existen
    raw_segments: List[Dict[str, Any]] = []
    if len(probed_files) > 1:
        for pf in probed_files:
            if pf["duration"] > 0.5:
                raw_segments.append(
                    {
                        "path": pf["path"],
                        "start": 0.0,
                        "end": pf["duration"],
                        "duration": pf["duration"],
                        "title": Path(pf["filename"]).stem,
                    }
                )
    elif len(probed_files) == 1:
        pf = probed_files[0]
        if len(pf["chapters"]) > 1:
            for ch_meta in pf["chapters"]:
                raw_segments.append(
                    {
                        "path": pf["path"],
                        "start": ch_meta["start"],
                        "end": ch_meta["end"],
                        "duration": ch_meta["duration"],
                        "title": ch_meta["title"],
                    }
                )

    # Caso A: Tenemos segmentos explícitos (pistas MP3 o capítulos M4B)
    if len(raw_segments) > 1:
        k_seg = len(raw_segments)
        # Si coinciden exactamente en número: asignación 1 a 1
        if k_seg == m_epub:
            return [
                {
                    "epub_chapter_index": epub_chapters[i]["index"],
                    "segments": [raw_segments[i]],
                }
                for i in range(m_epub)
            ]

        # Si hay capítulos de portada/créditos muy breves en el EPUB y k_seg coincide con los capítulos sustanciales
        avg_weight = total_weight / float(m_epub)
        substantial_indices = [
            i for i, w in enumerate(ch_weights) if w >= max(180.0, avg_weight * 0.08)
        ]
        if len(substantial_indices) == k_seg:
            plan: List[Dict[str, Any]] = []
            seg_Write_idx = 0
            sub_set = set(substantial_indices)
            for i in range(m_epub):
                if i in sub_set:
                    plan.append(
                        {
                            "epub_chapter_index": epub_chapters[i]["index"],
                            "segments": [raw_segments[seg_Write_idx]],
                        }
                    )
                    seg_Write_idx += 1
                else:
                    plan.append(
                        {
                            "epub_chapter_index": epub_chapters[i]["index"],
                            "segments": [],
                        }
                    )
            return plan

        # Alineación monótona por similitud de título y proporción de duración/peso
        total_audio_dur = sum(s["duration"] for s in raw_segments) or 1.0
        cum_epub = np.cumsum([0.0] + [w / total_weight for w in ch_weights])
        cum_seg = np.cumsum([0.0] + [s["duration"] / total_audio_dur for s in raw_segments])

        if k_seg >= m_epub:
            # Agrupar las k_seg pistas dentro de los m_epub capítulos según sus fronteras acumuladas
            assigned: List[List[Dict[str, Any]]] = [[] for _ in range(m_epub)]
            for s_idx, seg in enumerate(raw_segments):
                seg_mid = 0.5 * (cum_seg[s_idx] + cum_seg[s_idx + 1])
                best_c = int(np.searchsorted(cum_epub[1:], seg_mid, side="right"))
                best_c = min(m_epub - 1, max(0, best_c))
                # Comprobar si un capítulo vecino tiene coincidencia fuerte de título
                best_score = -1e9
                chosen_c = best_c
                for cand_c in range(max(0, best_c - 2), min(m_epub, best_c + 3)):
                    t_sim = _title_similarity_score(epub_chapters[cand_c].get("title", ""), seg["title"])
                    dist_pen = abs(seg_mid - 0.5 * (cum_epub[cand_c] + cum_epub[cand_c + 1]))
                    sc = t_sim * 0.6 - dist_pen
                    if sc > best_score:
                        best_score = sc
                        chosen_c = cand_c
                assigned[chosen_c].append(seg)

            return [
                {
                    "epub_chapter_index": epub_chapters[i]["index"],
                    "segments": assigned[i],
                }
                for i in range(m_epub)
            ]

    # Caso B: Un único archivo de audio continuo (o menos pistas que capítulos) -> dividir proporcionalmente ajustando a pausas largas
    pf = probed_files[0]
    audio_path = pf["path"]
    total_dur = pf["duration"]
    pauses = detect_long_pauses_in_audio(audio_path, min_silence_sec=1.0, noise_db=-35.0)

    cum_weights = np.cumsum([0.0] + ch_weights)
    boundaries = [0.0]
    for i in range(1, m_epub):
        expected_t = (cum_weights[i] / total_weight) * total_dur
        # Buscar la mejor pausa larga en una ventana alrededor de expected_t
        window = max(15.0, min(90.0, total_dur * 0.04))
        best_t = expected_t
        best_score = -1e9
        for s_start, s_end, mid in pauses:
            if abs(mid - expected_t) <= window and mid > boundaries[-1] + 1.5:
                pause_len = min(4.0, s_end - s_start)
                dist_norm = abs(mid - expected_t) / window
                score = pause_len * 1.5 - dist_norm * 2.0
                if score > best_score:
                    best_score = score
                    best_t = mid
        boundaries.append(best_t)
    boundaries.append(total_dur)

    plan_continuous: List[Dict[str, Any]] = []
    for i in range(m_epub):
        st = boundaries[i]
        en = max(st + 0.2, boundaries[i + 1])
        if ch_weights[i] < 10.0 and (en - st) < 1.0:
            plan_continuous.append(
                {"epub_chapter_index": epub_chapters[i]["index"], "segments": []}
            )
        else:
            plan_continuous.append(
                {
                    "epub_chapter_index": epub_chapters[i]["index"],
                    "segments": [
                        {
                            "path": audio_path,
                            "start": st,
                            "end": en,
                            "duration": en - st,
                            "title": epub_chapters[i].get("title") or f"Capítulo {i + 1}",
                        }
                    ],
                }
            )
    return plan_continuous


def build_chapter_wav_from_segments(
    segments: List[Dict[str, Any]], output_wav: Path
) -> float:
    """
    Extrae y concatena uno o varios segmentos de audio en un único archivo WAV 24kHz mono 16-bit
    para el capítulo indicado. Si el capítulo no tiene audio asociado, genera un breve silencio.
    """
    if not segments:
        silence_samples = int(SAMPLE_RATE * 0.25)
        with wave.open(str(output_wav), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(b"\x00\x00" * silence_samples)
        return 0.25

    if len(segments) == 1:
        seg = segments[0]
        return extract_wav_segment(seg["path"], output_wav, seg["start"], seg["end"])

    total_frames = 0
    with wave.open(str(output_wav), "wb") as out_wf:
        out_wf.setnchannels(1)
        out_wf.setsampwidth(2)
        out_wf.setframerate(SAMPLE_RATE)
        for idx, seg in enumerate(segments):
            tmp_seg = output_wav.with_suffix(f".seg{idx}.wav")
            try:
                extract_wav_segment(seg["path"], tmp_seg, seg["start"], seg["end"])
                with wave.open(str(tmp_seg), "rb") as in_wf:
                    n = in_wf.getnframes()
                    out_wf.writeframes(in_wf.readframes(n))
                    total_frames += n
            finally:
                tmp_seg.unlink(missing_ok=True)

    return total_frames / float(SAMPLE_RATE)


def align_chapter_sentences_and_slice(
    ch_wav_path: Path,
    sentences: List[Dict[str, Any]],
    chapter_index: int,
    cache_dir: Path,
    progress_cb: Optional[Callable[[int, int], None]] = None,
) -> Tuple[List[Dict[str, Any]], float]:
    """
    Realiza la alineación forzada acústico-lingüística (Programación Dinámica / Viterbi)
    entre las frases del capítulo (`sentences`) y el audio `ch_wav_path` (24kHz mono 16-bit).
    - Detecta la envolvente de energía RMS cada 10 ms y los valles de silencio/respiración.
    - Optimiza globalmente las fronteras [start_sec, end_sec] de cada frase para que caigan
      exactamente en las pausas del narrador sin cortar palabras a la mitad.
    - Guarda cada frase cortada en `cache_dir/ch{chapter_index:04d}_s{s_idx:05d}.wav`
      con micro-fundido de 6 ms para reproducción fluida frase a frase en la app.
    - Devuelve `(sentence_timings, total_duration_sec)`.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)

    with wave.open(str(ch_wav_path), "rb") as wf:
        sr = wf.getframerate() or SAMPLE_RATE
        nframes = wf.getnframes()
        raw_bytes = wf.readframes(nframes)

    pcm = np.frombuffer(raw_bytes, dtype=np.int16)
    total_samples = len(pcm)
    total_dur = total_samples / float(sr)

    n_sent = len(sentences)
    if n_sent == 0:
        return [], total_dur

    if total_dur < 0.35 or total_samples < sr // 3:
        # Capítulo sin audio hablado (ej. cubierta): asignar intervalos breves y guardar WAV silencioso
        timings: List[Dict[str, Any]] = []
        short_pcm = np.zeros(int(sr * 0.18), dtype=np.int16).tobytes()
        cursor = 0.0
        step = total_dur / float(max(1, n_sent))
        for pos, s_obj in enumerate(sentences):
            s_idx = int(s_obj["index"])
            st = cursor
            en = min(total_dur, cursor + step)
            cursor = en
            wav_out = cache_dir / f"ch{chapter_index:04d}_s{s_idx:05d}.wav"
            _write_mono_wav(wav_out, short_pcm, sr)
            timings.append(
                {
                    "index": s_idx,
                    "text": s_obj.get("text", ""),
                    "tag": s_obj.get("tag", "p"),
                    "start": round(st, 3),
                    "end": round(en, 3),
                }
            )
            if progress_cb:
                progress_cb(pos + 1, n_sent)
        return timings, total_dur

    # 1. Calcular la envolvente de energía RMS en ventanas de 20 ms (480 muestras a 24 kHz)
    hop_sec = 0.020
    hop_samples = max(1, int(round(sr * hop_sec)))
    n_frames = max(1, total_samples // hop_samples)
    trimmed_pcm = pcm[: n_frames * hop_samples].astype(np.float32)
    frames = trimmed_pcm.reshape(n_frames, hop_samples)
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1.0)

    # Suavizado ligero de 3 ventanas (60 ms)
    if n_frames >= 5:
        kernel = np.array([0.25, 0.5, 0.25], dtype=np.float32)
        rms_smooth = np.convolve(rms, kernel, mode="same")
    else:
        rms_smooth = rms

    # Estimar suelo de ruido y nivel de voz activa
    p10 = float(np.percentile(rms_smooth, 10))
    p85 = float(np.percentile(rms_smooth, 85))
    speech_thresh = p10 + 0.12 * max(10.0, p85 - p10)

    # Detectar inicio y fin real de la locución en el capítulo
    voiced_indices = np.where(rms_smooth > speech_thresh)[0]
    if len(voiced_indices) > 0:
        lead_in_frame = max(0, int(voiced_indices[0]) - 6)
        lead_out_frame = min(n_frames - 1, int(voiced_indices[-1]) + 8)
    else:
        lead_in_frame = 0
        lead_out_frame = n_frames - 1

    if lead_out_frame <= lead_in_frame + 5:
        lead_in_frame = 0
        lead_out_frame = n_frames - 1

    # 2. Construir función de coste acústico de frontera P[f] para cada frame de 20 ms
    # Coste bajo (0.0) en silencios/pausas de respiración, coste alto en medio de vocales/palabras
    norm_energy = np.clip(
        (rms_smooth - p10) / max(20.0, p85 - p10), 0.0, 1.5
    )

    # Bonificar pausas sostenidas (media móvil de 140 ms = 7 frames)
    if n_frames >= 9:
        pause_kernel = np.ones(7, dtype=np.float32) / 7.0
        sustained_energy = np.convolve(norm_energy, pause_kernel, mode="same")
    else:
        sustained_energy = norm_energy

    # Coste acústico: muy bajo cuando tanto el frame actual como su entorno son silenciosos
    boundary_cost = 1.8 * norm_energy + 1.2 * sustained_energy
    is_silence = norm_energy < 0.08
    boundary_cost[is_silence] *= 0.15

    # 3. Pesos fonéticos esperados para cada frase
    weights = np.array(
        [compute_sentence_spoken_weight(s.get("text", "")) for s in sentences],
        dtype=np.float64,
    )
    total_w = float(np.sum(weights)) or 1.0
    cum_w = np.concatenate(([0.0], np.cumsum(weights) / total_w))

    active_frames = max(1, lead_out_frame - lead_in_frame)
    expected_frames = lead_in_frame + cum_w * active_frames

    # 4. Alineación global por Programación Dinámica (Viterbi) sobre rejilla de candidatos
    if n_sent == 1:
        opt_frames = [0, n_frames]
    else:
        # Paso de rejilla adaptativo (~40 ms = 2 frames de 20 ms)
        grid_step = 2
        search_radius_frames = max(
            int(12.0 / hop_sec),
            min(int(45.0 / hop_sec), int(active_frames * 0.14)),
        )

        candidates_per_boundary: List[np.ndarray] = []
        for b_idx in range(1, n_sent):
            center = int(round(expected_frames[b_idx]))
            lo = max(lead_in_frame + b_idx, center - search_radius_frames)
            hi = min(lead_out_frame - (n_sent - b_idx), center + search_radius_frames)
            if hi <= lo:
                lo = max(1, min(n_frames - 2, center))
                hi = lo + 1
            grid = np.arange(lo, hi + 1, grid_step, dtype=np.int32)
            # Asegurar que también se incluyan los mínimos locales de energía (pausas exactas)
            window_costs = boundary_cost[lo : hi + 1]
            if len(window_costs) >= 3:
                local_mins = (
                    np.where(
                        (window_costs[1:-1] <= window_costs[:-2])
                        & (window_costs[1:-1] <= window_costs[2:])
                        & (window_costs[1:-1] < 0.45)
                    )[0]
                    + lo
                    + 1
                )
                merged = np.unique(np.concatenate((grid, local_mins)))
            else:
                merged = grid
            candidates_per_boundary.append(merged)

        # Ejecutar DP vectorizado por capas
        dp_costs: List[np.ndarray] = []
        backpointers: List[np.ndarray] = []

        # Primera frontera interna (b_idx = 1, fin de la frase 0)
        c0 = candidates_per_boundary[0]
        exp_dur_0 = max(4.0, expected_frames[1] - expected_frames[0])
        actual_dur_0 = (c0 - lead_in_frame).astype(np.float32)
        dur_err_0 = ((actual_dur_0 - exp_dur_0) / max(12.0, exp_dur_0 * 0.45)) ** 2
        cost_0 = boundary_cost[c0] * 2.2 + dur_err_0 * 1.4
        dp_costs.append(cost_0)
        backpointers.append(np.zeros(len(c0), dtype=np.int32))

        for b_idx in range(2, n_sent):
            prev_cands = candidates_per_boundary[b_idx - 2]
            curr_cands = candidates_per_boundary[b_idx - 1]
            prev_cost = dp_costs[-1]

            exp_dur = max(4.0, expected_frames[b_idx] - expected_frames[b_idx - 1])
            exp_pos = expected_frames[b_idx]
            tol_dur = max(14.0, exp_dur * 0.48)
            tol_pos = max(35.0, search_radius_frames * 0.55)

            curr_cost = np.full(len(curr_cands), 1e12, dtype=np.float32)
            curr_bp = np.zeros(len(curr_cands), dtype=np.int32)

            # Vectorizar sobre prev_cands para cada candidato actual
            for j, cf in enumerate(curr_cands):
                valid_mask = prev_cands < (cf - 1)
                if not np.any(valid_mask):
                    best_i = 0
                    curr_cost[j] = prev_cost[0] + 100.0
                    curr_bp[j] = best_i
                    continue

                valid_indices = np.where(valid_mask)[0]
                durs = (cf - prev_cands[valid_indices]).astype(np.float32)
                trans_cost = ((durs - exp_dur) / tol_dur) ** 2 * 1.35
                total_cand_cost = prev_cost[valid_indices] + trans_cost
                min_rel = int(np.argmin(total_cand_cost))
                best_i = int(valid_indices[min_rel])

                drift_cost = ((float(cf) - exp_pos) / tol_pos) ** 2 * 0.35
                ac_cost = float(boundary_cost[cf]) * 2.4
                curr_cost[j] = float(total_cand_cost[min_rel]) + drift_cost + ac_cost
                curr_bp[j] = best_i

            dp_costs.append(curr_cost)
            backpointers.append(curr_bp)

        # Añadir coste del último tramo (frase n_sent - 1 hasta lead_out_frame)
        last_cands = candidates_per_boundary[-1]
        exp_dur_last = max(4.0, expected_frames[n_sent] - expected_frames[n_sent - 1])
        tol_last = max(14.0, exp_dur_last * 0.5)
        actual_last = (lead_out_frame - last_cands).astype(np.float32)
        final_scores = dp_costs[-1] + ((actual_last - exp_dur_last) / tol_last) ** 2 * 1.2

        best_idx = int(np.argmin(final_scores))
        chosen_internal: List[int] = [0] * (n_sent - 1)
        for layer in range(n_sent - 2, -1, -1):
            chosen_internal[layer] = int(candidates_per_boundary[layer][best_idx])
            best_idx = int(backpointers[layer][best_idx])

        opt_frames = [0] + chosen_internal + [n_frames]

    # 5. Cortar el PCM de cada frase con micro-fundido (fade-in/out de 6 ms) y escribir en audio_cache
    fade_len = min(144, sr // 150)  # ~6 ms a 24 kHz
    fade_in = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)
    fade_out = np.linspace(1.0, 0.0, fade_len, dtype=np.float32)

    sentence_timings: List[Dict[str, Any]] = []
    for pos, s_obj in enumerate(sentences):
        s_idx = int(s_obj["index"])
        f_start = opt_frames[pos]
        f_end = opt_frames[pos + 1]

        sample_start = max(0, min(total_samples - 1, f_start * hop_samples))
        sample_end = (
            total_samples
            if pos == n_sent - 1
            else max(sample_start + int(sr * 0.08), min(total_samples, f_end * hop_samples))
        )

        start_sec = sample_start / float(sr)
        end_sec = sample_end / float(sr)

        slice_pcm = pcm[sample_start:sample_end].copy()
        if len(slice_pcm) > fade_len * 3:
            slice_f = slice_pcm.astype(np.float32)
            slice_f[:fade_len] *= fade_in
            slice_f[-fade_len:] *= fade_out
            slice_pcm = np.clip(slice_f, -32768, 32767).astype(np.int16)

        wav_out = cache_dir / f"ch{chapter_index:04d}_s{s_idx:05d}.wav"
        _write_mono_wav(wav_out, slice_pcm.tobytes(), sr)

        sentence_timings.append(
            {
                "index": s_idx,
                "text": s_obj.get("text", ""),
                "tag": s_obj.get("tag", "p"),
                "start": round(start_sec, 3),
                "end": round(end_sec, 3),
            }
        )

        if progress_cb and ((pos + 1) % 15 == 0 or pos + 1 == n_sent):
            progress_cb(pos + 1, n_sent)

    return sentence_timings, total_dur


def _write_mono_wav(path: Path, pcm_bytes: bytes, sample_rate: int = SAMPLE_RATE) -> None:
    tmp = path.with_suffix(".wav.tmp")
    with wave.open(str(tmp), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    tmp.replace(path)
