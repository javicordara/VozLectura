import hashlib
import inspect
import io
import json
import logging
import os
import subprocess
import threading
import time
import urllib.request
import wave
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger("vozlectura.engine")

# Auto-add local portable ./bin (ffmpeg / espeak-ng) when bundled cleanly
_BASE_DIR = Path(__file__).resolve().parent.parent
_LOCAL_BIN_DIR = _BASE_DIR / "bin"
if _LOCAL_BIN_DIR.exists() and _LOCAL_BIN_DIR.is_dir():
    _current_path = os.environ.get("PATH", "")
    _local_bin_str = str(_LOCAL_BIN_DIR)
    if _local_bin_str not in _current_path.split(os.pathsep):
        os.environ["PATH"] = _local_bin_str + os.pathsep + _current_path

PIPER_HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0"
KOKORO_RELEASE_BASE = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
)

# Catálogo de voces locales con licencia comercial permisiva (Piper MIT + Kokoro 82M Apache 2.0)
VOICES_CATALOG: Dict[str, Dict[str, Any]] = {
    # --- PIPER TTS (MIT): Español (España) ---
    "piper:es_ES-davefx-medium": {
        "id": "piper:es_ES-davefx-medium",
        "engine": "piper",
        "voice_key": "es_ES-davefx-medium",
        "speaker_id": None,
        "name": "DaveFX (España - Masculina)",
        "language": "es-ES",
        "gender": "Masculina",
        "description": "Voz masculina local con acento castellano de España (rápida en CPU)",
        "onnx_url": f"{PIPER_HF_BASE}/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx",
        "json_url": f"{PIPER_HF_BASE}/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx.json",
    },
    "piper:es_ES-sharvard-medium:0": {
        "id": "piper:es_ES-sharvard-medium:0",
        "engine": "piper",
        "voice_key": "es_ES-sharvard-medium",
        "speaker_id": 0,
        "name": "Sharvard Ricardo (España - Masculina)",
        "language": "es-ES",
        "gender": "Masculina",
        "description": "Locutor masculino en castellano de España (corpus Sharvard, locutor 0)",
        "onnx_url": f"{PIPER_HF_BASE}/es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx",
        "json_url": f"{PIPER_HF_BASE}/es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx.json",
    },
    "piper:es_ES-sharvard-medium:1": {
        "id": "piper:es_ES-sharvard-medium:1",
        "engine": "piper",
        "voice_key": "es_ES-sharvard-medium",
        "speaker_id": 1,
        "name": "Sharvard Silvia (España - Femenina)",
        "language": "es-ES",
        "gender": "Femenina",
        "description": "Locutora femenina en castellano de España (corpus Sharvard, locutor 1)",
        "onnx_url": f"{PIPER_HF_BASE}/es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx",
        "json_url": f"{PIPER_HF_BASE}/es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx.json",
    },
    "piper:es_ES-mls_9972-low": {
        "id": "piper:es_ES-mls_9972-low",
        "engine": "piper",
        "voice_key": "es_ES-mls_9972-low",
        "speaker_id": None,
        "name": "MLS 9972 (España - Narradora)",
        "language": "es-ES",
        "gender": "Femenina",
        "description": "Voz de audiolibro en castellano de España (Multilingual LibriSpeech)",
        "onnx_url": f"{PIPER_HF_BASE}/es/es_ES/mls_9972/low/es_ES-mls_9972-low.onnx",
        "json_url": f"{PIPER_HF_BASE}/es/es_ES/mls_9972/low/es_ES-mls_9972-low.onnx.json",
    },
    "piper:es_ES-mls_10246-low": {
        "id": "piper:es_ES-mls_10246-low",
        "engine": "piper",
        "voice_key": "es_ES-mls_10246-low",
        "speaker_id": None,
        "name": "MLS 10246 (España - Narrador)",
        "language": "es-ES",
        "gender": "Masculina",
        "description": "Voz masculina de audiolibro en castellano de España (LibriSpeech)",
        "onnx_url": f"{PIPER_HF_BASE}/es/es_ES/mls_10246/low/es_ES-mls_10246-low.onnx",
        "json_url": f"{PIPER_HF_BASE}/es/es_ES/mls_10246/low/es_ES-mls_10246-low.onnx.json",
    },
    "piper:es_ES-carlfm-x_low": {
        "id": "piper:es_ES-carlfm-x_low",
        "engine": "piper",
        "voice_key": "es_ES-carlfm-x_low",
        "speaker_id": None,
        "name": "CarlFM (España - Ultraligera)",
        "language": "es-ES",
        "gender": "Masculina",
        "description": "Voz ultraligera en castellano de España para bajo consumo",
        "onnx_url": f"{PIPER_HF_BASE}/es/es_ES/carlfm/x_low/es_ES-carlfm-x_low.onnx",
        "json_url": f"{PIPER_HF_BASE}/es/es_ES/carlfm/x_low/es_ES-carlfm-x_low.onnx.json",
    },
    # --- PIPER TTS (MIT): Inglés ---
    "piper:en_GB-cori-medium": {
        "id": "piper:en_GB-cori-medium",
        "engine": "piper",
        "voice_key": "en_GB-cori-medium",
        "speaker_id": None,
        "name": "Cori (Inglés UK - Femenina)",
        "language": "en-GB",
        "gender": "Femenina",
        "description": "Voz femenina expresiva en inglés británico",
        "onnx_url": f"{PIPER_HF_BASE}/en/en_GB/cori/medium/en_GB-cori-medium.onnx",
        "json_url": f"{PIPER_HF_BASE}/en/en_GB/cori/medium/en_GB-cori-medium.onnx.json",
    },
    "piper:en_US-lessac-medium": {
        "id": "piper:en_US-lessac-medium",
        "engine": "piper",
        "voice_key": "en_US-lessac-medium",
        "speaker_id": None,
        "name": "Lessac (Inglés US - Narradora)",
        "language": "en-US",
        "gender": "Femenina",
        "description": "Voz narradora de audiolibros muy popular en inglés americano",
        "onnx_url": f"{PIPER_HF_BASE}/en/en_US/lessac/medium/en_US-lessac-medium.onnx",
        "json_url": f"{PIPER_HF_BASE}/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json",
    },
    "piper:en_US-amy-medium": {
        "id": "piper:en_US-amy-medium",
        "engine": "piper",
        "voice_key": "en_US-amy-medium",
        "speaker_id": None,
        "name": "Amy (Inglés US - Femenina)",
        "language": "en-US",
        "gender": "Femenina",
        "description": "Voz clara y cálida en inglés americano",
        "onnx_url": f"{PIPER_HF_BASE}/en/en_US/amy/medium/en_US-amy-medium.onnx",
        "json_url": f"{PIPER_HF_BASE}/en/en_US/amy/medium/en_US-amy-medium.onnx.json",
    },
    # --- KOKORO TTS 82M (Apache 2.0): Español (Neutro / Hispanoamérica) ---
    "kokoro:ef_dora": {
        "id": "kokoro:ef_dora",
        "engine": "kokoro",
        "voice_key": "ef_dora",
        "name": "Dora (Kokoro Español Neutro - Femenina)",
        "language": "es-ES",
        "kokoro_lang": "es",
        "gender": "Femenina",
        "description": "Voz neuronal Kokoro 82M (entrenada en español neutro/latino)",
    },
    "kokoro:em_alex": {
        "id": "kokoro:em_alex",
        "engine": "kokoro",
        "voice_key": "em_alex",
        "name": "Alex (Kokoro Español Neutro - Masculina)",
        "language": "es-ES",
        "kokoro_lang": "es",
        "gender": "Masculina",
        "description": "Voz neuronal Kokoro 82M masculina (entrenada en español neutro/latino)",
    },
    "kokoro:em_santa": {
        "id": "kokoro:em_santa",
        "engine": "kokoro",
        "voice_key": "em_santa",
        "name": "Santa (Kokoro Español Neutro - Grave)",
        "language": "es-ES",
        "kokoro_lang": "es",
        "gender": "Masculina",
        "description": "Voz neuronal Kokoro 82M grave (entrenada en español neutro/latino)",
    },
    # --- KOKORO TTS 82M (Apache 2.0): Inglés ---
    "kokoro:af_heart": {
        "id": "kokoro:af_heart",
        "engine": "kokoro",
        "voice_key": "af_heart",
        "name": "Heart (Kokoro Inglés US - Femenina)",
        "language": "en-US",
        "kokoro_lang": "en-us",
        "gender": "Femenina",
        "description": "Voz insignia de Kokoro 82M en inglés americano, muy expresiva",
    },
    "kokoro:af_bella": {
        "id": "kokoro:af_bella",
        "engine": "kokoro",
        "voice_key": "af_bella",
        "name": "Bella (Kokoro Inglés US - Narradora)",
        "language": "en-US",
        "kokoro_lang": "en-us",
        "gender": "Femenina",
        "description": "Voz suave para lectura prolongada en inglés americano",
    },
    "kokoro:am_michael": {
        "id": "kokoro:am_michael",
        "engine": "kokoro",
        "voice_key": "am_michael",
        "name": "Michael (Kokoro Inglés US - Masculina)",
        "language": "en-US",
        "kokoro_lang": "en-us",
        "gender": "Masculina",
        "description": "Voz masculina natural en inglés americano",
    },
    "kokoro:bf_emma": {
        "id": "kokoro:bf_emma",
        "engine": "kokoro",
        "voice_key": "bf_emma",
        "name": "Emma (Kokoro Inglés UK - Femenina)",
        "language": "en-GB",
        "kokoro_lang": "en-gb",
        "gender": "Femenina",
        "description": "Voz femenina británica de alta fidelidad",
    },
    "kokoro:bm_george": {
        "id": "kokoro:bm_george",
        "engine": "kokoro",
        "voice_key": "bm_george",
        "name": "George (Kokoro Inglés UK - Masculina)",
        "language": "en-GB",
        "kokoro_lang": "en-gb",
        "gender": "Masculina",
        "description": "Voz masculina británica clásica ideal para novela y ensayo",
    },
}


class AudioLRUCache:
    """Caché en memoria para fragmentos WAV generados recientemente."""

    def __init__(self, max_items: int = 200):
        self.max_items = max_items
        self._cache: OrderedDict[str, bytes] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[bytes]:
        with self._lock:
            if key not in self._cache:
                return None
            self._cache.move_to_end(key)
            return self._cache[key]

    def put(self, key: str, data: bytes) -> None:
        with self._lock:
            self._cache[key] = data
            self._cache.move_to_end(key)
            while len(self._cache) > self.max_items:
                self._cache.popitem(last=False)


class TTSEngineManager:
    """Gestor unificado local 100% CPU/ONNX para motores abiertos (Piper MIT y Kokoro 82M Apache 2.0)."""

    def __init__(self, models_dir: Path):
        self.models_dir = models_dir
        self.piper_dir = models_dir / "piper"
        self.kokoro_dir = models_dir / "kokoro"

        for d in (self.piper_dir, self.kokoro_dir):
            d.mkdir(parents=True, exist_ok=True)

        self._piper_instances: Dict[str, Any] = {}
        self._kokoro_instance: Optional[Any] = None

        self._lock = threading.Lock()
        self._updates_lock = threading.Lock()
        self._download_locks: Dict[str, threading.Lock] = {}
        self.updates_cache_file = self.models_dir / "tts_updates_cache.json"
        self.audio_cache = AudioLRUCache(max_items=200)

    def get_gpu_status(self) -> Dict[str, Any]:
        """Devuelve información del motor ONNX Runtime local (ejecución optimizada en CPU)."""
        return {
            "cuda_available": False,
            "device_name": "ONNX Runtime CPU (Kokoro 82M & Piper)",
            "vram_gb": 0,
            "onnx_ready": True,
        }

    def delete_downloaded_voice(self, voice_id: str) -> Tuple[bool, float]:
        """Elimina del disco los archivos descargados de una voz Piper o Kokoro y devuelve (ok, freed_mb)."""
        if voice_id not in VOICES_CATALOG:
            return False, 0.0
        info = VOICES_CATALOG[voice_id]
        engine = info["engine"]

        freed_bytes = 0
        deleted = False

        with self._lock:
            if engine == "piper":
                voice_key = info["voice_key"]
                self._piper_instances.pop(voice_key, None)
                onnx_path = self.piper_dir / f"{voice_key}.onnx"
                json_path = self.piper_dir / f"{voice_key}.onnx.json"
                for path in (onnx_path, json_path):
                    if path.exists():
                        try:
                            freed_bytes += path.stat().st_size
                        except OSError:
                            pass
                        path.unlink(missing_ok=True)
                        deleted = True

            elif engine == "kokoro":
                self._kokoro_instance = None
                onnx_path = self.kokoro_dir / "kokoro-v1.0.onnx"
                voices_path = self.kokoro_dir / "voices-v1.0.bin"
                for path in (onnx_path, voices_path):
                    if path.exists():
                        try:
                            freed_bytes += path.stat().st_size
                        except OSError:
                            pass
                        path.unlink(missing_ok=True)
                        deleted = True

        return deleted, round(freed_bytes / (1024 * 1024), 2)

    def get_all_voices_map(self) -> Dict[str, Dict[str, Any]]:
        return dict(VOICES_CATALOG)

    def list_voices(self) -> List[Dict[str, Any]]:
        """Devuelve el catálogo completo de voces indicando cuáles están ya descargadas."""
        result = []
        kokoro_ready = self._is_kokoro_downloaded()

        for _, info in self.get_all_voices_map().items():
            entry = dict(info)
            eng = info["engine"]
            if eng == "piper":
                entry["downloaded"] = self._is_piper_voice_downloaded(info["voice_key"])
            elif eng == "kokoro":
                entry["downloaded"] = kokoro_ready
            else:
                entry["downloaded"] = False
            result.append(entry)
        return result

    def _is_piper_voice_downloaded(self, voice_key: str) -> bool:
        onnx_file = self.piper_dir / f"{voice_key}.onnx"
        json_file = self.piper_dir / f"{voice_key}.onnx.json"
        return onnx_file.exists() and onnx_file.stat().st_size > 1000 and json_file.exists()

    def _is_kokoro_downloaded(self) -> bool:
        onnx_file = self.kokoro_dir / "kokoro-v1.0.onnx"
        voices_file = self.kokoro_dir / "voices-v1.0.bin"
        return (
            onnx_file.exists()
            and onnx_file.stat().st_size > 1_000_000
            and voices_file.exists()
            and voices_file.stat().st_size > 10_000
        )

    def _download_file(self, url: str, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp_dest = dest.with_suffix(dest.suffix + ".part")
        logger.info("Descargando modelo desde %s -> %s", url, dest)
        req = urllib.request.Request(url, headers={"User-Agent": "VozLectura/1.0"})
        with urllib.request.urlopen(req, timeout=300) as response, open(tmp_dest, "wb") as out_file:
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                out_file.write(chunk)
        tmp_dest.replace(dest)

    def ensure_voice_downloaded(self, voice_id: str) -> Dict[str, Any]:
        """Garantiza que los archivos del motor/voz seleccionado estén listos en disco."""
        all_voices = self.get_all_voices_map()
        if voice_id not in all_voices:
            raise ValueError(f"Voz no reconocida: {voice_id}")

        info = all_voices[voice_id]
        engine = info["engine"]

        with self._lock:
            if voice_id not in self._download_locks:
                self._download_locks[voice_id] = threading.Lock()
            d_lock = self._download_locks[voice_id]

        with d_lock:
            if engine == "piper":
                voice_key = info["voice_key"]
                onnx_path = self.piper_dir / f"{voice_key}.onnx"
                json_path = self.piper_dir / f"{voice_key}.onnx.json"
                if not onnx_path.exists() or onnx_path.stat().st_size < 1000:
                    self._download_file(info["onnx_url"], onnx_path)
                if not json_path.exists():
                    self._download_file(info["json_url"], json_path)
                return {"voice_id": voice_id, "downloaded": True, "engine": "piper"}

            if engine == "kokoro":
                onnx_path = self.kokoro_dir / "kokoro-v1.0.onnx"
                voices_path = self.kokoro_dir / "voices-v1.0.bin"
                if not onnx_path.exists() or onnx_path.stat().st_size < 1_000_000:
                    self._download_file(f"{KOKORO_RELEASE_BASE}/kokoro-v1.0.onnx", onnx_path)
                if not voices_path.exists() or voices_path.stat().st_size < 10_000:
                    self._download_file(f"{KOKORO_RELEASE_BASE}/voices-v1.0.bin", voices_path)
                return {"voice_id": voice_id, "downloaded": True, "engine": "kokoro"}

        raise ValueError(f"Motor no soportado: {engine}")

    def synthesize(self, text: str, voice_id: str, speed: float = 1.0) -> bytes:
        """Sintetiza una oración a audio WAV (bytes) utilizando Piper TTS o Kokoro 82M."""
        clean_text = text.strip()
        if not clean_text:
            return self._generate_silence_wav(100)

        all_voices = self.get_all_voices_map()
        if voice_id not in all_voices:
            voice_id = "piper:es_ES-davefx-medium"

        speed = max(0.5, min(2.2, float(speed)))
        cache_key = hashlib.sha1(f"{voice_id}|{speed:.2f}|{clean_text}".encode("utf-8")).hexdigest()
        cached = self.audio_cache.get(cache_key)
        if cached is not None:
            return cached

        self.ensure_voice_downloaded(voice_id)
        info = all_voices[voice_id]
        engine = info["engine"]

        if engine == "piper":
            wav_bytes = self._synthesize_piper(
                clean_text,
                info["voice_key"],
                speed,
                speaker_id=info.get("speaker_id"),
            )
        elif engine == "kokoro":
            wav_bytes = self._synthesize_kokoro(
                clean_text,
                info["voice_key"],
                info.get("kokoro_lang", "es"),
                speed,
            )
        else:
            raise ValueError(f"Motor no soportado: {engine}")

        self.audio_cache.put(cache_key, wav_bytes)
        return wav_bytes

    def _synthesize_piper(
        self,
        text: str,
        voice_key: str,
        speed: float,
        speaker_id: Optional[int] = None,
    ) -> bytes:
        onnx_path = self.piper_dir / f"{voice_key}.onnx"
        json_path = self.piper_dir / f"{voice_key}.onnx.json"
        length_scale = round(1.0 / speed, 3)

        try:
            from piper.voice import PiperVoice

            with self._lock:
                if voice_key not in self._piper_instances:
                    self._piper_instances[voice_key] = PiperVoice.load(
                        str(onnx_path), config_path=str(json_path)
                    )
                voice = self._piper_instances[voice_key]

            wav_io = io.BytesIO()
            sample_rate = int(getattr(getattr(voice, "config", None), "sample_rate", 22050))

            with wave.open(wav_io, "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(sample_rate)

                if inspect.isgeneratorfunction(voice.synthesize):
                    sig = inspect.signature(voice.synthesize)
                    if "syn_config" in sig.parameters:
                        from piper.config import SynthesisConfig

                        syn_cfg = SynthesisConfig(
                            length_scale=length_scale,
                            speaker_id=speaker_id,
                        )
                        chunks = voice.synthesize(text, syn_config=syn_cfg)
                    else:
                        chunks = voice.synthesize(text)

                    for chunk in chunks:
                        if hasattr(chunk, "audio_int16_bytes"):
                            wav_file.writeframes(chunk.audio_int16_bytes)
                        elif hasattr(chunk, "audio_int16_array"):
                            wav_file.writeframes(chunk.audio_int16_array.tobytes())
                        elif isinstance(chunk, (bytes, bytearray)):
                            wav_file.writeframes(chunk)
                elif hasattr(voice, "synthesize_wav"):
                    sig_wav = inspect.signature(voice.synthesize_wav)
                    kwargs: Dict[str, Any] = {}
                    if "syn_config" in sig_wav.parameters:
                        from piper.config import SynthesisConfig

                        kwargs["syn_config"] = SynthesisConfig(
                            length_scale=length_scale,
                            speaker_id=speaker_id,
                        )
                    if "set_wav_format" in sig_wav.parameters:
                        kwargs["set_wav_format"] = False
                    voice.synthesize_wav(text, wav_file, **kwargs)
                else:
                    sig = inspect.signature(voice.synthesize)
                    if "length_scale" in sig.parameters:
                        voice.synthesize(
                            text,
                            wav_file,
                            length_scale=length_scale,
                            speaker_id=speaker_id,
                        )
                    else:
                        voice.synthesize(text, wav_file)

            return wav_io.getvalue()

        except ImportError:
            logger.warning("Módulo 'piper' no encontrado, intentando binario CLI 'piper'...")
        except Exception as exc:
            logger.error("Error en PiperVoice Python API: %s", exc)
            raise RuntimeError(f"Error al sintetizar con Piper TTS: {exc}") from exc

        cmd = [
            "piper",
            "--model",
            str(onnx_path),
            "--config",
            str(json_path),
            "--length_scale",
            str(length_scale),
            "--output_file",
            "-",
        ]
        if speaker_id is not None:
            cmd.extend(["--speaker", str(speaker_id)])
        proc = subprocess.run(
            cmd,
            input=text.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if proc.returncode != 0 or not proc.stdout:
            err_msg = proc.stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"Fallo al ejecutar Piper CLI: {err_msg}")
        return proc.stdout

    def _synthesize_kokoro(
        self, text: str, voice_key: str, kokoro_lang: str, speed: float
    ) -> bytes:
        onnx_path = self.kokoro_dir / "kokoro-v1.0.onnx"
        voices_path = self.kokoro_dir / "voices-v1.0.bin"

        try:
            from kokoro_onnx import Kokoro

            with self._lock:
                if self._kokoro_instance is None:
                    self._kokoro_instance = Kokoro(str(onnx_path), str(voices_path))
                kokoro = self._kokoro_instance

            samples, sample_rate = kokoro.create(
                text,
                voice=voice_key,
                speed=speed,
                lang=kokoro_lang,
            )
            return self._float_samples_to_wav(samples, sample_rate)
        except ImportError as exc:
            raise RuntimeError(
                "No se encontró 'kokoro-onnx'. Instálalo con: pip install kokoro-onnx"
            ) from exc
        except Exception as exc:
            logger.error("Error al sintetizar con Kokoro ONNX: %s", exc)
            raise RuntimeError(f"Error en Kokoro TTS: {exc}") from exc

    @staticmethod
    def _float_samples_to_wav(samples: np.ndarray, sample_rate: int) -> bytes:
        pcm_int16 = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)
        wav_io = io.BytesIO()
        with wave.open(wav_io, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(int(sample_rate))
            wav_file.writeframes(pcm_int16.tobytes())
        return wav_io.getvalue()

    @staticmethod
    def _generate_silence_wav(duration_ms: int = 100, sample_rate: int = 22050) -> bytes:
        num_samples = int(sample_rate * (duration_ms / 1000.0))
        wav_io = io.BytesIO()
        with wave.open(wav_io, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(b"\x00\x00" * num_samples)
        return wav_io.getvalue()

    @staticmethod
    def _parse_version_key(ver_str: Optional[str]) -> Tuple[Any, ...]:
        """Convierte una versión semántica en clave comparable de forma segura."""
        if not ver_str:
            return ()
        clean = str(ver_str).strip().lstrip("vV")
        try:
            from packaging.version import Version

            return (1, Version(clean))
        except Exception:
            import re

            parts = [int(p) for p in re.findall(r"\d+", clean.split("+")[0])]
            return (0, tuple(parts))

    @classmethod
    def _is_newer_version(cls, installed: Optional[str], latest: Optional[str]) -> bool:
        if not installed or not latest:
            return False
        if str(installed).strip() == str(latest).strip():
            return False
        try:
            k_inst = cls._parse_version_key(installed)
            k_lat = cls._parse_version_key(latest)
            if k_inst and k_lat and k_inst[0] == k_lat[0]:
                return bool(k_lat[1] > k_inst[1])
        except Exception:
            pass
        return False

    def check_engine_updates(self, force: bool = False, cache_ttl_sec: int = 86400) -> Dict[str, Any]:
        """Comprueba si los motores TTS instalados (PyPI) tienen nuevas versiones estables."""
        import importlib.metadata as importlib_metadata

        engines_spec = [
            {
                "id": "piper",
                "name": "Piper TTS",
                "package": "piper-tts",
                "description": "Motor neuronal ultrarrápido offline en CPU",
            },
            {
                "id": "kokoro",
                "name": "Kokoro ONNX",
                "package": "kokoro-onnx",
                "description": "Voces expresivas Kokoro 82M en ONNX",
            },
        ]

        now_ts = int(time.time())
        with self._updates_lock:
            if not force and self.updates_cache_file.exists():
                try:
                    cached = json.loads(self.updates_cache_file.read_text(encoding="utf-8"))
                    checked_at = int(cached.get("checked_at") or 0)
                    allowed_ids = {s["id"] for s in engines_spec}
                    cached_engines = [
                        e for e in (cached.get("engines") or []) if isinstance(e, dict) and e.get("id") in allowed_ids
                    ]
                    if (
                        checked_at > 0
                        and (now_ts - checked_at) < cache_ttl_sec
                        and len(cached_engines) == len(engines_spec)
                    ):
                        cached["engines"] = cached_engines
                        installed_changed = False
                        updates_cnt = 0
                        for eng in cached["engines"]:
                            pkg = eng.get("package", "")
                            try:
                                cur_v = importlib_metadata.version(pkg)
                            except Exception:
                                cur_v = None
                            if cur_v != eng.get("installed_version"):
                                installed_changed = True
                                eng["installed_version"] = cur_v
                                lat_v = eng.get("latest_version")
                                if not cur_v:
                                    eng["has_update"] = False
                                    eng["status"] = "not_installed"
                                elif lat_v:
                                    eng["has_update"] = self._is_newer_version(cur_v, lat_v)
                                    eng["status"] = "update_available" if eng["has_update"] else "up_to_date"
                            if eng.get("has_update"):
                                updates_cnt += 1
                        cached["updates_count"] = updates_cnt
                        cached["has_updates"] = updates_cnt > 0
                        cached["from_cache"] = True
                        if installed_changed:
                            try:
                                self.updates_cache_file.write_text(
                                    json.dumps(cached, ensure_ascii=False, indent=2),
                                    encoding="utf-8",
                                )
                            except Exception:
                                pass
                        return cached
                except Exception:
                    pass

            results: List[Dict[str, Any]] = []
            updates_count = 0
            any_network_ok = False

            for spec in engines_spec:
                pkg = spec["package"]
                try:
                    installed_ver = importlib_metadata.version(pkg)
                except Exception:
                    installed_ver = None

                latest_ver: Optional[str] = None
                release_url = f"https://pypi.org/project/{pkg}/"
                release_date: Optional[str] = None
                err_msg: Optional[str] = None

                try:
                    req = urllib.request.Request(
                        f"https://pypi.org/pypi/{pkg}/json",
                        headers={
                            "User-Agent": "VozLectura-TTS-Updater/1.0",
                            "Accept": "application/json",
                        },
                    )
                    with urllib.request.urlopen(req, timeout=4.5) as resp:
                        payload = json.loads(resp.read().decode("utf-8", errors="ignore"))
                    info = payload.get("info") or {}
                    latest_ver = str(info.get("version") or "").strip() or None
                    if latest_ver:
                        release_url = f"https://pypi.org/project/{pkg}/{latest_ver}/"
                        rels = (payload.get("releases") or {}).get(latest_ver) or []
                        if rels and isinstance(rels[0], dict):
                            upload_iso = str(rels[0].get("upload_time_iso_8601") or rels[0].get("upload_time") or "")
                            if upload_iso:
                                release_date = upload_iso[:10]
                        any_network_ok = True
                except Exception as exc:
                    err_msg = str(exc)

                if not installed_ver:
                    has_upd = False
                    status = "not_installed"
                elif latest_ver:
                    has_upd = self._is_newer_version(installed_ver, latest_ver)
                    status = "update_available" if has_upd else "up_to_date"
                else:
                    has_upd = False
                    status = "error"

                if has_upd:
                    updates_count += 1

                results.append(
                    {
                        "id": spec["id"],
                        "name": spec["name"],
                        "package": pkg,
                        "description": spec["description"],
                        "installed_version": installed_ver,
                        "latest_version": latest_ver,
                        "has_update": has_upd,
                        "status": status,
                        "release_url": release_url,
                        "release_date": release_date,
                        "error": err_msg,
                    }
                )

            out = {
                "checked_at": now_ts,
                "from_cache": False,
                "network_ok": any_network_ok,
                "has_updates": updates_count > 0,
                "updates_count": updates_count,
                "engines": results,
            }
            if any_network_ok:
                try:
                    self.updates_cache_file.write_text(
                        json.dumps(out, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                except Exception as exc:
                    logger.warning("No se pudo guardar caché de actualizaciones TTS: %s", exc)
            return out
