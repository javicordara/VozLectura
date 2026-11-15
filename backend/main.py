import asyncio
import base64
import io
import json
import logging
import os
import re
import shutil
import socket
import time
import unicodedata
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.dictionary_service import DictionaryService
from backend.epub_parser import EpubParser
from backend.exporter import BookAudioStore
from backend.study_store import BookStudyStore
from backend.tts_engine import TTSEngineManager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("epub_tts.server")

BASE_DIR = Path(__file__).resolve().parent.parent
_LOCAL_BIN_DIR = BASE_DIR / "bin"
if _LOCAL_BIN_DIR.exists() and _LOCAL_BIN_DIR.is_dir():
    _cur_path = os.environ.get("PATH", "")
    _bin_str = str(_LOCAL_BIN_DIR)
    if _bin_str not in _cur_path.split(os.pathsep):
        os.environ["PATH"] = _bin_str + os.pathsep + _cur_path

_env_data_dir = os.environ.get("VOZLECTURA_DATA_DIR", "").strip()
DATA_DIR = Path(_env_data_dir).expanduser().resolve() if _env_data_dir else (BASE_DIR / "data")
BOOKS_DIR = DATA_DIR / "books"
MODELS_DIR = DATA_DIR / "models"
LIBRARY_FILE = DATA_DIR / "library.json"
FRONTEND_DIR = BASE_DIR / "frontend"

DATA_DIR.mkdir(parents=True, exist_ok=True)
BOOKS_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

epub_parser = EpubParser(books_dir=BOOKS_DIR)
tts_manager = TTSEngineManager(models_dir=MODELS_DIR)
audio_store = BookAudioStore(books_dir=BOOKS_DIR, tts_manager=tts_manager)
dictionary_service = DictionaryService(data_dir=DATA_DIR)
study_store = BookStudyStore(data_dir=DATA_DIR, books_dir=BOOKS_DIR)

app = FastAPI(
    title="VozLectura — EPUB Reader & Offline Neural Audiobooks",
    description="Servidor local de lectura de EPUB con resaltado sincronizado y síntesis de voz neuronal offline (Piper & Kokoro 82M) en español e inglés.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def allow_private_network_cors(request: Request, call_next):
    if request.method == "OPTIONS":
        resp = Response(status_code=204)
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "*"
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        return resp
    response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    if request.url.path in ("/", "/index.html", "/app.js", "/i18n.js", "/styles.css", "/sw.js", "/manifest.json"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


APP_VERSION = "1.0.0"


def _detect_local_lan_ip() -> str:
    """Detecta la IP LAN activa de este equipo para emparejamiento rápido desde el móvil."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(0.25)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass
    finally:
        try:
            sock.close()
        except Exception:
            pass
    try:
        host_ip = socket.gethostbyname(socket.gethostname())
        if host_ip and not host_ip.startswith("127."):
            return host_ip
    except Exception:
        pass
    return "127.0.0.1"


@app.get("/api/ping")
async def ping_server(request: Request) -> Dict[str, Any]:
    port = request.url.port or 8085
    lan_ip = _detect_local_lan_ip()
    return {
        "ok": True,
        "app": "vozlectura",
        "version": APP_VERSION,
        "lan_ip": lan_ip,
        "lan_url": f"http://{lan_ip}:{port}",
        "timestamp": int(time.time()),
    }


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2500)
    voice_id: str = Field(default="piper:es_ES-davefx-medium")
    speed: float = Field(default=1.0, ge=0.5, le=2.2)
    book_id: Optional[str] = None
    chapter_index: Optional[int] = None
    sentence_index: Optional[int] = None


class ExportStartRequest(BaseModel):
    voice_id: str = Field(default="piper:es_ES-davefx-medium")
    speed: float = Field(default=1.0, ge=0.5, le=2.2)
    build_m4b: bool = True
    build_epub_overlay: bool = True


class ProgressUpdate(BaseModel):
    chapter_index: int = Field(default=0, ge=0)
    sentence_index: int = Field(default=0, ge=0)
    voice_id: Optional[str] = None
    speed: Optional[float] = None
    chapter_positions: Optional[Dict[str, int]] = None


class VoiceDownloadRequest(BaseModel):
    voice_id: str


class BookPairingRequest(BaseModel):
    paired_book_id: Optional[str] = None
    auto_switch_chapters: bool = True
    primary_book_id: Optional[str] = None
    chapter_offset: int = 0
    chapter_map: Optional[Dict[str, int]] = None


class DictionaryLookupRequest(BaseModel):
    word: str = Field(..., min_length=1, max_length=120)
    lang: str = Field(default="en")
    sentence: Optional[str] = None


class StudyMetaUpdateRequest(BaseModel):
    reading_status: Optional[str] = None
    started_date: Optional[str] = None
    started_at: Optional[str] = None
    finished_date: Optional[str] = None
    finished_at: Optional[str] = None
    times_read: Optional[int] = None
    rating: Optional[float] = None
    general_notes: Optional[str] = None
    book_notes: Optional[str] = None
    auto_underline_lookups: Optional[bool] = None
    genre: Optional[str] = None
    published_date: Optional[str] = None
    author: Optional[str] = None


class VocabularyAddRequest(BaseModel):
    word: str = Field(..., min_length=1, max_length=120)
    lemma: str = ""
    phonetic: str = ""
    source_lang: str = "en"
    translation: str = ""
    definitions_summary: str = ""
    context_sentence: str = ""
    context_translation: str = ""
    chapter_index: int = 0
    chapter_title: str = ""
    sentence_index: int = 0
    user_note: str = ""
    note: str = ""


class VocabularyNoteUpdateRequest(BaseModel):
    user_note: str = ""
    note: str = ""
    translation: Optional[str] = None


class HighlightAddRequest(BaseModel):
    text: str = ""
    selected_text: str = ""
    note: str = ""
    color: str = "yellow"
    chapter_index: int = 0
    chapter_title: str = ""
    sentence_indices: List[int] = []
    sentence_index: Optional[int] = None


class HighlightUpdateRequest(BaseModel):
    note: Optional[str] = None
    color: Optional[str] = None


class ReadingSessionRequest(BaseModel):
    session_id: Optional[str] = None
    duration_seconds: Optional[float] = None
    duration_minutes: Optional[float] = None
    start_chapter: Optional[int] = None
    end_chapter: Optional[int] = None
    start_chapter_index: Optional[int] = None
    end_chapter_index: Optional[int] = None
    chapter_index: Optional[int] = None
    chapter_title: str = ""
    start_chapter_title: str = ""
    end_chapter_title: str = ""
    sentences_read: int = 0
    note: str = ""
    date: Optional[str] = None
    started_at: Optional[Any] = None
    ended_at: Optional[Any] = None


class ReadingGoalsUpdateRequest(BaseModel):
    daily_minutes_goal: Optional[int] = None
    yearly_books_goal: Optional[int] = None
    yearly_pages_goal: Optional[int] = None


class ObsidianConfigUpdateRequest(BaseModel):
    vault_path: Optional[str] = None
    books_subfolder: Optional[str] = None
    auto_sync: Optional[bool] = None


class ObsidianSyncRequest(BaseModel):
    link_relpath: Optional[str] = None


class ObsidianRawMarkdownRequest(BaseModel):
    markdown: str = ""


def load_library() -> Dict[str, Dict[str, Any]]:
    if not LIBRARY_FILE.exists():
        return {}
    try:
        return json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Error leyendo library.json: %s", exc)
        return {}


def save_library(library: Dict[str, Dict[str, Any]]) -> None:
    payload = json.dumps(library, ensure_ascii=False, indent=2)
    LIBRARY_FILE.write_text(payload, encoding="utf-8")


def build_demo_epub_bytes(lang: str = "es") -> bytes:
    """Genera un archivo EPUB válido en memoria para probar el lector al instante."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>""",
        )

        if lang == "es":
            title = "Don Quijote de la Mancha ( Selección )"
            author = "Miguel de Cervantes"
            lang_code = "es-ES"
            ch1_title = "Capítulo I: Que trata de la condición y ejercicio del famoso hidalgo"
            ch1_html = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="es">
<head><title>Capítulo I</title></head>
<body>
  <h1>Capítulo I: Que trata de la condición y ejercicio del famoso hidalgo</h1>
  <p>En un lugar de la Mancha, de cuyo nombre no quiero acordarme, no ha mucho tiempo que vivía un hidalgo de los de lanza en astillero, adarga antigua, rocín flaco y galgo corredor. Una olla de algo más vaca que carnero, salpicón las más noches, duelos y quebrantos los sábados, lantejas los viernes, algún palomino de añadidura los domingos, consumían las tres partes de su hacienda.</p>
  <p>El resto della concluían sayo de velarte, calzas de velludo para las fiestas, con sus pantuflos de lo mesmo, y los días de entresemana se honraba con su vellorí de lo más fino. Tenía en su casa una ama que pasaba de los cuarenta, y una sobrina que no llegaba a los veinte, y un mozo de campo y plaza, que así ensillaba el rocín como tomaba la podadera.</p>
  <p>Es, pues, de saber que este sobredicho hidalgo, los ratos que estaba ocioso —que eran los más del año—, se daba a leer libros de caballerías con tanta afición y gusto, que olvidó casi de todo punto el ejercicio de la caza, y aun la administración de su hacienda. En resolución, él se enfrascó tanto en su lectura, que se le pasaban las noches leyendo de claro en claro, y los días de turbio en turbio.</p>
</body>
</html>"""
            ch2_title = "Capítulo VIII: Del buen suceso que el valeroso don Quijote tuvo en la espantable aventura de los molinos de viento"
            ch2_html = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="es">
<head><title>Capítulo VIII</title></head>
<body>
  <h1>Capítulo VIII: La aventura de los molinos de viento</h1>
  <p>En esto, descubrieron treinta o cuarenta molinos de viento que hay en aquel campo, y así como don Quijote los vio, dijo a su escudero: «La ventura va guiando nuestras cosas mejor de lo que acertáramos a desear; porque ves allí, amigo Sancho Panza, donde se descubren treinta o pocos más desaforados gigantes, con quien pienso hacer batalla y quitarles a todos las vidas».</p>
  <p>—¿Qué gigantes? —dijo Sancho Panza.</p>
  <p>—Aquellos que allí ves —respondió su amo—, de los brazos largos, que los suelen tener algunos de casi dos leguas.</p>
  <p>—Mire vuestra merced —respondió Sancho— que aquellos que allí se parecen no son gigantes, sino molinos de viento, y lo que en ellos parecen brazos son las aspas, que, volteadas del viento, hacen andar la piedra del molino.</p>
  <p>—Bien parece —respondió don Quijote— que no estás cursado en esto de las aventuras: ellos son gigantes; y si tienes miedo, quítate de ahí, y ponte en oración en el espacio que yo voy a entrar con ellos en fiera y desigual batalla.</p>
</body>
</html>"""
        else:
            title = "The Adventures of Sherlock Holmes (Excerpt)"
            author = "Arthur Conan Doyle"
            lang_code = "en-GB"
            ch1_title = "Chapter I: A Scandal in Bohemia"
            ch1_html = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Chapter I</title></head>
<body>
  <h1>Chapter I: A Scandal in Bohemia</h1>
  <p>To Sherlock Holmes she is always the woman. I have seldom heard him mention her under any other name. In his eyes she eclipses and predominates the whole of her sex. It was not that he felt any emotion akin to love for Irene Adler. All emotions, and that one particularly, were abhorrent to his cold, precise but admirably balanced mind.</p>
  <p>He was, I take it, the most perfect reasoning and observing machine that the world has seen, but as a lover he would have placed himself in a false position. He never spoke of the softer passions, save with a gibe and a sneer. They were admirable things for the observer—excellent for drawing the veil from men's motives and actions.</p>
  <p>One night—it was on the twentieth of March, 1888—I was returning from a journey to a patient, when my way led me through Baker Street. As I passed the well-remembered door, which must always be associated in my mind with my wooing, and with the dark incidents of the Study in Scarlet, I was seized with a keen desire to see Holmes again, and to know how he was employing his extraordinary powers.</p>
</body>
</html>"""
            ch2_title = "Chapter II: Deductions at 221B Baker Street"
            ch2_html = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Chapter II</title></head>
<body>
  <h1>Chapter II: Deductions at 221B Baker Street</h1>
  <p>"You see, but you do not observe. The distinction is clear. For example, you have frequently seen the steps which lead up from the hall to this room."</p>
  <p>"Frequently."</p>
  <p>"How often?"</p>
  <p>"Well, some hundreds of times."</p>
  <p>"Then how many are there?"</p>
  <p>"How many? I don't know."</p>
  <p>"Quite so! You have not observed. And yet you have seen. That is just my point. Now, I know that there are十七 steps, because I have both seen and observed."</p>
</body>
</html>""".replace("十七", "seventeen")

        zf.writestr(
            "OEBPS/content.opf",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:language>{lang_code}</dc:language>
    <dc:identifier id="bookid">demo-{lang}</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>""",
        )
        zf.writestr(
            "OEBPS/toc.ncx",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="navPoint-1" playOrder="1">
      <navLabel><text>{ch1_title}</text></navLabel>
      <content src="ch1.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-2" playOrder="2">
      <navLabel><text>{ch2_title}</text></navLabel>
      <content src="ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>""",
        )
        zf.writestr("OEBPS/ch1.xhtml", ch1_html)
        zf.writestr("OEBPS/ch2.xhtml", ch2_html)

    return buf.getvalue()


DEMO_BOOKS_DIR = BASE_DIR / "backend" / "demo_books"


def _seed_demo_book_entry(fname: str, demo_lang: str) -> Dict[str, Any]:
    """Importa un EPUB demo desde backend/demo_books o usa el extracto integrado como respaldo."""
    demo_path = DEMO_BOOKS_DIR / fname
    if demo_path.exists():
        epub_bytes = demo_path.read_bytes()
    else:
        epub_bytes = build_demo_epub_bytes(demo_lang)
    book_meta = epub_parser.import_epub(epub_bytes, fname)
    default_voice = (
        "piper:es_ES-davefx-medium"
        if book_meta["language"].startswith("es")
        else "piper:en_GB-cori-medium"
    )
    book_meta["progress"] = {
        "chapter_index": 0,
        "sentence_index": 0,
        "voice_id": default_voice,
        "speed": 1.0,
        "updated_at": int(time.time()),
    }
    return book_meta


@app.on_event("startup")
async def seed_demo_books_if_empty() -> None:
    """Siembra los 4 libros de dominio público (Quijote ES/EN y Sherlock ES/EN) ya emparejados si la biblioteca está vacía."""
    library = load_library()
    if not library:
        try:
            demo_pairs = [
                ("en", "quijote_en.epub", "es", "quijote_es.epub"),
                ("en", "sherlock_en.epub", "es", "sherlock_es.epub"),
            ]
            for en_lang, en_fname, es_lang, es_fname in demo_pairs:
                en_meta = _seed_demo_book_entry(en_fname, en_lang)
                es_meta = _seed_demo_book_entry(es_fname, es_lang)
                library[en_meta["id"]] = en_meta
                library[es_meta["id"]] = es_meta
                await asyncio.to_thread(
                    _apply_book_pairing,
                    library,
                    en_meta["id"],
                    es_meta["id"],
                    primary_book_id=en_meta["id"],
                    auto_switch_chapters=True,
                )
            save_library(library)
            logger.info("Libros EPUB de demostración (Quijote ES/EN y Sherlock ES/EN) sembrados y emparejados.")
        except Exception as exc:
            logger.warning("No se pudieron crear los libros de demostración: %s", exc)

    # Autocomprobación rápida de inicio y estado de GPU
    async def _run_selftest() -> None:
        try:
            gpu_info = await asyncio.to_thread(tts_manager.get_gpu_status)
            dict_test = await asyncio.to_thread(
                dictionary_service.lookup,
                "again",
                "en",
                "He looked at his watch again.",
            )
            lib_now = load_library()
            first_book_id = next(iter(lib_now.keys()), None)
            offline_bundle_ok = False
            offline_chapters_len = 0
            if first_book_id:
                b_test = await get_book_offline_bundle(first_book_id)
                offline_chapters_len = len(b_test.get("chapters", []))
                offline_bundle_ok = offline_chapters_len > 0

            (DATA_DIR / "tts_selftest.json").write_text(
                json.dumps(
                    {
                        "ok": True,
                        "gpu": gpu_info,
                        "exporter_ready": audio_store is not None,
                        "offline_bundle_ok": offline_bundle_ok,
                        "offline_chapters_len": offline_chapters_len,
                        "dict_test": dict_test,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        except Exception as exc:
            import traceback

            (DATA_DIR / "tts_selftest.json").write_text(
                json.dumps(
                    {
                        "ok": False,
                        "error": str(exc),
                        "traceback": traceback.format_exc(),
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )

    asyncio.create_task(_run_selftest())
    await asyncio.to_thread(audio_store.resume_interrupted_jobs)


ALLOWED_AUDIOBOOK_EXTS = {".mp3", ".m4b", ".m4a", ".wav", ".ogg", ".flac", ".aac", ".opus", ".mp4"}


def _mark_book_has_imported_audiobook(book_id: str, voice_name: str) -> None:
    library = load_library()
    if book_id in library:
        library[book_id]["has_imported_audiobook"] = True
        library[book_id]["imported_audiobook_name"] = voice_name
        prog = library[book_id].get("progress") or {}
        prog["voice_id"] = "audiobook:original"
        library[book_id]["progress"] = prog
        save_library(library)


async def _save_uploaded_audiobook_and_start_sync(
    book_id: str,
    audio_files: List[UploadFile],
    audiobook_name: Optional[str] = None,
    build_m4b: bool = False,
    build_epub_overlay: bool = True,
) -> Dict[str, Any]:
    raw_dir = BOOKS_DIR / book_id / "imported_audio_raw"
    if raw_dir.exists():
        shutil.rmtree(raw_dir, ignore_errors=True)
    raw_dir.mkdir(parents=True, exist_ok=True)

    saved_paths: List[Path] = []
    for idx, uf in enumerate(audio_files):
        orig_name = uf.filename or f"track_{idx + 1:03d}.mp3"
        ext = Path(orig_name).suffix.lower()
        if ext not in ALLOWED_AUDIOBOOK_EXTS:
            raise HTTPException(
                status_code=400,
                detail=f"Formato de audio no soportado ({orig_name}). Usa .mp3, .m4b, .m4a, .wav, .ogg o .flac.",
            )
        safe_name = f"{idx + 1:03d}_{Path(orig_name).name}"
        dest_path = raw_dir / safe_name
        with dest_path.open("wb") as out_f:
            while True:
                chunk = await uf.read(1024 * 1024)
                if not chunk:
                    break
                out_f.write(chunk)
        if dest_path.stat().st_size > 100:
            saved_paths.append(dest_path)

    if not saved_paths:
        raise HTTPException(status_code=400, detail="No se recibieron archivos de audio válidos.")

    default_label = (
        f"🎧 Audiolibro Original ({Path(audio_files[0].filename or 'Audio').stem[:28]})"
        if len(audio_files) == 1
        else f"🎧 Audiolibro Original ({len(saved_paths)} pistas)"
    )
    effective_label = (audiobook_name or "").strip() or default_label

    _mark_book_has_imported_audiobook(book_id, effective_label)
    meta_path = BOOKS_DIR / book_id / "metadata.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["has_imported_audiobook"] = True
            meta["imported_audiobook_name"] = effective_label
            meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    job = await asyncio.to_thread(
        audio_store.start_audiobook_sync_job,
        book_id=book_id,
        audio_paths=saved_paths,
        voice_name=effective_label,
        build_m4b=build_m4b,
        build_epub_overlay=build_epub_overlay,
        on_complete_meta_cb=_mark_book_has_imported_audiobook,
    )
    return job


def _ensure_completed_book_progress_100(book_id: str, book_entry: Dict[str, Any]) -> bool:
    """Si el libro está marcado como terminado (completed), ajusta su progreso al 100% (última frase del último capítulo)."""
    len_info = study_store._get_or_compute_book_length(book_id, book_entry)
    ch_sents = len_info.get("chapter_sentence_counts") or []
    ch_count = max(1, int(book_entry.get("chapter_count") or len(ch_sents) or 1))
    last_ch_idx = max(0, ch_count - 1)
    if ch_sents and last_ch_idx < len(ch_sents):
        last_sent_idx = max(0, int(ch_sents[last_ch_idx]) - 1)
    else:
        ch_summary = book_entry.get("chapters_summary") or []
        if ch_summary and last_ch_idx < len(ch_summary):
            last_sent_idx = max(0, int(ch_summary[last_ch_idx].get("sentence_count") or 1) - 1)
        else:
            last_sent_idx = max(0, (int(book_entry.get("total_sentences") or 100) // ch_count) - 1)

    prog = dict(book_entry.get("progress") or {})
    if prog.get("chapter_index") != last_ch_idx or prog.get("sentence_index") != last_sent_idx:
        prog["chapter_index"] = last_ch_idx
        prog["sentence_index"] = last_sent_idx
        if not prog.get("updated_at"):
            prog["updated_at"] = int(time.time())
        book_entry["progress"] = prog
        return True
    return False


def _enrich_library_with_catalog_and_study() -> List[Dict[str, Any]]:
    library = load_library()
    dirty_lib = False
    books_out: List[Dict[str, Any]] = []

    for book_id, b in library.items():
        book_dir = BOOKS_DIR / book_id
        epub_path = book_dir / "book.epub"

        # 1. Fecha de adición (added_at)
        if not b.get("added_at"):
            if epub_path.exists():
                try:
                    b["added_at"] = int(epub_path.stat().st_mtime)
                except Exception:
                    b["added_at"] = int(time.time())
            else:
                b["added_at"] = int(b.get("progress", {}).get("updated_at") or time.time())
            dirty_lib = True

        # 2. Extraer géneros (<dc:subject>) y fecha de publicación (<dc:date>) del OPF si no se hizo antes
        if not b.get("_opf_enriched"):
            opf_extra = epub_parser.extract_opf_extended_meta_from_epub_file(epub_path)
            if opf_extra.get("genres") and not b.get("genres"):
                b["genres"] = opf_extra["genres"]
            if opf_extra.get("genre") and not b.get("genre"):
                b["genre"] = opf_extra["genre"]
            if opf_extra.get("published_date") and not b.get("published_date"):
                b["published_date"] = opf_extra["published_date"]
            if opf_extra.get("published_year") and not b.get("published_year"):
                b["published_year"] = opf_extra["published_year"]
            b["_opf_enriched"] = True
            dirty_lib = True

        # 3. Longitud en páginas y palabras
        if not b.get("estimated_pages") or not b.get("total_words"):
            len_info = study_store._get_or_compute_book_length(book_id, b)
            b["total_words"] = len_info.get("total_words", 0)
            b["estimated_pages"] = len_info.get("estimated_pages", 1)
            dirty_lib = True

        # 3b. Auto-generar mapa capítulo a capítulo (chapter_map) si el libro está emparejado y aún no lo tiene
        pairing_obj = b.get("pairing")
        if isinstance(pairing_obj, dict) and pairing_obj.get("paired_book_id") and not pairing_obj.get("chapter_map"):
            partner_id = str(pairing_obj["paired_book_id"])
            if partner_id in library:
                try:
                    align_info = _compute_bilingual_chapter_alignment(book_id, partner_id, library)
                    if align_info.get("chapter_map"):
                        pairing_obj["chapter_map"] = align_info["chapter_map"]
                        partner_pairing = library[partner_id].get("pairing")
                        if isinstance(partner_pairing, dict) and partner_pairing.get("paired_book_id") == book_id:
                            partner_pairing["chapter_map"] = align_info.get("reverse_chapter_map") or {}
                        dirty_lib = True
                except Exception:
                    pass

        # 4. Combinar datos de estudio (estado de lectura, nota/estrellas, género personalizado, fecha publicación)
        study_data = study_store.get_study_data(book_id, sync_obsidian=False)
        if study_data.get("reading_status") == "completed":
            if _ensure_completed_book_progress_100(book_id, b):
                dirty_lib = True
        item = dict(b)
        item["reading_status"] = study_data.get("reading_status") or "reading"
        raw_rating = round(max(0.0, min(5.0, float(study_data.get("rating") or 0.0))) * 2.0) / 2.0
        item["rating"] = int(raw_rating) if raw_rating.is_integer() else raw_rating
        item["times_read"] = int(study_data.get("times_read") or 1)
        item["started_at"] = study_data.get("started_at")
        item["finished_at"] = study_data.get("finished_at")

        if study_data.get("genre"):
            item["genre"] = study_data["genre"]
            genres_list = list(item.get("genres") or [])
            for g_part in [x.strip() for x in study_data["genre"].split(",") if x.strip()]:
                if g_part not in genres_list:
                    genres_list.insert(0, g_part)
            item["genres"] = genres_list
        else:
            item["genre"] = item.get("genre") or (item.get("genres")[0] if item.get("genres") else "")
            item["genres"] = item.get("genres") or ([item["genre"]] if item["genre"] else [])

        if study_data.get("published_date"):
            item["published_date"] = study_data["published_date"]
            p_date, p_yr = epub_parser._parse_opf_publication_date(study_data["published_date"])
            if p_yr:
                item["published_year"] = p_yr

        if study_data.get("author") and study_data["author"] != item.get("author"):
            item["author"] = study_data["author"]

        # 5. Calcular timestamp real de última lectura (last_read_at) para ordenar de menor a mayor tiempo transcurrido
        sessions_list = study_data.get("sessions") or []
        latest_session_ts = max(
            (int(s.get("ended_at") or s.get("started_at") or 0) for s in sessions_list),
            default=0,
        )
        prog_obj = item.get("progress") or {}
        prog_upd = int(prog_obj.get("last_read_at") or prog_obj.get("updated_at") or 0)
        has_started_reading = (
            int(prog_obj.get("chapter_index") or 0) > 0
            or int(prog_obj.get("sentence_index") or 0) > 0
            or latest_session_ts > 0
        )
        if item["reading_status"] == "completed":
            finished_ts = int(study_data.get("finished_at") or 0)
            last_read_at = max(finished_ts, latest_session_ts) if (finished_ts > 0 or latest_session_ts > 0) else prog_upd
            if prog_upd > last_read_at > 0 and isinstance(b.get("progress"), dict):
                b["progress"]["last_read_at"] = last_read_at
                b["progress"]["updated_at"] = last_read_at
                prog_obj["last_read_at"] = last_read_at
                prog_obj["updated_at"] = last_read_at
                dirty_lib = True
        elif has_started_reading:
            last_read_at = max(prog_upd, latest_session_ts)
        else:
            last_read_at = 0

        item["last_read_at"] = last_read_at
        item["updated_at"] = last_read_at

        books_out.append(item)

    if dirty_lib:
        save_library(library)

    # Orden por defecto: de menor a mayor tiempo transcurrido desde la última lectura (el último libro leído siempre el 1º)
    books_out.sort(
        key=lambda x: (
            1 if int(x.get("last_read_at") or 0) > 0 else 0,
            int(x.get("last_read_at") or 0),
            int(x.get("added_at") or 0),
        ),
        reverse=True,
    )
    return books_out


@app.get("/api/books")
async def get_books() -> Dict[str, Any]:
    books_list = await asyncio.to_thread(_enrich_library_with_catalog_and_study)
    return {"books": books_list}


@app.post("/api/books/upload")
async def upload_book(
    file: UploadFile = File(...),
    audio_files: Optional[List[UploadFile]] = File(default=None),
    audiobook_name: Optional[str] = Form(default=None),
    build_m4b: bool = Form(default=False),
    build_epub_overlay: bool = Form(default=True),
) -> Dict[str, Any]:
    filename = file.filename or "libro.epub"
    if not filename.lower().endswith(".epub"):
        raise HTTPException(status_code=400, detail="El archivo debe tener extensión .epub")

    epub_bytes = await file.read()
    if len(epub_bytes) < 100:
        raise HTTPException(status_code=400, detail="El archivo EPUB está vacío o dañado.")

    try:
        book_meta = await asyncio.to_thread(epub_parser.import_epub, epub_bytes, filename)
    except Exception as exc:
        logger.exception("Error al procesar EPUB %s", filename)
        raise HTTPException(
            status_code=422, detail=f"No se pudo analizar el archivo EPUB: {exc}"
        ) from exc

    library = load_library()
    existing_progress = library.get(book_meta["id"], {}).get("progress")
    if book_meta.get("has_embedded_media_overlay"):
        default_voice = "audiobook:original"
    else:
        default_voice = (
            "piper:es_ES-davefx-medium"
            if book_meta["language"].startswith("es")
            else "piper:en_US-lessac-medium"
        )
    if existing_progress and book_meta.get("has_embedded_media_overlay"):
        existing_progress["voice_id"] = "audiobook:original"
    book_meta["progress"] = existing_progress or {
        "chapter_index": 0,
        "sentence_index": 0,
        "voice_id": default_voice,
        "speed": 1.0,
        "updated_at": 0,
        "last_read_at": 0,
    }
    library[book_meta["id"]] = book_meta
    save_library(library)

    # Inicializar cuaderno de lectura, sincronizar nota en Obsidian y extraer mapas/ilustraciones del EPUB automáticamente
    try:
        await asyncio.to_thread(study_store.get_study_data, book_meta["id"])
    except Exception as exc:
        logger.warning("No se pudo inicializar nota/ilustraciones en Obsidian para %s: %s", book_meta["id"], exc)

    sync_job = None
    valid_audio_uploads = [af for af in (audio_files or []) if af and af.filename]
    if valid_audio_uploads:
        sync_job = await _save_uploaded_audiobook_and_start_sync(
            book_id=book_meta["id"],
            audio_files=valid_audio_uploads,
            audiobook_name=audiobook_name,
            build_m4b=build_m4b,
            build_epub_overlay=build_epub_overlay,
        )
        library = load_library()
        book_meta = library.get(book_meta["id"], book_meta)

    return {"book": book_meta, "sync_job": sync_job}


@app.post("/api/books/{book_id}/audiobook/sync")
async def sync_external_audiobook_endpoint(
    book_id: str,
    audio_files: List[UploadFile] = File(...),
    audiobook_name: Optional[str] = Form(default=None),
    build_m4b: bool = Form(default=False),
    build_epub_overlay: bool = Form(default=True),
) -> Dict[str, Any]:
    library = load_library()
    if book_id not in library and not (BOOKS_DIR / book_id / "metadata.json").exists():
        raise HTTPException(status_code=404, detail="Libro no encontrado")

    job = await _save_uploaded_audiobook_and_start_sync(
        book_id=book_id,
        audio_files=audio_files,
        audiobook_name=audiobook_name,
        build_m4b=build_m4b,
        build_epub_overlay=build_epub_overlay,
    )
    library = load_library()
    return {"book": library.get(book_id), "job": job}


@app.delete("/api/books/{book_id}")
async def delete_book(book_id: str) -> Dict[str, Any]:
    library = load_library()
    if book_id in library:
        paired_id = (library[book_id].get("pairing") or {}).get("paired_book_id")
        if paired_id and paired_id in library:
            library[paired_id]["pairing"] = None
        del library[book_id]
        save_library(library)

    book_folder = BOOKS_DIR / book_id
    if book_folder.exists():
        shutil.rmtree(book_folder, ignore_errors=True)

    return {"deleted": book_id}


_ENTITY_STOPWORDS = {
    "the", "and", "that", "this", "with", "from", "have", "what", "when", "where",
    "there", "their", "they", "were", "been", "would", "could", "should", "about",
    "after", "before", "while", "into", "over", "under", "again", "then", "than",
    "some", "more", "most", "other", "such", "only", "just", "like", "even", "back",
    "down", "still", "here", "well", "very", "much", "many", "every", "each", "both",
    "those", "these", "through", "between", "because", "around", "another", "something",
    "nothing", "everything", "anything", "someone", "anyone", "everyone", "chapter",
    "part", "prologue", "epilogue", "book", "page", "copyright", "dedication",
    "pero", "para", "como", "cuando", "donde", "dónde", "quien", "quién", "todo",
    "toda", "todos", "todas", "este", "esta", "estos", "estas", "esos", "esas",
    "aquel", "aquella", "había", "habia", "estaba", "estaban", "fueron", "hacia",
    "hasta", "desde", "entre", "sobre", "bajo", "tras", "durante", "mediante",
    "aunque", "porque", "mientras", "después", "despues", "antes", "ahora", "luego",
    "entonces", "siempre", "nunca", "jamás", "jamas", "también", "tambien", "tampoco",
    "algo", "nada", "alguien", "nadie", "cada", "otro", "otra", "otros", "otras",
    "mismo", "misma", "mismos", "tener", "tenía", "tenia", "hacer", "hizo", "decir",
    "dijo", "pudo", "podía", "podia", "capítulo", "capitulo", "parte", "prólogo",
    "prologo", "epílogo", "epilogo", "libro", "página", "pagina",
}

_ROMAN_MAP = {
    "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8,
    "ix": 9, "x": 10, "xi": 11, "xii": 12, "xiii": 13, "xiv": 14, "xv": 15,
    "xvi": 16, "xvii": 17, "xviii": 18, "xix": 19, "xx": 20, "xxi": 21,
    "xxii": 22, "xxiii": 23, "xxiv": 24, "xxv": 25, "xxvi": 26, "xxvii": 27,
    "xxviii": 28, "xxix": 29, "xxx": 30,
}


def _strip_accents_lower(text: str) -> str:
    norm = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode("ascii")
    return norm.lower().strip()


def _extract_chapter_alignment_profile(ch: Dict[str, Any], median_sentences: float) -> Dict[str, Any]:
    idx = int(ch.get("index", 0))
    title = str(ch.get("title") or f"Capítulo {idx + 1}").strip()
    sentences = ch.get("sentences") or []
    sentence_count = int(ch.get("sentence_count") or len(sentences))
    texts = [str(s.get("text") or "").strip() for s in sentences if str(s.get("text") or "").strip()]
    word_count = sum(len(t.split()) for t in texts) if texts else int(sentence_count * 14)

    # Construir extracto inicial saltando encabezados cortos ("1", "Capítulo 1")
    preview_parts: List[str] = []
    preview_chars = 0
    for i, t in enumerate(texts):
        if i == 0 and len(texts) > 1 and (len(t) <= 32 or _strip_accents_lower(t) == _strip_accents_lower(title)):
            if re.match(r"^(?:chapter|cap[íi]tulo|cap\.?|part|parte|pr[óo]logo|prologue|ep[íi]logo|epilogue|\d+|[ivxlcdm]+)\b", t, re.I):
                continue
        preview_parts.append(t)
        preview_chars += len(t)
        if preview_chars >= 220 or len(preview_parts) >= 3:
            break
    if not preview_parts and texts:
        preview_parts = texts[:2]
    preview_text = " ".join(preview_parts).strip()
    if len(preview_text) > 260:
        preview_text = preview_text[:257].rstrip() + "..."

    ending_text = ""
    if len(texts) >= 2:
        ending_text = " ".join(texts[-2:]).strip()
        if len(ending_text) > 170:
            ending_text = "..." + ending_text[-167:].lstrip()

    title_norm = _strip_accents_lower(title)
    first_norm = _strip_accents_lower(texts[0]) if texts else ""
    combined_head = f"{title_norm} {first_norm}".strip()

    # Detectar si el título "Capítulo {idx+1}" fue autogenerado por falta de encabezado real
    is_fallback_title = bool(
        re.match(rf"^capitulo\s+{idx + 1}$", title_norm)
        and (not first_norm or not re.search(rf"\b{idx + 1}\b", first_norm))
    )

    kind = "chapter"
    chapter_num: Optional[int] = None

    front_back_kw = (
        "title page", "portada", "copyright", "creditos", "dedication", "dedicatoria",
        "epigraph", "epigrafe", "contents", "table of contents", "indice", "sumario",
        "acknowledgment", "agradecimiento", "about the author", "sobre el autor",
        "sobre matt", "sobre este libro", "also by", "mailing list", "patreon",
        "critical acclaim", "available august", "notas", "personajes", "apendice",
        "appendix", "material adicional", "it's over", "its over", "one more",
        "facebook group",
    )
    divider_kw = re.match(r"^(?:part|parte|book|libro)\s+(?:\d+|[ivxlcdm]+|one|two|three|uno|dos|tres)\b", title_norm)

    if any(kw in title_norm for kw in ("contents", "table of contents", "indice", "sumario")):
        kind = "front_matter"
    elif divider_kw and sentence_count <= 8:
        kind = "divider"
    elif re.search(r"\b(?:prologue|prologo|preface|prefacio)\b", combined_head) and sentence_count >= 12:
        kind = "prologue"
        chapter_num = 0
    elif re.search(r"\b(?:epilogue|epilogo)\b", combined_head) and sentence_count >= 10:
        kind = "epilogue"
        chapter_num = 999
    elif any(kw in title_norm for kw in front_back_kw) and sentence_count <= 60:
        if "dedication" in title_norm or "dedicatoria" in title_norm or "dedico " in first_norm:
            kind = "dedication"
        elif "epigraph" in title_norm or "epigrafe" in title_norm:
            kind = "epigraph"
        else:
            kind = "front_matter"
    elif sentence_count <= max(14, int(median_sentences * 0.08)):
        if "dedico " in first_norm or "dedicated to" in first_norm or "thanks to" in first_norm:
            kind = "dedication"
        elif "coliseum" in first_norm or "coliseo" in first_norm:
            kind = "epigraph"
        elif divider_kw:
            kind = "divider"
        else:
            kind = "front_matter"

    if kind == "chapter" and not is_fallback_title:
        m_num = re.match(r"^(?:chapter|capitulo|cap\.?|ch\.?)\s*(\d{1,3})\b", title_norm)
        if not m_num:
            m_num = re.match(r"^(\d{1,3})(?:\b|[.: -])", title_norm)
        if not m_num and first_norm:
            m_num = re.match(r"^(?:chapter|capitulo|cap\.?|ch\.?)\s*(\d{1,3})\b", first_norm)
            if not m_num and len(first_norm) <= 6:
                m_num = re.match(r"^(\d{1,3})$", first_norm)
        if m_num:
            chapter_num = int(m_num.group(1))
        else:
            m_rom = re.match(r"^(?:chapter|capitulo|cap\.?|ch\.?)?\s*([ivxlcdm]{1,6})$", title_norm)
            if m_rom and m_rom.group(1) in _ROMAN_MAP:
                chapter_num = _ROMAN_MAP[m_rom.group(1)]

    is_story = kind in ("chapter", "prologue", "epilogue") and sentence_count > max(12, int(median_sentences * 0.07))

    # Extraer nombres propios en mayúscula y cifras relevantes para comparar contenido entre idiomas
    entity_counts: Dict[str, int] = {}
    for t in texts[:180]:
        # Cifras (ej: 2:23, 543, 35, 18, 1981)
        for num_m in re.findall(r"\b\d{2,6}\b", t):
            entity_counts[num_m] = entity_counts.get(num_m, 0) + 2
        # Palabras con mayúscula inicial
        words = re.findall(r"\b[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{3,18}\b", t)
        for w_idx, w in enumerate(words):
            norm_w = _strip_accents_lower(w)
            if norm_w in _ENTITY_STOPWORDS or len(norm_w) < 4:
                continue
            weight = 1 if w_idx == 0 else 2
            entity_counts[norm_w] = entity_counts.get(norm_w, 0) + weight

    top_entities = sorted(entity_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:45]
    entities_set = {k for k, v in top_entities if v >= 2 or len(top_entities) <= 15}

    return {
        "index": idx,
        "title": title,
        "sentence_count": sentence_count,
        "word_count": word_count,
        "preview": preview_text,
        "ending_preview": ending_text,
        "kind": kind,
        "chapter_num": chapter_num,
        "is_story": is_story,
        "entities": entities_set,
    }


def _load_book_chapters_for_alignment(book_id: str, book_meta: Dict[str, Any]) -> List[Dict[str, Any]]:
    chapters_path = BOOKS_DIR / book_id / "chapters.json"
    if chapters_path.exists():
        try:
            return json.loads(chapters_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return book_meta.get("chapters_summary") or book_meta.get("chapters") or []


def _compute_bilingual_chapter_alignment(
    book_a_id: str, book_b_id: str, library: Dict[str, Any]
) -> Dict[str, Any]:
    book_a = library.get(book_a_id) or {}
    book_b = library.get(book_b_id) or {}
    raw_a = _load_book_chapters_for_alignment(book_a_id, book_a)
    raw_b = _load_book_chapters_for_alignment(book_b_id, book_b)

    counts_a = sorted([int(c.get("sentence_count") or 0) for c in raw_a if int(c.get("sentence_count") or 0) > 15])
    counts_b = sorted([int(c.get("sentence_count") or 0) for c in raw_b if int(c.get("sentence_count") or 0) > 15])
    med_a = float(counts_a[len(counts_a) // 2]) if counts_a else 100.0
    med_b = float(counts_b[len(counts_b) // 2]) if counts_b else 100.0

    prof_a = [_extract_chapter_alignment_profile(c, med_a) for c in raw_a]
    prof_b = [_extract_chapter_alignment_profile(c, med_b) for c in raw_b]

    n_a = len(prof_a)
    n_b = len(prof_b)

    # Matriz de similitud par a par S[i][j]
    sim_matrix: List[List[float]] = [[0.0] * n_b for _ in range(n_a)]
    reasons_matrix: List[List[str]] = [[""] * n_b for _ in range(n_a)]

    for i, ca in enumerate(prof_a):
        for j, cb in enumerate(prof_b):
            sa = max(1, ca["sentence_count"])
            sb = max(1, cb["sentence_count"])
            wa = max(1, ca["word_count"])
            wb = max(1, cb["word_count"])

            sent_ratio = min(sa, sb) / max(sa, sb)
            word_ratio = min(wa, wb) / max(wa, wb)
            len_sim = 0.6 * sent_ratio + 0.4 * word_ratio

            # Penalizar emparejar un capítulo de historia largo con una portadilla muy corta
            if ca["is_story"] != cb["is_story"] and max(sa, sb) > 35 and min(sa, sb) <= 15:
                sim_matrix[i][j] = 0.02
                continue

            score = 0.42 * len_sim
            reason_parts: List[str] = []

            # Coincidencia por tipo o numeración de capítulo
            if ca["kind"] == cb["kind"] and ca["kind"] in ("prologue", "epilogue", "dedication", "epigraph"):
                score += 0.48
                reason_parts.append(f"Mismo tipo ({ca['kind']})")
            elif ca["chapter_num"] is not None and cb["chapter_num"] is not None:
                if ca["chapter_num"] == cb["chapter_num"]:
                    score += 0.46
                    if ca["chapter_num"] == 0:
                        reason_parts.append("Prólogo ↔ Prologue")
                    elif ca["chapter_num"] == 999:
                        reason_parts.append("Epílogo ↔ Epilogue")
                    else:
                        reason_parts.append(f"Cap. #{ca['chapter_num']}")
                else:
                    diff_num = abs(ca["chapter_num"] - cb["chapter_num"])
                    score -= min(0.42, 0.15 * diff_num)

            # Coincidencia por nombres propios y cifras en el texto
            common_ent = ca["entities"] & cb["entities"]
            if common_ent:
                min_ent = max(3, min(len(ca["entities"]), len(cb["entities"])))
                ent_ratio = min(1.0, len(common_ent) / min_ent)
                score += 0.34 * ent_ratio
                sample_names = [w.capitalize() for w in sorted(common_ent) if not w.isdigit()][:3]
                if sample_names:
                    reason_parts.append("Nombres: " + ", ".join(sample_names))

            if sent_ratio >= 0.82 and ca["is_story"] and cb["is_story"]:
                reason_parts.append(f"Longitud casi idéntica ({sa} vs {sb} fr.)")

            # Ligera preferencia por posiciones relativas cercanas en el libro
            rel_pos_diff = abs((i / max(1, n_a - 1)) - (j / max(1, n_b - 1)))
            score += max(0.0, 0.08 * (1.0 - rel_pos_diff * 3.0))

            sim_matrix[i][j] = max(0.0, min(1.25, score))
            reasons_matrix[i][j] = " • ".join(reason_parts) if reason_parts else f"{sa} ↔ {sb} frases"

    # Programación Dinámica (Needleman-Wunsch monotónico) para alinear capítulos en orden
    dp = [[0.0] * (n_b + 1) for _ in range(n_a + 1)]
    back = [[(0, 0)] * (n_b + 1) for _ in range(n_a + 1)]

    for i in range(1, n_a + 1):
        for j in range(1, n_b + 1):
            # Opción 1: Saltar capítulo i de A
            skip_a_pen = 0.06 if prof_a[i - 1]["is_story"] else 0.0
            best_val = dp[i - 1][j] - skip_a_pen
            best_prev = (i - 1, j)

            # Opción 2: Saltar capítulo j de B
            skip_b_pen = 0.06 if prof_b[j - 1]["is_story"] else 0.0
            val_skip_b = dp[i][j - 1] - skip_b_pen
            if val_skip_b > best_val:
                best_val = val_skip_b
                best_prev = (i, j - 1)

            # Opción 3: Emparejar (i-1, j-1) si supera umbral mínimo
            pair_sim = sim_matrix[i - 1][j - 1]
            min_thresh = 0.34 if (prof_a[i - 1]["is_story"] or prof_b[j - 1]["is_story"]) else 0.42
            if pair_sim >= min_thresh:
                val_pair = dp[i - 1][j - 1] + pair_sim
                if val_pair >= best_val:
                    best_val = val_pair
                    best_prev = (i - 1, j - 1)

            dp[i][j] = best_val
            back[i][j] = best_prev

    matched_pairs: List[Dict[str, Any]] = []
    ci, cj = n_a, n_b
    while ci > 0 and cj > 0:
        pi, pj = back[ci][cj]
        if pi == ci - 1 and pj == cj - 1:
            sim_val = sim_matrix[ci - 1][cj - 1]
            conf_pct = int(round(min(99.0, max(40.0, (sim_val / 0.92) * 100.0))))
            matched_pairs.append({
                "src_index": ci - 1,
                "tgt_index": cj - 1,
                "confidence": conf_pct,
                "reason": reasons_matrix[ci - 1][cj - 1],
                "is_story": bool(prof_a[ci - 1]["is_story"] or prof_b[cj - 1]["is_story"]),
            })
        ci, cj = pi, pj

    matched_pairs.reverse()

    chapter_map: Dict[str, int] = {}
    reverse_chapter_map: Dict[str, int] = {}
    offset_votes: Dict[int, int] = {}

    for mp in matched_pairs:
        s_idx = int(mp["src_index"])
        t_idx = int(mp["tgt_index"])
        chapter_map[str(s_idx)] = t_idx
        reverse_chapter_map[str(t_idx)] = s_idx
        if mp["is_story"]:
            off = t_idx - s_idx
            offset_votes[off] = offset_votes.get(off, 0) + 1

    dominant_offset = 0
    if offset_votes:
        dominant_offset = sorted(offset_votes.items(), key=lambda kv: (-kv[1], abs(kv[0])))[0][0]
    elif matched_pairs:
        dominant_offset = int(matched_pairs[0]["tgt_index"]) - int(matched_pairs[0]["src_index"])

    # Primer capítulo de historia emparejado (para mostrarlo por defecto en el selector)
    first_story_pair = next((mp for mp in matched_pairs if mp["is_story"]), matched_pairs[0] if matched_pairs else None)
    first_story_src = int(first_story_pair["src_index"]) if first_story_pair else 0
    first_story_tgt = int(first_story_pair["tgt_index"]) if first_story_pair else 0

    # Limpiar sets de entidades antes de serializar a JSON
    clean_a = [{k: v for k, v in p.items() if k != "entities"} for p in prof_a]
    clean_b = [{k: v for k, v in p.items() if k != "entities"} for p in prof_b]

    return {
        "book_a_id": book_a_id,
        "book_b_id": book_b_id,
        "book_a_chapters": clean_a,
        "book_b_chapters": clean_b,
        "chapter_map": chapter_map,
        "reverse_chapter_map": reverse_chapter_map,
        "pairs": matched_pairs,
        "dominant_offset": dominant_offset,
        "first_story_src": first_story_src,
        "first_story_tgt": first_story_tgt,
    }


@app.get("/api/books/{book_id}/pair-preview/{partner_id}")
async def preview_book_pairing_endpoint(book_id: str, partner_id: str) -> Dict[str, Any]:
    library = load_library()
    if book_id not in library or partner_id not in library:
        raise HTTPException(status_code=404, detail="Uno de los libros no existe en la biblioteca")
    return await asyncio.to_thread(
        _compute_bilingual_chapter_alignment, book_id, partner_id, library
    )


def _apply_book_pairing(
    library: Dict[str, Dict[str, Any]],
    book_id: str,
    partner_id: str,
    primary_book_id: Optional[str] = None,
    auto_switch_chapters: bool = True,
    chapter_offset: Optional[int] = None,
    chapter_map: Optional[Dict[str, int]] = None,
) -> Dict[str, Any]:
    """Empareja dos libros en `library`, calcula su mapa de capítulos y persiste metadata.json."""
    book_a = library[book_id]
    old_partner_id = (book_a.get("pairing") or {}).get("paired_book_id")
    if old_partner_id and old_partner_id != partner_id and old_partner_id in library:
        library[old_partner_id]["pairing"] = None

    book_b = library[partner_id]
    old_b_partner = (book_b.get("pairing") or {}).get("paired_book_id")
    if old_b_partner and old_b_partner != book_id and old_b_partner in library:
        library[old_b_partner]["pairing"] = None

    primary_id = primary_book_id
    if primary_id not in (book_id, partner_id):
        lang_a = (book_a.get("language") or "").lower()
        lang_b = (book_b.get("language") or "").lower()
        if lang_a.startswith("en") and not lang_b.startswith("en"):
            primary_id = book_id
        elif lang_b.startswith("en") and not lang_a.startswith("en"):
            primary_id = partner_id
        else:
            primary_id = book_id

    alignment = _compute_bilingual_chapter_alignment(book_id, partner_id, library)
    forward_map: Dict[str, int] = dict(alignment.get("chapter_map") or {})
    if chapter_map:
        for k, v in chapter_map.items():
            if v is not None and int(v) >= 0:
                forward_map[str(k)] = int(v)
            elif str(k) in forward_map and (v is None or int(v) < 0):
                del forward_map[str(k)]

    reverse_map: Dict[str, int] = {}
    for k_str, tgt_val in forward_map.items():
        try:
            reverse_map[str(int(tgt_val))] = int(k_str)
        except Exception:
            pass

    offset = int(chapter_offset if chapter_offset is not None else alignment.get("dominant_offset", 0))
    book_a["pairing"] = {
        "paired_book_id": book_b["id"],
        "paired_book_title": book_b["title"],
        "paired_book_lang": book_b.get("language", "es"),
        "auto_switch_chapters": bool(auto_switch_chapters),
        "primary_book_id": primary_id,
        "chapter_offset": offset,
        "chapter_map": forward_map,
    }
    book_b["pairing"] = {
        "paired_book_id": book_a["id"],
        "paired_book_title": book_a["title"],
        "paired_book_lang": book_a.get("language", "en"),
        "auto_switch_chapters": bool(auto_switch_chapters),
        "primary_book_id": primary_id,
        "chapter_offset": -offset,
        "chapter_map": reverse_map,
    }

    for bid, b_obj in ((book_id, book_a), (partner_id, book_b)):
        mpath = BOOKS_DIR / str(bid) / "metadata.json"
        if mpath.exists():
            try:
                m = json.loads(mpath.read_text(encoding="utf-8"))
                m["pairing"] = b_obj["pairing"]
                mpath.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception:
                pass
    return alignment


@app.put("/api/books/{book_id}/pair")
async def pair_books_endpoint(book_id: str, req: BookPairingRequest) -> Dict[str, Any]:
    library = load_library()
    if book_id not in library:
        raise HTTPException(status_code=404, detail="Libro no encontrado")

    book_a = library[book_id]
    old_partner_id = (book_a.get("pairing") or {}).get("paired_book_id")

    # Si se solicita desemparejar
    if not req.paired_book_id:
        book_a["pairing"] = None
        if old_partner_id and old_partner_id in library:
            library[old_partner_id]["pairing"] = None
        save_library(library)
        for bid in filter(None, [book_id, old_partner_id]):
            mpath = BOOKS_DIR / str(bid) / "metadata.json"
            if mpath.exists():
                try:
                    m = json.loads(mpath.read_text(encoding="utf-8"))
                    m["pairing"] = None
                    mpath.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
                except Exception:
                    pass
        return {"book": book_a, "paired_book": None}

    if req.paired_book_id == book_id:
        raise HTTPException(status_code=400, detail="No puedes emparejar un libro consigo mismo")
    if req.paired_book_id not in library:
        raise HTTPException(status_code=404, detail="El libro pareja seleccionado no existe")

    alignment = await asyncio.to_thread(
        _apply_book_pairing,
        library,
        book_id,
        req.paired_book_id,
        primary_book_id=req.primary_book_id,
        auto_switch_chapters=req.auto_switch_chapters,
        chapter_offset=req.chapter_offset,
        chapter_map=req.chapter_map,
    )
    save_library(library)
    return {"book": library[book_id], "paired_book": library[req.paired_book_id], "alignment": alignment}


@app.post("/api/dictionary/lookup")
async def lookup_word_post(req: DictionaryLookupRequest) -> Dict[str, Any]:
    try:
        return await asyncio.to_thread(
            dictionary_service.lookup, req.word, req.lang, req.sentence
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Error consultando diccionario para %s", req.word)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/obsidian/config")
async def get_obsidian_config_endpoint(book_id: Optional[str] = Query(default=None)) -> Dict[str, Any]:
    return await asyncio.to_thread(study_store.get_obsidian_config, book_id)


@app.get("/api/obsidian/attachment")
async def get_obsidian_attachment_endpoint(name: str = Query(..., description="Nombre del adjunto en Obsidian")) -> FileResponse:
    att_path = await asyncio.to_thread(study_store.find_obsidian_attachment, name)
    if not att_path or not att_path.exists():
        raise HTTPException(status_code=404, detail=f"Adjunto de Obsidian no encontrado: {name}")
    return FileResponse(att_path)


@app.put("/api/obsidian/config")
async def update_obsidian_config_endpoint(req: ObsidianConfigUpdateRequest) -> Dict[str, Any]:
    return await asyncio.to_thread(
        study_store.update_obsidian_config,
        vault_path=req.vault_path,
        books_subfolder=req.books_subfolder,
        auto_sync=req.auto_sync,
    )


@app.post("/api/books/{book_id}/study/obsidian-sync")
async def sync_book_obsidian_endpoint(book_id: str, req: ObsidianSyncRequest) -> Dict[str, Any]:
    res = await asyncio.to_thread(
        study_store.sync_book_with_obsidian,
        book_id=book_id,
        link_relpath=req.link_relpath,
    )
    study = res.get("study") or {}
    if study.get("reading_status") == "completed":
        library = load_library()
        if book_id in library and _ensure_completed_book_progress_100(book_id, library[book_id]):
            save_library(library)
    return res


@app.put("/api/books/{book_id}/study/obsidian-raw")
async def save_raw_obsidian_markdown_endpoint(
    book_id: str, req: ObsidianRawMarkdownRequest
) -> Dict[str, Any]:
    res = await asyncio.to_thread(
        study_store.save_raw_obsidian_markdown,
        book_id=book_id,
        md_text=req.markdown,
    )
    study = res.get("study") or {}
    if study.get("reading_status") == "completed":
        library = load_library()
        if book_id in library and _ensure_completed_book_progress_100(book_id, library[book_id]):
            save_library(library)
    obs_cfg = await asyncio.to_thread(study_store.get_obsidian_config, book_id)
    res["obsidian_config"] = obs_cfg
    return res


@app.get("/api/books/{book_id}/study")
async def get_book_study_data(book_id: str) -> Dict[str, Any]:
    study = await asyncio.to_thread(study_store.get_study_data, book_id)
    md = await asyncio.to_thread(study_store.get_obsidian_markdown, book_id)
    obs_cfg = await asyncio.to_thread(study_store.get_obsidian_config, book_id)
    return {
        "study": study,
        "markdown": md,
        "obsidian_markdown": md,
        "obsidian_config": obs_cfg,
    }


@app.put("/api/books/{book_id}/study/meta")
async def update_book_study_meta(
    book_id: str, req: StudyMetaUpdateRequest
) -> Dict[str, Any]:
    study = await asyncio.to_thread(
        study_store.update_reading_meta,
        book_id=book_id,
        reading_status=req.reading_status,
        started_date=req.started_date if req.started_date is not None else req.started_at,
        finished_date=req.finished_date if req.finished_date is not None else req.finished_at,
        times_read=req.times_read,
        rating=req.rating,
        general_notes=req.general_notes if req.general_notes is not None else req.book_notes,
        auto_underline_lookups=req.auto_underline_lookups,
        genre=req.genre,
        published_date=req.published_date,
        author=req.author,
    )
    # Sincronizar también en library.json y metadata.json del libro
    library = load_library()
    if book_id in library:
        if study.get("reading_status") == "completed":
            _ensure_completed_book_progress_100(book_id, library[book_id])
        if req.genre is not None:
            library[book_id]["genre"] = req.genre.strip()
            library[book_id]["genres"] = [
                g.strip() for g in req.genre.split(",") if g.strip()
            ]
        if req.published_date is not None:
            p_date, p_yr = epub_parser._parse_opf_publication_date(req.published_date)
            library[book_id]["published_date"] = p_date or req.published_date.strip()
            library[book_id]["published_year"] = p_yr
        if req.author is not None and req.author.strip():
            library[book_id]["author"] = req.author.strip()
        save_library(library)
        meta_path = BOOKS_DIR / book_id / "metadata.json"
        if meta_path.exists():
            try:
                m = json.loads(meta_path.read_text(encoding="utf-8"))
                if study.get("reading_status") == "completed":
                    m["progress"] = library[book_id].get("progress", m.get("progress", {}))
                if req.genre is not None:
                    m["genre"] = library[book_id].get("genre", "")
                    m["genres"] = library[book_id].get("genres", [])
                if req.published_date is not None:
                    m["published_date"] = library[book_id].get("published_date", "")
                    m["published_year"] = library[book_id].get("published_year")
                if req.author is not None and req.author.strip():
                    m["author"] = req.author.strip()
                meta_path.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception:
                pass

    md = await asyncio.to_thread(study_store.get_obsidian_markdown, book_id)
    obs_cfg = await asyncio.to_thread(study_store.get_obsidian_config, book_id)
    return {
        "study": study,
        "markdown": md,
        "obsidian_markdown": md,
        "obsidian_config": obs_cfg,
    }


@app.post("/api/books/{book_id}/study/vocabulary")
async def add_book_vocabulary(
    book_id: str, req: VocabularyAddRequest
) -> Dict[str, Any]:
    effective_note = req.user_note if req.user_note else req.note
    res = await asyncio.to_thread(
        study_store.add_or_update_vocabulary,
        book_id=book_id,
        word=req.word,
        lemma=req.lemma,
        phonetic=req.phonetic,
        source_lang=req.source_lang,
        translation=req.translation,
        definitions_summary=req.definitions_summary,
        context_sentence=req.context_sentence,
        context_translation=req.context_translation,
        chapter_index=req.chapter_index,
        chapter_title=req.chapter_title,
        sentence_index=req.sentence_index,
        user_note=effective_note,
    )
    md = await asyncio.to_thread(study_store.get_obsidian_markdown, book_id)
    res["markdown"] = md
    res["obsidian_markdown"] = md
    return res


@app.put("/api/books/{book_id}/study/vocabulary/{vocab_id}")
async def update_book_vocabulary(
    book_id: str, vocab_id: str, req: VocabularyNoteUpdateRequest
) -> Dict[str, Any]:
    effective_note = req.user_note if req.user_note else req.note
    study = await asyncio.to_thread(
        study_store.update_vocabulary_note,
        book_id=book_id,
        vocab_id=vocab_id,
        user_note=effective_note,
        translation=req.translation,
    )
    md = await asyncio.to_thread(study_store.get_obsidian_markdown, book_id)
    return {"study": study, "markdown": md, "obsidian_markdown": md}


@app.delete("/api/books/{book_id}/study/vocabulary/{vocab_id}")
async def delete_book_vocabulary(book_id: str, vocab_id: str) -> Dict[str, Any]:
    study = await asyncio.to_thread(study_store.delete_vocabulary, book_id, vocab_id)
    md = await asyncio.to_thread(study_store.get_obsidian_markdown, book_id)
    return {"study": study, "markdown": md, "obsidian_markdown": md}


@app.post("/api/books/{book_id}/study/highlights")
async def add_book_highlight(
    book_id: str, req: HighlightAddRequest
) -> Dict[str, Any]:
    effective_text = (req.text or req.selected_text or "").strip()
    effective_indices = list(req.sentence_indices or [])
    if not effective_indices and req.sentence_index is not None and req.sentence_index >= 0:
        effective_indices = [req.sentence_index]
    res = await asyncio.to_thread(
        study_store.add_highlight,
        book_id=book_id,
        text=effective_text,
        note=req.note,
        color=req.color,
        chapter_index=req.chapter_index,
        chapter_title=req.chapter_title,
        sentence_indices=effective_indices,
    )
    md = await asyncio.to_thread(study_store.get_obsidian_markdown, book_id)
    res["markdown"] = md
    res["obsidian_markdown"] = md
    return res


@app.put("/api/books/{book_id}/study/highlights/{highlight_id}")
async def update_book_highlight(
    book_id: str, highlight_id: str, req: HighlightUpdateRequest
) -> Dict[str, Any]:
    study = await asyncio.to_thread(
        study_store.update_highlight,
        book_id=book_id,
        highlight_id=highlight_id,
        note=req.note,
        color=req.color,
    )
    md = await asyncio.to_thread(study_store.get_obsidian_markdown, book_id)
    return {"study": study, "markdown": md, "obsidian_markdown": md}


@app.delete("/api/books/{book_id}/study/highlights/{highlight_id}")
async def delete_book_highlight(book_id: str, highlight_id: str) -> Dict[str, Any]:
    study = await asyncio.to_thread(
        study_store.delete_highlight, book_id, highlight_id
    )
    md = await asyncio.to_thread(study_store.get_obsidian_markdown, book_id)
    return {"study": study, "markdown": md, "obsidian_markdown": md}


@app.post("/api/books/{book_id}/study/sessions")
async def record_book_reading_session(
    book_id: str, req: ReadingSessionRequest
) -> Dict[str, Any]:
    if req.duration_seconds is not None:
        dur_sec = max(1, int(round(req.duration_seconds)))
    else:
        dur_sec = max(60, int(round(float(req.duration_minutes or 1) * 60)))
    sc = (
        req.start_chapter
        if req.start_chapter is not None
        else (
            req.start_chapter_index
            if req.start_chapter_index is not None
            else (req.chapter_index or 0)
        )
    )
    ec = (
        req.end_chapter
        if req.end_chapter is not None
        else (req.end_chapter_index if req.end_chapter_index is not None else sc)
    )
    ch_title = req.chapter_title or req.end_chapter_title or req.start_chapter_title or ""
    custom_date = req.date if req.date else None
    res = await asyncio.to_thread(
        study_store.record_or_update_session,
        book_id=book_id,
        session_id=req.session_id,
        duration_seconds=dur_sec,
        start_chapter=sc,
        end_chapter=ec,
        chapter_title=ch_title,
        sentences_read=req.sentences_read,
        note=req.note,
        custom_date=custom_date,
        started_at=req.started_at,
        ended_at=req.ended_at,
    )
    if not custom_date:
        library = load_library()
        if book_id in library:
            sess_obj = res.get("session") or {}
            sess_ts = int(sess_obj.get("ended_at") or sess_obj.get("started_at") or time.time())
            prog = library[book_id].get("progress", {})
            prog["updated_at"] = max(int(prog.get("updated_at") or 0), sess_ts)
            prog["last_read_at"] = max(int(prog.get("last_read_at") or 0), sess_ts)
            library[book_id]["progress"] = prog
            save_library(library)
    md = await asyncio.to_thread(study_store.get_obsidian_markdown, book_id)
    res["markdown"] = md
    res["obsidian_markdown"] = md
    return res


@app.get("/api/reading-analytics")
async def get_global_reading_analytics() -> Dict[str, Any]:
    library = load_library()
    return await asyncio.to_thread(study_store.get_global_analytics, library)


@app.put("/api/reading-goals")
async def update_global_reading_goals(
    req: ReadingGoalsUpdateRequest,
) -> Dict[str, Any]:
    await asyncio.to_thread(
        study_store.update_reading_goals,
        daily_minutes_goal=req.daily_minutes_goal,
        yearly_books_goal=req.yearly_books_goal,
        yearly_pages_goal=req.yearly_pages_goal,
    )
    library = load_library()
    return await asyncio.to_thread(study_store.get_global_analytics, library)


@app.delete("/api/books/{book_id}/study/sessions/{session_id}")
async def delete_book_reading_session(
    book_id: str, session_id: str
) -> Dict[str, Any]:
    study = await asyncio.to_thread(
        study_store.delete_session, book_id, session_id
    )
    md = await asyncio.to_thread(study_store.get_obsidian_markdown, book_id)
    return {"study": study, "markdown": md, "obsidian_markdown": md}


@app.get("/api/books/{book_id}/study/obsidian.md")
async def download_obsidian_markdown(book_id: str) -> Response:
    md_text = await asyncio.to_thread(study_store.get_obsidian_markdown, book_id)
    library = load_library()
    book_title = library.get(book_id, {}).get("title", book_id)
    safe_title = (
        "".join(c if c.isalnum() or c in " -_" else "" for c in book_title).strip()
        or book_id
    )
    return Response(
        content=md_text.encode("utf-8"),
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_title}_Obsidian.md"'
        },
    )


@app.get("/api/books/{book_id}")
async def get_book_details(book_id: str) -> Dict[str, Any]:
    library = load_library()
    if book_id not in library:
        meta_path = BOOKS_DIR / book_id / "metadata.json"
        if not meta_path.exists():
            raise HTTPException(status_code=404, detail="Libro no encontrado")
        book_meta = json.loads(meta_path.read_text(encoding="utf-8"))
        library[book_id] = book_meta
        save_library(library)
    b = library[book_id]
    pairing_obj = b.get("pairing")
    if isinstance(pairing_obj, dict) and pairing_obj.get("paired_book_id") and not pairing_obj.get("chapter_map"):
        partner_id = str(pairing_obj["paired_book_id"])
        if partner_id in library:
            try:
                align_info = await asyncio.to_thread(_compute_bilingual_chapter_alignment, book_id, partner_id, library)
                if align_info.get("chapter_map"):
                    pairing_obj["chapter_map"] = align_info["chapter_map"]
                    partner_pairing = library[partner_id].get("pairing")
                    if isinstance(partner_pairing, dict) and partner_pairing.get("paired_book_id") == book_id:
                        partner_pairing["chapter_map"] = align_info.get("reverse_chapter_map") or {}
                    save_library(library)
            except Exception:
                pass
    return {"book": b}


@app.get("/api/books/{book_id}/chapters/{chapter_index}")
async def get_book_chapter(book_id: str, chapter_index: int) -> Dict[str, Any]:
    chapters_path = BOOKS_DIR / book_id / "chapters.json"
    if not chapters_path.exists():
        raise HTTPException(status_code=404, detail="Capítulos del libro no encontrados")

    chapters = json.loads(chapters_path.read_text(encoding="utf-8"))
    if chapter_index < 0 or chapter_index >= len(chapters):
        raise HTTPException(status_code=404, detail="Índice de capítulo fuera de rango")

    return {"chapter": chapters[chapter_index], "total_chapters": len(chapters)}


@app.put("/api/books/{book_id}/progress")
async def update_book_progress(book_id: str, payload: ProgressUpdate) -> Dict[str, Any]:
    library = load_library()
    if book_id not in library:
        raise HTTPException(status_code=404, detail="Libro no encontrado")

    prog = library[book_id].get("progress", {})
    prog["chapter_index"] = payload.chapter_index
    prog["sentence_index"] = payload.sentence_index
    if payload.voice_id:
        prog["voice_id"] = payload.voice_id
    if payload.speed:
        prog["speed"] = payload.speed

    ch_pos = dict(prog.get("chapter_positions") or {})
    if isinstance(payload.chapter_positions, dict):
        for k_str, v_val in payload.chapter_positions.items():
            try:
                ch_pos[str(int(k_str))] = max(0, int(v_val))
            except Exception:
                pass
    ch_pos[str(int(payload.chapter_index))] = max(0, int(payload.sentence_index))
    prog["chapter_positions"] = ch_pos

    now_ts = int(time.time())
    prog["updated_at"] = now_ts
    prog["last_read_at"] = now_ts

    library[book_id]["progress"] = prog
    save_library(library)
    return {"progress": prog}


class OfflineChapterAudioRequest(BaseModel):
    voice_id: str = Field("piper:es_ES-davefx-medium")
    speed: float = Field(1.0, ge=0.5, le=2.2)
    start_sentence: int = Field(0, ge=0)
    limit: int = Field(0, ge=0)


@app.get("/api/books/{book_id}/offline-bundle")
async def get_book_offline_bundle(book_id: str) -> Dict[str, Any]:
    """Descarga el libro completo (metadatos, todos los capítulos y notas) para guardarlo en IndexedDB y usarlo sin conexión."""
    book_folder = BOOKS_DIR / book_id
    meta_path = book_folder / "metadata.json"
    library = load_library()
    if not meta_path.exists() and book_id not in library:
        raise HTTPException(status_code=404, detail="Libro no encontrado")

    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    else:
        meta = dict(library[book_id])

    if book_id in library:
        meta["progress"] = library[book_id].get("progress", meta.get("progress", {}))
        if library[book_id].get("pairing"):
            meta["pairing"] = library[book_id]["pairing"]

    chapters: List[Dict[str, Any]] = []
    chapters_path = book_folder / "chapters.json"
    if chapters_path.exists():
        chapters = json.loads(chapters_path.read_text(encoding="utf-8"))
    else:
        chapter_count = int(meta.get("chapter_count", 0))
        for idx in range(chapter_count):
            ch_file = book_folder / f"chapter_{idx}.json"
            if ch_file.exists():
                chapters.append(json.loads(ch_file.read_text(encoding="utf-8")))

    study_data = await asyncio.to_thread(study_store.get_study_data, book_id)
    obsidian_md = await asyncio.to_thread(study_store.get_obsidian_markdown, book_id)
    exports_info = await asyncio.to_thread(audio_store.list_book_exports, book_id)

    return {
        "book": meta,
        "chapters": chapters,
        "study": study_data,
        "obsidian_markdown": obsidian_md,
        "exports": exports_info.get("exports", []),
    }


@app.post("/api/books/{book_id}/chapters/{chapter_index}/offline-audio")
async def get_chapter_offline_audio_pack(
    book_id: str, chapter_index: int, req: OfflineChapterAudioRequest
) -> Dict[str, Any]:
    """Genera o recupera de caché los audios WAV de un capítulo (completo o por lotes) para guardarlos en el móvil (IndexedDB) y escucharlos sin conexión."""
    book_folder = BOOKS_DIR / book_id
    chapters_path = book_folder / "chapters.json"
    ch_data: Optional[Dict[str, Any]] = None

    if chapters_path.exists():
        all_chapters = json.loads(chapters_path.read_text(encoding="utf-8"))
        if 0 <= chapter_index < len(all_chapters):
            ch_data = all_chapters[chapter_index]
    else:
        chapter_file = book_folder / f"chapter_{chapter_index}.json"
        if chapter_file.exists():
            ch_data = json.loads(chapter_file.read_text(encoding="utf-8"))

    if not ch_data:
        raise HTTPException(status_code=404, detail="Capítulo no encontrado")

    sentences = ch_data.get("sentences", [])
    start_s = max(0, int(req.start_sentence or 0))
    if req.limit and req.limit > 0:
        batch_sentences = sentences[start_s : start_s + int(req.limit)]
    else:
        batch_sentences = sentences[start_s:]

    def _build_pack() -> List[Dict[str, Any]]:
        pack: List[Dict[str, Any]] = []
        for offset, s_obj in enumerate(batch_sentences):
            s_idx = int(s_obj.get("index", start_s + offset))
            s_text = (s_obj.get("text") or "").strip()
            if not s_text:
                continue
            wav_bytes = audio_store.get_or_synthesize_sentence(
                book_id=book_id,
                chapter_index=chapter_index,
                sentence_index=s_idx,
                text=s_text,
                voice_id=req.voice_id,
                speed=req.speed,
            )
            pack.append(
                {
                    "index": s_idx,
                    "wav_b64": base64.b64encode(wav_bytes).decode("ascii"),
                }
            )
        return pack

    try:
        audio_items = await asyncio.to_thread(_build_pack)
    except Exception as exc:
        logger.exception("Error empaquetando audio offline cap %s de %s", chapter_index, book_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "book_id": book_id,
        "chapter_index": chapter_index,
        "voice_id": req.voice_id,
        "speed": req.speed,
        "total_sentences": len(sentences),
        "start_sentence": start_s,
        "sentences_audio": audio_items,
    }


@app.get("/api/books/{book_id}/cover")
async def get_book_cover(book_id: str) -> FileResponse:
    book_folder = BOOKS_DIR / book_id
    if not book_folder.exists():
        raise HTTPException(status_code=404, detail="Libro no encontrado")
    for p in book_folder.glob("cover.*"):
        return FileResponse(p)
    raise HTTPException(status_code=404, detail="Portada no disponible")


@app.get("/api/books/{book_id}/assets/{asset_path:path}")
async def get_book_asset(book_id: str, asset_path: str) -> FileResponse:
    assets_root = (BOOKS_DIR / book_id / "assets").resolve()
    requested = (assets_root / asset_path).resolve()
    if not str(requested).startswith(str(assets_root)) or not requested.is_file():
        raise HTTPException(status_code=404, detail="Recurso no encontrado")
    return FileResponse(requested)


@app.get("/api/voices")
async def get_voices() -> Dict[str, Any]:
    gpu_info = await asyncio.to_thread(tts_manager.get_gpu_status)
    return {"voices": tts_manager.list_voices(), "gpu": gpu_info}


@app.delete("/api/voices/downloaded/{voice_id:path}")
async def remove_downloaded_voice(voice_id: str) -> Dict[str, Any]:
    deleted, freed_mb = await asyncio.to_thread(
        tts_manager.delete_downloaded_voice, voice_id
    )
    if not deleted:
        raise HTTPException(
            status_code=404, detail="No había archivos descargados para este modelo"
        )
    return {"deleted": voice_id, "freed_mb": freed_mb}


@app.post("/api/voices/download")
async def download_voice(req: VoiceDownloadRequest) -> Dict[str, Any]:
    try:
        status = await asyncio.to_thread(tts_manager.ensure_voice_downloaded, req.voice_id)
        return status
    except Exception as exc:
        logger.exception("Error descargando modelo de voz %s", req.voice_id)
        raise HTTPException(
            status_code=500, detail=f"Error descargando modelo {req.voice_id}: {exc}"
        ) from exc


@app.get("/api/exports/queue")
async def get_global_exports_queue() -> Dict[str, Any]:
    return await asyncio.to_thread(audio_store.list_all_exports_queue)


@app.get("/api/books/{book_id}/exports")
async def get_book_exports(book_id: str) -> Dict[str, Any]:
    return await asyncio.to_thread(audio_store.list_book_exports, book_id)


@app.post("/api/books/{book_id}/exports/start")
async def start_book_export(book_id: str, req: ExportStartRequest) -> Dict[str, Any]:
    all_voices = tts_manager.get_all_voices_map()
    voice_info = all_voices.get(req.voice_id, {"name": req.voice_id})
    job = await asyncio.to_thread(
        audio_store.start_export_job,
        book_id=book_id,
        voice_id=req.voice_id,
        voice_name=voice_info.get("name", req.voice_id),
        speed=req.speed,
        build_m4b=req.build_m4b,
        build_epub_overlay=req.build_epub_overlay,
    )
    return {"job": job}


@app.post("/api/books/{book_id}/exports/cancel")
async def cancel_book_export(book_id: str) -> Dict[str, Any]:
    job = await asyncio.to_thread(audio_store.cancel_export_job, book_id)
    return {"job": job}


@app.delete("/api/books/{book_id}/exports/{voice_hash}")
async def delete_book_export_endpoint(book_id: str, voice_hash: str) -> Dict[str, Any]:
    return await asyncio.to_thread(audio_store.delete_book_export, book_id, voice_hash)


@app.get("/api/books/{book_id}/exports/{voice_hash}/m4b")
async def download_book_m4b(book_id: str, voice_hash: str) -> FileResponse:
    m4b_path = (BOOKS_DIR / book_id / "exports" / voice_hash / "audiobook.m4b").resolve()
    if not m4b_path.is_file():
        raise HTTPException(status_code=404, detail="Archivo M4B no encontrado")
    library = load_library()
    book_title = library.get(book_id, {}).get("title", book_id)
    safe_title = "".join(c if c.isalnum() or c in " -_" else "" for c in book_title).strip() or book_id
    return FileResponse(
        m4b_path,
        media_type="audio/mp4",
        filename=f"{safe_title}.m4b",
    )


@app.get("/api/books/{book_id}/exports/{voice_hash}/epub-overlay")
async def download_book_epub_overlay(book_id: str, voice_hash: str) -> FileResponse:
    epub_path = (BOOKS_DIR / book_id / "exports" / voice_hash / "book_media_overlay.epub").resolve()
    if not epub_path.is_file():
        raise HTTPException(status_code=404, detail="Archivo EPUB Media Overlay no encontrado")
    library = load_library()
    book_title = library.get(book_id, {}).get("title", book_id)
    safe_title = "".join(c if c.isalnum() or c in " -_" else "" for c in book_title).strip() or book_id
    return FileResponse(
        epub_path,
        media_type="application/epub+zip",
        filename=f"{safe_title}_MediaOverlay.epub",
    )


@app.post("/api/tts")
async def synthesize_speech_post(req: TTSRequest) -> Response:
    try:
        if (
            req.book_id is not None
            and req.chapter_index is not None
            and req.sentence_index is not None
        ):
            wav_bytes = await asyncio.to_thread(
                audio_store.get_or_synthesize_sentence,
                req.book_id,
                req.chapter_index,
                req.sentence_index,
                req.text,
                req.voice_id,
                req.speed,
            )
        else:
            wav_bytes = await asyncio.to_thread(
                tts_manager.synthesize, req.text, req.voice_id, req.speed
            )
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={"Cache-Control": "public, max-age=3600"},
        )
    except Exception as exc:
        logger.exception("Error en síntesis TTS (%s)", req.voice_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/tts")
async def synthesize_speech_get(
    text: str = Query(..., min_length=1, max_length=2500),
    voice_id: str = Query(default="piper:es_ES-davefx-medium"),
    speed: float = Query(default=1.0, ge=0.5, le=2.2),
) -> Response:
    try:
        wav_bytes = await asyncio.to_thread(
            tts_manager.synthesize, text, voice_id, speed
        )
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={"Cache-Control": "public, max-age=3600"},
        )
    except Exception as exc:
        logger.exception("Error en síntesis TTS (%s)", voice_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _build_app_icon_png(size: int = 192) -> bytes:
    """Genera un icono PNG válido (sin dependencias externas) para que Android instale la PWA como WebAPK."""
    import struct
    import zlib

    raw_rows = bytearray()
    center = size / 2.0
    radius = size * 0.42
    for y in range(size):
        raw_rows.append(0)  # Filter byte 0
        for x in range(size):
            dx = abs(x - center)
            dy = abs(y - center)
            if dx < radius and dy < radius:
                # Fondo azul oscuro (#1e293b) con franja central ámbar (#d97706) simulando un libro
                if abs(x - center) < size * 0.03 and abs(y - center) < size * 0.25:
                    raw_rows.extend((245, 158, 11, 255))
                elif abs(x - center) < size * 0.24 and abs(y - center) < size * 0.22:
                    raw_rows.extend((251, 246, 236, 255))
                else:
                    raw_rows.extend((30, 41, 59, 255))
            else:
                raw_rows.extend((15, 23, 42, 255))

    def _chunk(chunk_type: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw_rows), 6)
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")


_ICON_CACHE: Dict[int, bytes] = {}


@app.get("/icon-192.png")
async def get_icon_192() -> Response:
    if 192 not in _ICON_CACHE:
        _ICON_CACHE[192] = _build_app_icon_png(192)
    return Response(content=_ICON_CACHE[192], media_type="image/png")


@app.get("/icon-512.png")
async def get_icon_512() -> Response:
    if 512 not in _ICON_CACHE:
        _ICON_CACHE[512] = _build_app_icon_png(512)
    return Response(content=_ICON_CACHE[512], media_type="image/png")


# Servir la aplicación web progresiva (PWA) estática
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
