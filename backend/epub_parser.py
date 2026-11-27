import hashlib
import io
import json
import logging
import os
import posixpath
import re
import shutil
import subprocess
import time
import unicodedata
import urllib.parse
import wave
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from bs4 import BeautifulSoup, NavigableString, Tag

logger = logging.getLogger("epub_tts.parser")

_MINOR_TITLE_WORDS = {
    "a", "al", "an", "and", "as", "at", "by", "con", "de", "del", "e", "el", "en",
    "for", "from", "in", "la", "las", "los", "o", "of", "on", "or", "para", "por",
    "the", "to", "u", "un", "una", "with", "y",
}

_ROMAN_TOKENS = {
    "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",
    "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx",
    "xxi", "xxii", "xxiii", "xxiv", "xxv", "xxvi", "xxvii", "xxviii", "xxix", "xxx",
}

_KEEP_UPPER_TOKENS = _ROMAN_TOKENS | {"est", "ast", "mst", "pst", "cst", "edt", "gmt", "utc", "ai", "tv", "fbi", "cia"}

_SPELLED_NUMBERS_RE = re.compile(
    r"^(?:"
    r"one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|"
    r"fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|"
    r"seventy|eighty|ninety|hundred|"
    r"uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|"
    r"quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuno|veintidos|"
    r"veintitres|veinticuatro|veinticinco|veintiseis|veintisiete|veintiocho|veintinueve|"
    r"treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|"
    r"primero|segundo|tercero|cuarto|quinto|sexto|septimo|octavo|noveno|decimo"
    r")(?:(?:\s+y\s+|\s+and\s+|[\s-])(?:one|two|three|four|five|six|seven|eight|nine|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve))?$",
    re.I,
)

_FRONT_MATTER_TITLE_KW = (
    "title page", "portada", "cubierta", "portadilla", "half title",
    "copyright", "creditos", "credits", "colofon", "colophon",
    "dedication", "dedicatoria", "epigraph", "epigrafe", "cita", "citas",
    "contents", "table of contents", "indice", "sumario",
    "sinopsis", "synopsis", "publisher info", "informacion editorial",
    "sobre este libro", "front matter", "preliminar", "definition",
    "anniversary edition", "edicion conmemorativa", "edicion especial",
)

_BACK_MATTER_TITLE_KW = (
    "acknowledgment", "acknowledgments", "acknowledgement", "acknowledgements",
    "agradecimiento", "agradecimientos", "about the author", "sobre el autor",
    "about the publisher", "sobre la editorial", "also by", "other works",
    "otras obras", "otros titulos", "mailing list", "patreon", "facebook group", "facebook groups",
    "praise", "critical acclaim", "nota del autor", "author's note", "authors note",
    "notas", "notes", "nota", "bibliography", "bibliografia", "glossary", "glosario",
    "bookperk", "it's over", "its over", "one more", "proxima lectura",
    "sobre matt", "credits", "creditos", "copyright", "back matter",
    "material adicional", "bonus chapter", "anexo narrativo",
)

_DIVIDER_TITLE_RE = re.compile(
    r"^(?:"
    r"(?:part|parte|book|libro|act|acto|volume|volumen|section|seccion|heat|horrible)\s+"
    r"(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)"
    r"|(?:primera|segunda|tercera|cuarta|quinta|sexta|septima|octava|novena|decima|first|second|third|fourth|fifth|sixth)\s+"
    r"(?:parte|part|libro|book)"
    r")\b",
    re.I,
)


def _strip_accents_lower(text: str) -> str:
    norm = (
        unicodedata.normalize("NFKD", str(text or ""))
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    return re.sub(r"\s+", " ", norm).lower().strip()


def _extract_clean_element_text(el: Tag) -> str:
    """Extrae texto de un elemento HTML sin romper drop-caps (<span>T</span>he) pero respetando <br>."""
    if el is None:
        return ""
    clone = BeautifulSoup(str(el), "html.parser")
    for br in clone.find_all("br"):
        br.replace_with(" ")
    for blk in clone.find_all(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6"]):
        blk.insert_before(" ")
        blk.insert_after(" ")
    raw = clone.get_text("")
    return _clean_heading_text(raw)


def _clean_heading_text(raw: str) -> str:
    txt = str(raw or "").replace("\xa0", " ")
    txt = re.sub(r"\s+", " ", txt).strip()
    if not txt:
        return ""
    # Arreglar ordinales rotos por <sup>: "40 th" -> "40th"
    txt = re.sub(r"\b(\d+)\s+(st|nd|rd|th)\b", r"\1\2", txt, flags=re.I)
    txt = re.sub(r"\s+", " ", txt).strip()
    return txt


def _smart_title_case_token(tok: str, is_first: bool) -> str:
    # Preservar puntuación exterior («, ", (, :, .)
    m = re.match(r"^([^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]*)(.*?)([^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]*)$", tok)
    if not m:
        return tok
    lead, core, trail = m.groups()
    if not core:
        return tok
    low_core = _strip_accents_lower(core)
    if low_core in _KEEP_UPPER_TOKENS:
        return f"{lead}{core.upper()}{trail}"
    if "-" in core and len(core) > 2:
        parts = core.split("-")
        rebuilt = "-".join(_smart_title_case_token(p, idx == 0 and is_first) for idx, p in enumerate(parts))
        return f"{lead}{rebuilt}{trail}"
    if not is_first and low_core in _MINOR_TITLE_WORDS:
        return f"{lead}{core.lower()}{trail}"
    return f"{lead}{core[:1].upper()}{core[1:].lower()}{trail}"


def _normalize_heading_casing(text: str) -> str:
    """Normaliza encabezados TODO MAYÚSCULAS a formato título limpio preservando romanos y siglas."""
    txt = _clean_heading_text(text)
    if not txt:
        return ""
    # Separar encabezado mixto "PRIMERA PARTE El Comienzo" -> "Primera Parte: El Comienzo"
    m_mix = re.match(
        r"^((?:PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|SÉPTIMA|OCTAVA|NOVENA|DÉCIMA)\s+PARTE|"
        r"(?:PART|PARTE|BOOK|LIBRO)\s+(?:[IVXLCDM]+|\d+|ONE|TWO|THREE|FOUR|FIVE|SIX|UNO|DOS|TRES|CUATRO|CINCO))\s+(.+)$",
        txt,
    )
    if m_mix:
        head_p = _normalize_heading_casing(m_mix.group(1))
        rest_p = m_mix.group(2).strip()
        if rest_p and not rest_p.startswith((":", "—", "-")):
            rest_norm = _normalize_heading_casing(rest_p) if rest_p.isupper() else rest_p
            return f"{head_p}: {rest_norm}"

    letters = [c for c in txt if c.isalpha()]
    if len(letters) < 3:
        return txt
    upper_ratio = sum(1 for c in letters if c.isupper()) / len(letters)
    if upper_ratio < 0.85:
        return txt
    # Si todo son romanos o siglas cortas (ej. "IV"), conservar
    if len(txt) <= 4 and _strip_accents_lower(txt) in _KEEP_UPPER_TOKENS:
        return txt.upper()

    tokens = txt.split(" ")
    out = [_smart_title_case_token(tok, i == 0) for i, tok in enumerate(tokens)]
    return " ".join(out)


def _shorten_part_prefix(part_title: str) -> str:
    """Acorta un título de Parte/Libro para prefijo de capítulo: 'Part I: The Beginning' -> 'Part I'."""
    pt = _normalize_heading_casing(part_title)
    if not pt:
        return ""
    pt = re.sub(r"\s*\(texto\)\s*$", "", pt, flags=re.I).strip()
    m_std = re.match(
        r"^((?:Part|Parte|Book|Libro|Act|Acto)\s+(?:[IVXLCDM]+|\d+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|"
        r"Uno|Dos|Tres|Cuatro|Cinco|Seis|Siete|Ocho|Nueve|Diez)|"
        r"(?:Primera|Segunda|Tercera|Cuarta|Quinta|Sexta|Séptima|Octava|Novena|Décima|"
        r"First|Second|Third|Fourth|Fifth|Sixth)\s+(?:Parte|Part|Libro|Book))\b",
        pt,
        re.I,
    )
    if m_std:
        return m_std.group(1).strip()
    if ":" in pt:
        left = pt.split(":", 1)[0].strip()
        if 2 <= len(left) <= 28:
            return left
    if " — " in pt:
        left = pt.split(" — ", 1)[0].strip()
        if 2 <= len(left) <= 28:
            return left
    return pt[:28].rstrip()


def _normalize_toc_href(base_dir: str, raw_href: str) -> str:
    target = str(raw_href or "").split("#", 1)[0].strip()
    if not target:
        return ""
    unquoted = urllib.parse.unquote(target)
    joined = posixpath.join(base_dir, unquoted) if base_dir else unquoted
    norm = posixpath.normpath(joined).lstrip("/")
    if norm.startswith("./"):
        norm = norm[2:]
    return norm


def _is_standalone_chapter_lead(text: str) -> bool:
    """Detecta encabezados de capítulo escritos en <p> dentro de EPUBs divididos (ej. 'UNO', '15:55 (EST)', '1', 'PRIMER INTERLUDIO')."""
    t = _clean_heading_text(text)
    if not t or len(t) > 58:
        return False
    norm = _strip_accents_lower(t)
    # Descartar frases normales que terminan en punto/signos (salvo "1.", "2.", "p.m.", "(EST)")
    if re.search(r"[!?…]$", t):
        return False
    if t.endswith(".") and not re.match(r"^(?:\d{1,3}|[ivxlcdm]{1,6})\.$", norm) and not re.search(r"\b(?:a\.m\.|p\.m\.)$", norm):
        return False
    # 1. Número arábigo o romano
    if re.match(r"^(?:\d{1,3}|[ivxlcdm]{1,6})\.?$", norm):
        return True
    # 2. Número escrito en letras (UNO..CIEN, One..Hundred)
    if _SPELLED_NUMBERS_RE.match(norm):
        return True
    # 3. Capítulo / Chapter / Prólogo / Epílogo / Interludio / Parte / Libro / Después: Uno
    if re.match(
        r"^(?:(?:chapter|capitulo|cap\.?|prologue|prologo|epilogue|epilogo|preface|prefacio|"
        r"interlude|interludio|primer interludio|segundo interludio|tercer interludio|cuarto interludio|"
        r"first interlude|second interlude|third interlude|fourth interlude|"
        r"part|parte|book|libro)\b|(?:after|despues)\s*:)",
        norm,
    ):
        return True
    # 4. Hora / timestamp de capítulo (ej. "15:55 (EST)", "3:55 p.m. (EST)", "Año 0, día 0")
    if re.match(r"^\d{1,2}:\d{2}\b", norm) or re.match(r"^(?:ano|year|dia|day)\s+-?\d+", norm):
        return True
    return False


def parse_smil_clock(val: Optional[str]) -> Optional[float]:
    """
    Convierte un valor de reloj SMIL 3.0 ('01:23:45.678', '02:15.4', '14.25s', '14250ms', '2.5min')
    a segundos en coma flotante.
    """
    if val is None:
        return None
    s = str(val).strip().lower()
    if not s:
        return None
    try:
        if s.endswith("ms"):
            return max(0.0, float(s[:-2].strip()) / 1000.0)
        if s.endswith("min"):
            return max(0.0, float(s[:-3].strip()) * 60.0)
        if s.endswith("h"):
            return max(0.0, float(s[:-1].strip()) * 3600.0)
        if s.endswith("s"):
            return max(0.0, float(s[:-1].strip()))
        if ":" in s:
            parts = [float(p) for p in s.split(":")]
            if len(parts) == 3:
                return max(0.0, parts[0] * 3600.0 + parts[1] * 60.0 + parts[2])
            if len(parts) == 2:
                return max(0.0, parts[0] * 60.0 + parts[1])
        return max(0.0, float(s))
    except Exception:
        return None


# Abreviaturas comunes en español (España) e inglés para evitar cortes falsos de frase
ABBREVIATIONS = {
    # Español
    "sr", "sra", "srta", "dr", "dra", "prof", "profa", "ing", "lic", "arq",
    "ud", "uds", "vd", "vds", "etc", "fig", "pág", "págs", "cap", "caps",
    "vol", "vols", "núm", "nro", "art", "arts", "inc", "apdo", "av", "avda",
    "cía", "s.a", "s.l", "ej", "p.ej", "aprox", "tel", "máx", "mín", "gral",
    "st", "sta", "sto", "d", "dña", " Excmo", "ilmo",
    # Inglés
    "mr", "mrs", "ms", "jr", "sr", "vs", "etc", "e.g", "i.e", "cf", "al",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
    "nov", "dec", "st", "ave", "blvd", "rd", "mt", "ft", "gen", "col", "lt",
    "sgt", "capt", "cmdr", "gov", "pres", "rev", "hon", "esq", "no", "nos",
}

SENTENCE_SPLIT_REGEX = re.compile(
    r'(?<=[.!?…»”"\')])\s+(?=[¡¿«“"\'(\[]*[A-ZÁÉÍÓÚÜÑ0-9—–-])'
)


def split_into_sentences(text: str) -> List[str]:
    """
    Divide un párrafo en oraciones respetando abreviaturas en español e inglés,
    signos de interrogación/exclamación de apertura (¿¡) y diálogos con raya (—).
    """
    cleaned = re.sub(r"\s+", " ", text).strip()
    if not cleaned:
        return []

    raw_parts = SENTENCE_SPLIT_REGEX.split(cleaned)
    sentences: List[str] = []
    buffer = ""

    for part in raw_parts:
        part = part.strip()
        if not part:
            continue

        if buffer:
            candidate = f"{buffer} {part}"
        else:
            candidate = part

        # Comprobar si termina en una abreviatura conocida (ej. "Sr.", "Dr.", "Mr.")
        words = candidate.rstrip(".!?").rsplit(" ", 1)
        last_word = words[-1].lower().strip("«»“”\"'()[]") if words else ""

        if (
            candidate.endswith(".")
            and not candidate.endswith("...")
            and (last_word in ABBREVIATIONS or (len(last_word) == 1 and last_word.isalpha()))
        ):
            buffer = candidate
            continue

        sentences.append(candidate)
        buffer = ""

    if buffer:
        if sentences:
            sentences[-1] = f"{sentences[-1]} {buffer}"
        else:
            sentences.append(buffer)

    # Subdividir frases excesivamente largas (> 350 caracteres) por punto y coma o dos puntos
    final_sentences: List[str] = []
    for sent in sentences:
        if len(sent) > 350 and (";" in sent or ": " in sent):
            sub_parts = re.split(r"(?<=[;:])\s+", sent)
            chunk = ""
            for sp in sub_parts:
                if len(chunk) + len(sp) < 280:
                    chunk = f"{chunk} {sp}".strip() if chunk else sp
                else:
                    if chunk:
                        final_sentences.append(chunk)
                    chunk = sp
            if chunk:
                final_sentences.append(chunk)
        else:
            final_sentences.append(sent)

    return [s for s in final_sentences if any(c.isalnum() for c in s)]


def normalize_lang(raw_lang: Optional[str]) -> str:
    """Normaliza el código de idioma del EPUB a 'es-ES' o 'en-US' / 'en-GB'."""
    if not raw_lang:
        return "es-ES"
    lang = raw_lang.strip().lower().replace("_", "-")
    if lang.startswith("es"):
        return "es-ES"
    if lang.startswith("en-gb") or lang.startswith("en-uk"):
        return "en-GB"
    if lang.startswith("en"):
        return "en-US"
    return "es-ES"


class EpubParser:
    """Parser completo para archivos EPUB 2 y EPUB 3 sin dependencias frágiles."""

    def __init__(self, books_dir: Path):
        self.books_dir = books_dir
        self.books_dir.mkdir(parents=True, exist_ok=True)

    def import_epub(self, epub_bytes: bytes, filename: str) -> Dict[str, Any]:
        """Guarda y procesa un archivo EPUB, extrayendo metadatos, portada y capítulos."""
        book_id = hashlib.sha1(epub_bytes).hexdigest()[:12]
        book_folder = self.books_dir / book_id
        book_folder.mkdir(parents=True, exist_ok=True)

        epub_path = book_folder / "book.epub"
        epub_path.write_bytes(epub_bytes)

        assets_folder = book_folder / "assets"
        assets_folder.mkdir(parents=True, exist_ok=True)

        with zipfile.ZipFile(epub_path, "r") as zf:
            opf_path = self._find_opf_path(zf)
            opf_dir = posixpath.dirname(opf_path)
            opf_xml = zf.read(opf_path)
            opf_root = ET.fromstring(opf_xml)

            metadata = self._extract_metadata(opf_root, filename)
            manifest, id_to_href = self._extract_manifest(opf_root, opf_dir)
            spine_hrefs = self._extract_spine(opf_root, id_to_href)
            toc_entries, _ = self._extract_toc_entries(
                zf, opf_root, manifest, opf_dir, book_title=metadata["title"]
            )

            # Extraer imágenes y recursos para poder mostrarlos en el visor
            self._extract_images(zf, manifest, assets_folder)

            # Detectar portada
            cover_rel_path = self._extract_cover(zf, opf_root, manifest, book_folder)

            # Detectar si el EPUB ya incluye EPUB 3 Media Overlays (.smil + audio sincronizado)
            smil_by_xhtml = self._extract_smil_overlays(zf, manifest)

            chapters: List[Dict[str, Any]] = []
            chapter_title_contexts: List[Dict[str, Any]] = []
            pending_image_blocks: List[str] = []
            pending_skipped_part: str = ""
            namelist_set = set(zf.namelist())

            for idx, href in enumerate(spine_hrefs):
                resolved_href = href
                if resolved_href not in namelist_set:
                    # Intentar decodificar URL (%20, etc.)
                    decoded_href = urllib.parse.unquote(resolved_href)
                    if decoded_href in namelist_set:
                        resolved_href = decoded_href
                    else:
                        continue

                norm_href = _normalize_toc_href("", resolved_href)
                toc_entry = (
                    toc_entries.get(norm_href)
                    or toc_entries.get(norm_href.lower())
                    or toc_entries.get(_normalize_toc_href("", href))
                    or toc_entries.get(_normalize_toc_href("", href).lower())
                )

                raw_html = zf.read(resolved_href).decode("utf-8", errors="replace")
                chapter_dir = posixpath.dirname(resolved_href)
                chapter_title = toc_entry["label"] if toc_entry else None
                chapter_smil_pars = (
                    smil_by_xhtml.get(resolved_href)
                    or smil_by_xhtml.get(urllib.parse.unquote(resolved_href))
                    or smil_by_xhtml.get(f"__basename__:{posixpath.basename(resolved_href)}")
                    or smil_by_xhtml.get(f"__basename__:{posixpath.basename(urllib.parse.unquote(resolved_href))}")
                    or []
                )

                title_ctx = self._extract_html_title_context(raw_html, norm_href)
                parsed_chapter = self._parse_chapter_html(
                    raw_html=raw_html,
                    chapter_index=len(chapters),
                    chapter_dir=chapter_dir,
                    book_id=book_id,
                    fallback_title=chapter_title,
                    smil_pars=chapter_smil_pars,
                )

                # Si la página no tiene texto pero sí ilustraciones (láminas/mapas entre capítulos),
                # conservar sus imágenes adjuntándolas al capítulo contiguo sin alterar los índices.
                if parsed_chapter["sentence_count"] == 0:
                    if toc_entry and _DIVIDER_TITLE_RE.match(_strip_accents_lower(toc_entry["label"])):
                        pending_skipped_part = _normalize_heading_casing(toc_entry["label"])
                    img_soup = BeautifulSoup(parsed_chapter.get("html") or "", "html.parser")
                    imgs = img_soup.find_all("img")
                    if imgs and not (len(chapters) == 0 and idx == 0 and cover_rel_path):
                        for im in imgs:
                            pending_image_blocks.append(f'<p class="epub-image-block">{str(im)}</p>')
                    continue

                if pending_image_blocks:
                    parsed_chapter["html"] = "".join(pending_image_blocks) + (parsed_chapter.get("html") or "")
                    pending_image_blocks.clear()

                title_ctx["toc_entry"] = toc_entry
                title_ctx["inherited_skipped_part"] = pending_skipped_part
                pending_skipped_part = ""
                chapter_title_contexts.append(title_ctx)
                chapters.append(parsed_chapter)

            if pending_image_blocks and chapters:
                chapters[-1]["html"] = (chapters[-1].get("html") or "") + "".join(pending_image_blocks)
                pending_image_blocks.clear()

            # Si el EPUB tenía Media Overlays integrados, extraer y cortar directamente sus audios sin recalcular nada
            embedded_overlay_count = 0
            if smil_by_xhtml and chapters:
                embedded_overlay_count = self._extract_embedded_media_overlay_audio(
                    zf=zf,
                    book_folder=book_folder,
                    epub_path=epub_path,
                    chapters=chapters,
                )

        # Si el idioma no estaba claro en metadatos, inferirlo del texto del primer capítulo
        detected_lang = metadata["language"]
        if chapters:
            sample_text = " ".join(
                s["text"] for c in chapters[:2] for s in c["sentences"][:25]
            )
            detected_lang = self._detect_language_heuristic(sample_text, metadata["language"])

        # Resolver nombres canónicos de capítulos usando jerarquía del índice (TOC) y metadatos HTML
        self._resolve_book_chapter_titles(
            chapters=chapters,
            title_contexts=chapter_title_contexts,
            book_title=metadata["title"],
            book_lang=detected_lang,
        )

        story_chapter_count = sum(
            1
            for c in chapters
            if c.get("kind") in {"prologue", "chapter", "interlude", "epilogue"}
        ) or len(chapters)

        has_embedded_mo = embedded_overlay_count > 0
        total_words = sum(
            len((s.get("text") or "").split())
            for c in chapters
            for s in c.get("sentences", [])
        )
        estimated_pages = max(1, round(total_words / 250)) if total_words > 0 else 1
        now_ts = int(time.time())

        chapters_meta = [
            {
                "index": c["index"],
                "title": c["title"],
                "toc_title": c.get("toc_title") or c["title"],
                "part_title": c.get("part_title") or "",
                "in_toc": bool(c.get("in_toc", False)),
                "kind": c.get("kind") or "chapter",
                "sentence_count": c["sentence_count"],
            }
            for c in chapters
        ]

        book_data: Dict[str, Any] = {
            "id": book_id,
            "filename": filename,
            "title": metadata["title"],
            "author": metadata["author"],
            "language": detected_lang,
            "genre": metadata.get("genre") or "",
            "genres": metadata.get("genres") or [],
            "published_date": metadata.get("published_date") or "",
            "published_year": metadata.get("published_year"),
            "added_at": now_ts,
            "total_words": total_words,
            "estimated_pages": estimated_pages,
            "cover_url": f"/api/books/{book_id}/cover" if cover_rel_path else None,
            "chapter_count": len(chapters),
            "story_chapter_count": story_chapter_count,
            "total_sentences": sum(c["sentence_count"] for c in chapters),
            "has_imported_audiobook": has_embedded_mo,
            "has_embedded_media_overlay": has_embedded_mo,
            "embedded_media_overlay_sentences": embedded_overlay_count,
            "imported_audiobook_name": (
                "🎧 EPUB Media Overlay Original (Sincronizado)"
                if has_embedded_mo
                else None
            ),
            "_opf_enriched": True,
            "chapters": chapters_meta,
            "chapters_summary": [dict(cm) for cm in chapters_meta],
        }

        # Guardar capítulos procesados en disco
        (book_folder / "chapters.json").write_text(
            json.dumps(chapters, ensure_ascii=False), encoding="utf-8"
        )
        (book_folder / "metadata.json").write_text(
            json.dumps(book_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        return book_data

    def _find_opf_path(self, zf: zipfile.ZipFile) -> str:
        """Localiza el archivo .opf a través de META-INF/container.xml o buscando en el zip."""
        if "META-INF/container.xml" in zf.namelist():
            container_xml = zf.read("META-INF/container.xml")
            root = ET.fromstring(container_xml)
            for elem in root.iter():
                if elem.tag.endswith("rootfile") and "full-path" in elem.attrib:
                    return elem.attrib["full-path"]

        for name in zf.namelist():
            if name.lower().endswith(".opf"):
                return name
        raise ValueError("No se encontró el archivo OPF dentro del EPUB.")

    @staticmethod
    def _normalize_genre_tag(raw_tag: str) -> str:
        t = re.sub(r"\s+", " ", (raw_tag or "").strip())
        if not t or len(t) > 60:
            return ""
        low = t.lower()
        genre_map = {
            "horror": "Terror",
            "terror": "Terror",
            "ghost stories": "Terror",
            "vampires": "Terror",
            "gothic": "Terror",
            "science fiction": "Ciencia ficción",
            "sci-fi": "Ciencia ficción",
            "scifi": "Ciencia ficción",
            "ciencia ficción": "Ciencia ficción",
            "ciencia ficcion": "Ciencia ficción",
            "dystopian": "Ciencia ficción",
            "distopía": "Ciencia ficción",
            "fantasy": "Fantasía",
            "fantasía": "Fantasía",
            "fantasia": "Fantasía",
            "epic fantasy": "Fantasía",
            "mythology": "Mitología",
            "mitología": "Mitología",
            "mitologia": "Mitología",
            "historical fiction": "Novela histórica",
            "histórica": "Novela histórica",
            "historia": "Historia",
            "history": "Historia",
            "thriller": "Thriller / Misterio",
            "mystery": "Thriller / Misterio",
            "suspense": "Thriller / Misterio",
            "crime": "Novela negra",
            "detective": "Novela negra",
            "novela negra": "Novela negra",
            "adventure": "Aventura",
            "aventuras": "Aventura",
            "aventura": "Aventura",
            "romance": "Romance",
            "biography": "Biografía",
            "biografía": "Biografía",
            "philosophy": "Filosofía",
            "filosofía": "Filosofía",
            "psychology": "Psicología",
            "psicología": "Psicología",
            "classic": "Clásicos",
            "classics": "Clásicos",
            "clásicos": "Clásicos",
            "nonfiction": "Ensayo / No ficción",
            "non-fiction": "Ensayo / No ficción",
            "ensayo": "Ensayo / No ficción",
        }
        for k, v in genre_map.items():
            if low == k or k in low:
                return v
        if low in {"fiction", "ficción", "ficcion", "general", "books", "ebook", "ebooks", "spanish", "english"}:
            return ""
        return t[:1].upper() + t[1:]

    @staticmethod
    def _parse_opf_publication_date(raw_date: str) -> Tuple[str, Optional[int]]:
        s = (raw_date or "").strip()
        if not s:
            return "", None
        m = re.search(r"\b(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?", s)
        if not m:
            return "", None
        yr = int(m.group(1))
        if yr <= 1050 or yr > 2100:
            # Fechas ficticias de Calibre como 0101-01-01
            return "", None
        mo = m.group(2)
        dy = m.group(3)
        if mo and dy:
            return f"{yr:04d}-{mo}-{dy}", yr
        if mo:
            return f"{yr:04d}-{mo}", yr
        return f"{yr:04d}", yr

    def _extract_metadata(self, opf_root: ET.Element, fallback_filename: str) -> Dict[str, Any]:
        title = ""
        author = ""
        language = ""
        raw_subjects: List[str] = []
        published_date = ""
        published_year: Optional[int] = None

        for elem in opf_root.iter():
            tag = elem.tag.split("}")[-1].lower()
            text = (elem.text or "").strip()
            if not text:
                continue
            if tag == "title" and not title:
                title = text
            elif tag == "creator" and not author:
                author = text
            elif tag == "language" and not language:
                language = text
            elif tag == "subject":
                for part in re.split(r"[,;/|]+", text):
                    norm_g = self._normalize_genre_tag(part)
                    if norm_g and norm_g not in raw_subjects:
                        raw_subjects.append(norm_g)
            elif tag == "date" and not published_date:
                p_date, p_yr = self._parse_opf_publication_date(text)
                if p_date:
                    published_date = p_date
                    published_year = p_yr
            elif tag == "meta" and not published_date:
                prop = (elem.attrib.get("property") or elem.attrib.get("name") or "").lower()
                if "issued" in prop or "publication" in prop or "date" in prop:
                    val = text or elem.attrib.get("content", "")
                    p_date, p_yr = self._parse_opf_publication_date(val)
                    if p_date:
                        published_date = p_date
                        published_year = p_yr

        if not title:
            title = Path(fallback_filename).stem.replace("_", " ").replace("-", " ")
        if not author:
            author = "Autor desconocido"

        return {
            "title": title,
            "author": author,
            "language": normalize_lang(language),
            "genres": raw_subjects,
            "genre": raw_subjects[0] if raw_subjects else "",
            "published_date": published_date,
            "published_year": published_year,
        }

    def extract_opf_extended_meta_from_epub_file(self, epub_path: Path) -> Dict[str, Any]:
        """Extrae géneros (<dc:subject>) y fecha de publicación (<dc:date>) de un book.epub ya existente."""
        if not epub_path.exists():
            return {}
        try:
            with zipfile.ZipFile(epub_path, "r") as zf:
                opf_path = self._find_opf_path(zf)
                opf_root = ET.fromstring(zf.read(opf_path))
                meta = self._extract_metadata(opf_root, epub_path.name)
                return {
                    "genres": meta.get("genres") or [],
                    "genre": meta.get("genre") or "",
                    "published_date": meta.get("published_date") or "",
                    "published_year": meta.get("published_year"),
                }
        except Exception:
            return {}

    def _extract_manifest(
        self, opf_root: ET.Element, opf_dir: str
    ) -> Tuple[Dict[str, Dict[str, str]], Dict[str, str]]:
        manifest: Dict[str, Dict[str, str]] = {}
        id_to_href: Dict[str, str] = {}

        for elem in opf_root.iter():
            if elem.tag.split("}")[-1].lower() == "item":
                item_id = elem.attrib.get("id", "")
                href = elem.attrib.get("href", "")
                media_type = elem.attrib.get("media-type", "")
                props = elem.attrib.get("properties", "")
                if item_id and href:
                    full_href = posixpath.normpath(posixpath.join(opf_dir, href)) if opf_dir else href
                    manifest[item_id] = {
                        "id": item_id,
                        "href": full_href,
                        "raw_href": href,
                        "media_type": media_type,
                        "properties": props,
                    }
                    id_to_href[item_id] = full_href

        return manifest, id_to_href

    def _extract_spine(self, opf_root: ET.Element, id_to_href: Dict[str, str]) -> List[str]:
        spine_hrefs: List[str] = []
        for elem in opf_root.iter():
            if elem.tag.split("}")[-1].lower() == "itemref":
                idref = elem.attrib.get("idref", "")
                if idref in id_to_href:
                    spine_hrefs.append(id_to_href[idref])
        return spine_hrefs

    def _extract_toc(
        self,
        zf: zipfile.ZipFile,
        opf_root: ET.Element,
        manifest: Dict[str, Dict[str, str]],
        opf_dir: str,
        book_title: str = "",
    ) -> Dict[str, str]:
        """Compatibilidad: devuelve mapa plano href -> etiqueta del índice."""
        toc_entries, _ = self._extract_toc_entries(zf, opf_root, manifest, opf_dir, book_title=book_title)
        return {k: v["label"] for k, v in toc_entries.items()}

    def _extract_toc_entries(
        self,
        zf: zipfile.ZipFile,
        opf_root: ET.Element,
        manifest: Dict[str, Dict[str, str]],
        opf_dir: str,
        book_title: str = "",
    ) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Extrae el índice jerárquico del EPUB (EPUB 3 nav + EPUB 2 NCX) preservando
        los ancestros (Partes / Libros) y normalizando URL encoding (%20, rutas relativas).
        """
        toc_by_href: Dict[str, Dict[str, Any]] = {}
        ordered_entries: List[Dict[str, Any]] = []
        namelist_set = set(zf.namelist())
        norm_book_title = _strip_accents_lower(book_title)
        wrapper_skip = {
            "cover", "cubierta", "portada", "contents", "table of contents",
            "indice", "sumario", "title page", "portadilla",
        }
        if norm_book_title:
            wrapper_skip.add(norm_book_title)

        def clean_ancestors(raw_ancs: List[str]) -> List[str]:
            out: List[str] = []
            for a in raw_ancs:
                ca = _clean_heading_text(a)
                na = _strip_accents_lower(ca)
                if not ca or na in wrapper_skip:
                    continue
                if norm_book_title and len(norm_book_title) >= 4 and na == norm_book_title:
                    continue
                out.append(ca)
            return out

        def register_entry(norm_href: str, label: str, ancestors: List[str], depth: int) -> None:
            clean_lbl = _clean_heading_text(label)
            if not clean_lbl or not norm_href:
                return
            clean_ancs = clean_ancestors(ancestors)
            entry = {
                "label": clean_lbl,
                "ancestors": clean_ancs,
                "depth": len(clean_ancs),
                "order": len(ordered_entries),
                "href": norm_href,
            }
            ordered_entries.append(entry)
            low_key = norm_href.lower()
            existing = toc_by_href.get(norm_href) or toc_by_href.get(low_key)
            if existing is None:
                toc_by_href[norm_href] = entry
                toc_by_href[low_key] = entry
            elif not existing.get("ancestors") and clean_ancs:
                # Enriquecer con jerarquía si la primera fuente (ej. nav plano) no la tenía
                existing["ancestors"] = clean_ancs
                existing["depth"] = len(clean_ancs)

        def resolve_zip_member(raw_path: str) -> Optional[str]:
            if raw_path in namelist_set:
                return raw_path
            unq = urllib.parse.unquote(raw_path)
            if unq in namelist_set:
                return unq
            return None

        # 1. EPUB 3 Nav Document (sólo <nav epub:type="toc"> / role="doc-toc", ignorando landmarks)
        for item in manifest.values():
            if "nav" in item.get("properties", "").split():
                nav_member = resolve_zip_member(item["href"])
                if not nav_member:
                    continue
                nav_dir = posixpath.dirname(nav_member)
                try:
                    soup = BeautifulSoup(zf.read(nav_member), "html.parser")
                except Exception:
                    continue
                navs = soup.find_all("nav")
                toc_nav = None
                for nv in navs:
                    attrs_low = {str(k).lower(): str(v).lower() for k, v in nv.attrs.items()}
                    etype = attrs_low.get("epub:type") or attrs_low.get("type") or ""
                    role = attrs_low.get("role") or ""
                    if "toc" in etype.split() or role == "doc-toc":
                        toc_nav = nv
                        break
                if toc_nav is None:
                    for nv in navs:
                        attrs_low = {str(k).lower(): str(v).lower() for k, v in nv.attrs.items()}
                        etype = attrs_low.get("epub:type") or attrs_low.get("type") or ""
                        if not any(bad in etype for bad in ("landmarks", "page-list", "loi", "lot")):
                            toc_nav = nv
                            break

                if toc_nav is not None:
                    def walk_ol(ol_tag: Tag, ancestors: List[str], depth: int) -> None:
                        for li in ol_tag.find_all("li", recursive=False):
                            direct_a = li.find("a", href=True, recursive=False)
                            direct_span = li.find("span", recursive=False)
                            label_el = direct_a or direct_span
                            if label_el is None:
                                # Algunos nav envuelven <a> dentro de un <div>/<p> antes del <ol>
                                for ch in li.children:
                                    if isinstance(ch, Tag) and ch.name not in ("ol", "ul"):
                                        sub_a = ch.find("a", href=True) if ch.name != "a" else ch
                                        if sub_a:
                                            direct_a = sub_a
                                            label_el = sub_a
                                            break
                                        if _extract_clean_element_text(ch):
                                            label_el = ch
                                            break
                            lbl = _extract_clean_element_text(label_el) if label_el is not None else ""
                            if direct_a and direct_a.get("href"):
                                norm_target = _normalize_toc_href(nav_dir, str(direct_a["href"]))
                                register_entry(norm_target, lbl, ancestors, depth)
                            next_ancs = ancestors + ([lbl] if lbl else [])
                            for sub_ol in li.find_all(["ol", "ul"], recursive=False):
                                walk_ol(sub_ol, next_ancs, depth + 1)

                    for top_ol in toc_nav.find_all(["ol", "ul"], recursive=False):
                        walk_ol(top_ol, [], 0)

        # 2. EPUB 2 NCX (<navMap> recursivo respetando sólo hijos directos <navPoint>)
        for item in manifest.values():
            if "ncx" in item.get("media_type", "").lower() or item["href"].lower().endswith(".ncx"):
                ncx_member = resolve_zip_member(item["href"])
                if not ncx_member:
                    continue
                ncx_dir = posixpath.dirname(ncx_member)
                try:
                    ncx_root = ET.fromstring(zf.read(ncx_member))
                except Exception:
                    continue

                nav_map = None
                for el in ncx_root.iter():
                    if el.tag.split("}")[-1].lower() == "navmap":
                        nav_map = el
                        break
                if nav_map is None:
                    continue

                def walk_navpoints(parent_el: ET.Element, ancestors: List[str], depth: int) -> None:
                    for child in list(parent_el):
                        if child.tag.split("}")[-1].lower() != "navpoint":
                            continue
                        label = ""
                        src = ""
                        for sub in list(child):
                            stag = sub.tag.split("}")[-1].lower()
                            if stag == "navlabel" and not label:
                                for txt_el in list(sub):
                                    if txt_el.tag.split("}")[-1].lower() == "text":
                                        label = _clean_heading_text("".join(txt_el.itertext()))
                                        if label:
                                            break
                            elif stag == "content" and "src" in sub.attrib and not src:
                                src = sub.attrib["src"]
                        if label and src:
                            norm_target = _normalize_toc_href(ncx_dir, src)
                            register_entry(norm_target, label, ancestors, depth)
                        next_ancs = ancestors + ([label] if label else [])
                        walk_navpoints(child, next_ancs, depth + 1)

                walk_navpoints(nav_map, [], 0)

        return toc_by_href, ordered_entries

    def _extract_html_title_context(self, raw_html: str, norm_href: str) -> Dict[str, Any]:
        """Extrae señales semánticas del HTML (epub:type, encabezados iniciales, bloques iniciales) sin modificar el texto."""
        soup = BeautifulSoup(raw_html, "html.parser")
        for tag in soup(["script", "style", "head", "meta", "link", "noscript"]):
            tag.decompose()
        body = soup.find("body") or soup

        epub_types: set = set()

        def collect_types(el: Optional[Tag]) -> None:
            if not isinstance(el, Tag):
                return
            for k, v in el.attrs.items():
                kl = str(k).lower()
                if kl.endswith("type") or kl == "role":
                    vals = v if isinstance(v, list) else str(v).split()
                    for tok in vals:
                        t = tok.strip().lower()
                        if t:
                            epub_types.add(t)

        collect_types(body)
        for ch in body.find_all(["section", "div", "article"], recursive=False):
            collect_types(ch)

        heading_tags = {"h1", "h2", "h3", "h4", "h5", "h6"}
        block_tags = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li", "dt", "dd"}

        def has_nested_block(el: Tag) -> bool:
            return any(c.name in block_tags for c in el.find_all(block_tags))

        top_headings: List[str] = []
        lead_blocks: List[Tuple[str, str]] = []
        chars_before_heading = 0
        first_text_parts: List[str] = []
        first_text_len = 0

        for el in body.find_all(list(block_tags) + ["div", "section", "article"]):
            is_leaf_block = (el.name in block_tags and not has_nested_block(el)) or (
                el.name in {"div", "section", "article"}
                and not el.find(list(block_tags) + ["div", "section", "article"])
            )
            if not is_leaf_block:
                continue
            txt = _extract_clean_element_text(el)
            if not txt:
                continue
            if len(lead_blocks) < 4:
                lead_blocks.append((el.name, txt[:220]))
            if first_text_len < 320:
                first_text_parts.append(txt[:320])
                first_text_len += len(txt) + 1
            if el.name in heading_tags:
                if chars_before_heading < 220 and len(top_headings) < 2 and len(txt) <= 110:
                    top_headings.append(txt)
            else:
                chars_before_heading += len(txt)

        return {
            "href": norm_href,
            "stem": Path(norm_href).stem.lower(),
            "epub_types": sorted(epub_types),
            "top_headings": top_headings,
            "lead_blocks": lead_blocks,
            "first_text": " ".join(first_text_parts)[:350],
        }

    @staticmethod
    def _kw_in_norm(norm_text: str, keywords: Tuple[str, ...]) -> bool:
        for kw in keywords:
            if kw in {"notes", "notas", "nota", "cita", "citas", "copy"}:
                if norm_text == kw or norm_text.startswith(f"{kw} ") or norm_text.endswith(f" {kw}"):
                    return True
            elif re.search(rf"(?<![a-z0-9]){re.escape(kw)}(?![a-z0-9])", norm_text):
                return True
        return False

    def _classify_chapter_kind(
        self,
        label: str,
        epub_types: List[str],
        sentence_count: int,
        position_ratio: float,
        has_started_story: bool,
        first_text: str,
        book_title: str,
    ) -> str:
        norm = _strip_accents_lower(label)
        etypes = set(epub_types or [])
        norm_book = _strip_accents_lower(book_title)
        norm_book_base = _strip_accents_lower(re.sub(r"\s*\([^)]*\)\s*$", "", str(book_title or "")))
        first_low = _strip_accents_lower(first_text)

        if etypes & {"prologue"} or re.match(r"^(?:prologue|prologo)\b", norm):
            return "prologue"
        if etypes & {"epilogue"} or re.match(r"^(?:epilogue|epilogo)\b", norm):
            return "epilogue"
        if re.search(r"\b(?:interlude|interludio)\b", norm):
            return "interlude"
        if etypes & {"part", "division"} and sentence_count <= 12:
            return "divider"
        if _DIVIDER_TITLE_RE.match(norm) and sentence_count <= 12:
            return "divider"

        if etypes & {"epigraph"} and sentence_count <= 12:
            return "divider" if has_started_story else "front_matter"
        if etypes & {"cover", "titlepage", "halftitlepage", "dedication", "toc", "frontmatter"}:
            return "front_matter"
        if etypes & {"copyright-page", "imprint", "colophon"}:
            return "front_matter" if position_ratio < 0.5 else "back_matter"
        if etypes & {"acknowledgments", "afterword", "bibliography", "glossary", "index", "notes", "endnotes", "rearnotes", "backmatter"}:
            return "back_matter"

        if norm in {"epigraph", "epigrafe", "cita", "citas"} or norm.startswith(("epigraph ", "epigrafe ")):
            return "divider" if has_started_story else "front_matter"

        if norm == "copy" and sentence_count <= 25:
            return "front_matter" if position_ratio < 0.5 else "back_matter"

        if sentence_count <= 15 and (
            (norm_book and norm == norm_book)
            or (norm_book_base and len(norm_book_base) >= 4 and norm == norm_book_base)
        ):
            return "front_matter"

        if self._kw_in_norm(norm, _BACK_MATTER_TITLE_KW):
            if position_ratio >= 0.65 or sentence_count <= 45 or any(
                strong in norm
                for strong in (
                    "about the author", "sobre el autor", "about the publisher", "sobre la editorial",
                    "acknowledgment", "acknowledgement", "agradecimiento", "praise", "other works", "also by",
                    "mailing list", "patreon", "nota del autor", "author's note", "authors note",
                    "bookperk", "proxima lectura", "facebook group", "material adicional",
                )
            ):
                return "back_matter"

        if self._kw_in_norm(norm, _FRONT_MATTER_TITLE_KW):
            return "back_matter" if position_ratio >= 0.72 and has_started_story else "front_matter"

        if sentence_count <= 20 and any(
            promo in first_low
            for promo in (
                "gracias por adquirir", "thank you for purchasing", "planetadelibros",
                "todos los derechos reservados", "all rights reserved",
                "no se permite la reproduccion", "primera edicion", "first edition",
            )
        ):
            return "front_matter" if position_ratio < 0.5 else "back_matter"

        return "chapter"

    def _resolve_book_chapter_titles(
        self,
        chapters: List[Dict[str, Any]],
        title_contexts: List[Dict[str, Any]],
        book_title: str,
        book_lang: str,
    ) -> None:
        """
        Asigna a cada capítulo un nombre canónico claro y coherente basado en el índice (TOC)
        del libro, su jerarquía de Partes/Libros y señales semánticas del HTML, sin usar nunca
        el índice interno de spine como falso 'Capítulo N'.
        """
        total = len(chapters)
        if total == 0:
            return

        is_en = str(book_lang or "").lower().startswith("en")
        norm_book = _strip_accents_lower(book_title)

        def loc(en_txt: str, es_txt: str) -> str:
            return en_txt if is_en else es_txt

        def combine_top_headings(headings: List[str]) -> str:
            if not headings:
                return ""
            h0 = _normalize_heading_casing(headings[0])
            if len(headings) >= 2:
                h1 = _normalize_heading_casing(headings[1])
                if (
                    h1
                    and len(h1) <= 55
                    and _strip_accents_lower(h1) != _strip_accents_lower(h0)
                    and not h1.startswith(("“", "\"", "'", "«"))
                    and not re.search(r"[.!?]$", h1)
                ):
                    if _DIVIDER_TITLE_RE.match(_strip_accents_lower(h0)) or re.match(
                        r"^(?:chapter|capitulo|primer|segundo|tercer|cuarto|first|second|third|fourth|interlude|interludio)\b",
                        _strip_accents_lower(h0),
                    ):
                        return f"{h0}: {h1}"
            return h0

        def detect_semantic_non_toc_title(
            ctx: Dict[str, Any],
            sentence_count: int,
            pos_ratio: float,
            prev_kind: str,
            active_part: str,
        ) -> Tuple[str, str]:
            """Devuelve (titulo, kind_hint) si el archivo sin TOC es claramente front/back/epígrafe."""
            etypes = set(ctx.get("epub_types") or [])
            stem = ctx.get("stem") or ""
            first_low = _strip_accents_lower(ctx.get("first_text") or "")

            # 1. epub:type explícito
            if "dedication" in etypes:
                return loc("Dedication", "Dedicatoria"), "front_matter"
            if "epigraph" in etypes:
                return loc("Epigraph", "Epígrafe"), ("divider" if pos_ratio > 0.12 and active_part else "front_matter")
            if etypes & {"copyright-page", "imprint", "colophon"}:
                return loc("Copyright", "Créditos"), ("front_matter" if pos_ratio < 0.5 else "back_matter")
            if etypes & {"titlepage", "halftitlepage"}:
                return loc("Title Page", "Portadilla"), "front_matter"
            if "toc" in etypes:
                return loc("Table of Contents", "Índice"), "front_matter"
            if "acknowledgments" in etypes:
                return loc("Acknowledgments", "Agradecimientos"), "back_matter"

            # 2. Epígrafe / cita justo después de una portadilla de Parte (ej. The Exorcist Part002a.html)
            if prev_kind == "divider" and active_part and sentence_count <= 10:
                return loc("Epigraph", "Epígrafe"), "divider"

            # 3. Nombre de archivo semántico
            if re.search(r"(?:sinopsis|synopsis|blurb)", stem):
                return loc("Synopsis", "Sinopsis"), "front_matter"
            if re.search(r"(?:^ded(?:ic|_|-|\d|$)|dedicat)", stem):
                return loc("Dedication", "Dedicatoria"), "front_matter"
            if re.search(r"(?:epigraph|epigrafe|cita|quote|motto)", stem):
                return loc("Epigraph", "Epígrafe"), ("divider" if active_part else "front_matter")
            if re.match(r"^intro\d*$", stem):
                if sentence_count <= 16:
                    return loc("Epigraph", "Epígrafe"), "front_matter"
                return loc("Introduction", "Introducción"), "front_matter"
            if re.search(r"(?:copyright|credit|colofon|colophon|legal|imprint)", stem):
                return loc("Copyright", "Créditos"), ("front_matter" if pos_ratio < 0.5 else "back_matter")
            if re.search(r"(?:title|titulo|portada|cubierta|cover)", stem) and sentence_count <= 15:
                return loc("Title Page", "Portadilla"), "front_matter"
            if re.search(r"(?:^toc$|indice|contents)", stem):
                return loc("Table of Contents", "Índice"), "front_matter"
            if re.search(r"(?:acknowl|agradec)", stem):
                return loc("Acknowledgments", "Agradecimientos"), "back_matter"
            if re.search(r"(?:about.*author|sobre.*autor|bio)", stem):
                return loc("About the Author", "Sobre el Autor"), "back_matter"

            # 4. Texto editorial / legal (ej. Planetadelibros, copyright, ISBN)
            if sentence_count <= 20 and any(
                kw in first_low
                for kw in (
                    "gracias por adquirir", "thank you for purchasing", "planetadelibros",
                    "todos los derechos reservados", "all rights reserved",
                    "no se permite la reproduccion", "isbn", "primera edicion", "first edition",
                    "titulo original", "first published",
                )
            ):
                if any(k in first_low for k in ("isbn", "todos los derechos", "all rights reserved", "copyright", "primera edicion")):
                    return loc("Copyright", "Créditos"), ("front_matter" if pos_ratio < 0.5 else "back_matter")
                return loc("Publisher Info", "Información Editorial"), ("front_matter" if pos_ratio < 0.5 else "back_matter")

            return "", ""

        resolved: List[Dict[str, Any]] = []
        active_part = ""
        has_started_story = False
        fallback_chapter_num = 0

        for idx, (ch, ctx) in enumerate(zip(chapters, title_contexts)):
            sc = int(ch.get("sentence_count", 0))
            pos_ratio = idx / max(1, total - 1)
            toc_entry = ctx.get("toc_entry")
            inherited_part = ctx.get("inherited_skipped_part") or ""
            top_headings = ctx.get("top_headings") or []
            lead_blocks = ctx.get("lead_blocks") or []
            prev_item = resolved[-1] if resolved else None
            prev_kind = prev_item["kind"] if prev_item else ""

            if inherited_part:
                active_part = inherited_part

            base_title = ""
            part_title = ""
            in_toc = False
            kind_hint = ""

            # Prioridad 1: Entrada directa en el índice (TOC) del EPUB
            if toc_entry:
                in_toc = True
                raw_toc = toc_entry["label"]
                ancestors = toc_entry.get("ancestors") or []
                clean_toc = _normalize_heading_casing(raw_toc)

                # Caso Calibre "(texto)": ej. "LAS ZARZAS (texto)" que encabeza una Parte y contiene el primer capítulo ("UNO")
                m_texto = re.match(r"^(.+?)\s*\(texto\)\s*$", raw_toc, re.I)
                if m_texto:
                    section_name = _normalize_heading_casing(m_texto.group(1))
                    if inherited_part and _strip_accents_lower(inherited_part) != _strip_accents_lower(section_name):
                        active_part = f"{inherited_part}: {section_name}"
                    else:
                        active_part = section_name
                    next_is_non_toc_sibling = (
                        idx + 1 < total and title_contexts[idx + 1].get("toc_entry") is None
                    )
                    lead_txt = lead_blocks[0][1] if lead_blocks else ""
                    if next_is_non_toc_sibling and lead_txt and _is_standalone_chapter_lead(lead_txt):
                        base_title = _normalize_heading_casing(lead_txt)
                        part_title = active_part
                    else:
                        base_title = section_name
                        part_title = inherited_part if inherited_part and _strip_accents_lower(inherited_part) != _strip_accents_lower(section_name) else ""
                else:
                    if ancestors:
                        active_part = _normalize_heading_casing(ancestors[-1])
                        part_title = active_part
                    else:
                        if _DIVIDER_TITLE_RE.match(_strip_accents_lower(clean_toc)) and sc <= 12:
                            active_part = clean_toc
                            part_title = ""
                        elif re.match(r"^(?:epilogue|epilogo)\b", _strip_accents_lower(clean_toc)):
                            active_part = ""
                            part_title = ""
                        else:
                            # Entrada de primer nivel que no es parte ni subcapítulo: limpia active_part
                            active_part = ""
                            part_title = ""

                    # Evitar que la portadilla tenga literalmente el título del libro como si fuera capítulo
                    norm_book_base = _strip_accents_lower(re.sub(r"\s*\([^)]*\)\s*$", "", str(book_title or "")))
                    if sc <= 15 and pos_ratio < 0.25 and (
                        (norm_book and _strip_accents_lower(clean_toc) == norm_book)
                        or (norm_book_base and len(norm_book_base) >= 4 and _strip_accents_lower(clean_toc) == norm_book_base)
                    ):
                        base_title = loc("Title Page", "Portadilla")
                        kind_hint = "front_matter"
                    else:
                        base_title = clean_toc

            # Prioridad 2: Continuación de una portadilla corta de TOC (ej. Epílogo 1 frase + 409 frases, o Material adicional 2 frases + 514 frases)
            if (
                not base_title
                and prev_item is not None
                and prev_item["in_toc"]
                and prev_item["sentence_count"] <= 3
                and prev_item["kind"] in {"prologue", "epilogue", "interlude", "chapter", "back_matter"}
                and not _DIVIDER_TITLE_RE.match(_strip_accents_lower(prev_item["base_title"]))
                and sc >= 15
            ):
                candidate_h = combine_top_headings(top_headings)
                if not candidate_h or _strip_accents_lower(candidate_h) == _strip_accents_lower(prev_item["base_title"]):
                    base_title = prev_item["base_title"]
                    part_title = prev_item["part_title"]
                    kind_hint = prev_item["kind"]
                    in_toc = True
                    prev_item["base_title"] = f"{prev_item['base_title']} ({loc('Title Page', 'portadilla')})"
                    prev_item["kind"] = "divider"

            # Prioridad 3: Encabezado HTML h1-h6 al inicio del archivo (antes de la prosa)
            if not base_title and top_headings:
                cand = combine_top_headings(top_headings)
                if cand:
                    if norm_book and _strip_accents_lower(cand) == norm_book and sc <= 15 and pos_ratio < 0.25:
                        base_title = loc("Title Page", "Portadilla")
                        kind_hint = "front_matter"
                    else:
                        base_title = cand
                        if active_part and not _DIVIDER_TITLE_RE.match(_strip_accents_lower(cand)):
                            part_title = active_part

            # Prioridad 4: Encabezado de capítulo en <p> al principio del archivo (ej. REY DOLOR: UNO, 15:55 (EST), 1, PRIMER INTERLUDIO, Dragonora en punto)
            if not base_title and lead_blocks:
                b0_txt = lead_blocks[0][1]
                is_short_title_lead = (
                    sc >= 15
                    and len(lead_blocks) >= 2
                    and 2 <= len(b0_txt) <= 36
                    and 1 <= len(b0_txt.split()) <= 5
                    and not re.search(r"[.!?…,:;]$", b0_txt)
                    and not b0_txt.startswith(("—", "–", "-", "\"", "“", "«", "'"))
                    and (len(lead_blocks[1][1]) >= 40 or re.search(r"[.!?…]$", lead_blocks[1][1]))
                    and bool(active_part)
                )
                if _is_standalone_chapter_lead(b0_txt) or is_short_title_lead:
                    h0 = _normalize_heading_casing(b0_txt)
                    # Combinar 2ª línea si es subtítulo de interludio/parte/capítulo (ej. PRIMER INTERLUDIO + GWEN, PISOTEADA)
                    if len(lead_blocks) >= 2:
                        b1_txt = lead_blocks[1][1]
                        if (
                            re.match(r"^(?:primer|segundo|tercer|cuarto|first|second|third|fourth|interlude|interludio|part|parte|book|libro)\b", _strip_accents_lower(h0))
                            and len(b1_txt) <= 48
                            and not re.search(r"[.!?]$", b1_txt)
                            and len(b1_txt.split()) <= 6
                        ):
                            h1 = _normalize_heading_casing(b1_txt)
                            if h1 and _strip_accents_lower(h1) != _strip_accents_lower(h0):
                                h0 = f"{h0}: {h1}"
                    base_title = h0
                    if _DIVIDER_TITLE_RE.match(_strip_accents_lower(base_title)) and sc <= 12:
                        active_part = base_title
                        part_title = ""
                    elif active_part:
                        part_title = active_part

            # Prioridad 5: Detección semántica de front/back matter y epígrafes sin TOC
            if not base_title:
                sem_title, sem_kind = detect_semantic_non_toc_title(
                    ctx=ctx,
                    sentence_count=sc,
                    pos_ratio=pos_ratio,
                    prev_kind=prev_kind,
                    active_part=active_part,
                )
                if sem_title:
                    base_title = sem_title
                    kind_hint = sem_kind
                    if sem_kind == "divider" and active_part:
                        part_title = active_part

            # Prioridad 6: Fallback limpio sin inventar spine index como 'Capítulo N'
            if not base_title:
                if not has_started_story and sc <= 15:
                    base_title = loc("Front Matter", "Preliminar")
                    kind_hint = "front_matter"
                elif has_started_story and prev_kind == "back_matter" and sc <= 20:
                    base_title = loc("Back Matter", "Anexo")
                    kind_hint = "back_matter"
                elif has_started_story and pos_ratio > 0.85 and prev_kind in {"back_matter", "epilogue"} and sc >= 30:
                    # Relato extra / continuación al final del libro (ej. anexo narrativo sin título en TOC)
                    base_title = loc("Bonus Chapter", "Anexo Narrativo")
                    kind_hint = "back_matter"
                else:
                    fallback_chapter_num += 1
                    base_title = f"{loc('Chapter', 'Capítulo')} {fallback_chapter_num}"
                    kind_hint = "chapter"
                    if active_part:
                        part_title = active_part

            # Quitar punto final suelto en números puros ("1." -> "1", "27." -> "27")
            if re.match(r"^\d{1,3}\.$", base_title):
                base_title = base_title[:-1]

            kind = kind_hint or self._classify_chapter_kind(
                label=base_title,
                epub_types=ctx.get("epub_types") or [],
                sentence_count=sc,
                position_ratio=pos_ratio,
                has_started_story=has_started_story,
                first_text=ctx.get("first_text") or "",
                book_title=book_title,
            )

            # Si el capítulo pertenece a "Epilogue" / "Epílogo" como parte padre (ej. King Sorrow Epilogue · 1..12)
            if part_title and re.match(r"^(?:epilogue|epilogo)\b", _strip_accents_lower(part_title)) and kind == "chapter":
                kind = "epilogue"

            if kind in {"prologue", "chapter", "interlude", "epilogue"}:
                has_started_story = True
            if kind == "back_matter":
                active_part = ""

            resolved.append(
                {
                    "base_title": base_title,
                    "part_title": part_title,
                    "in_toc": in_toc,
                    "kind": kind,
                    "sentence_count": sc,
                    "top_headings": top_headings,
                }
            )

        # Post-paso 1: Reparar erratas consecutivas del NCX donde el editor repitió el mismo número (ej. dos "Capítulo 75")
        def _extract_bare_num(txt: str) -> str:
            m = re.search(r"\b(\d{1,3})\b", _strip_accents_lower(txt))
            return m.group(1) if m else ""

        for i in range(1, total):
            cur = resolved[i]
            prv = resolved[i - 1]
            if (
                cur["kind"] == "chapter"
                and prv["kind"] == "chapter"
                and _strip_accents_lower(cur["base_title"]) == _strip_accents_lower(prv["base_title"])
                and _strip_accents_lower(cur["part_title"]) == _strip_accents_lower(prv["part_title"])
            ):
                base_num = _extract_bare_num(cur["base_title"])
                if cur["top_headings"]:
                    alt_cur = _normalize_heading_casing(cur["top_headings"][0])
                    alt_num = _extract_bare_num(alt_cur)
                    if alt_cur and _strip_accents_lower(alt_cur) != _strip_accents_lower(cur["base_title"]) and (not base_num or alt_num != base_num):
                        cur["base_title"] = alt_cur
                        continue
                if prv["top_headings"]:
                    alt_prv = _normalize_heading_casing(prv["top_headings"][0])
                    alt_num = _extract_bare_num(alt_prv)
                    if alt_prv and _strip_accents_lower(alt_prv) != _strip_accents_lower(prv["base_title"]) and (not base_num or alt_num != base_num):
                        prv["base_title"] = alt_prv

        # Post-paso 2: Detectar qué partes necesitan prefijo para desambiguar títulos repetidos entre partes
        # (ej. Part I..IV -> Chapter One; Book Three..Epilogue -> 1..12)
        base_to_parts: Dict[str, set] = {}
        base_global_counts: Dict[str, int] = {}
        for item in resolved:
            bn = _strip_accents_lower(item["base_title"])
            base_global_counts[bn] = base_global_counts.get(bn, 0) + 1
            pt = item["part_title"]
            if not pt:
                continue
            base_to_parts.setdefault(bn, set()).add(_strip_accents_lower(pt))

        parts_needing_prefix: set = set()
        for bn, part_set in base_to_parts.items():
            if len(part_set) > 1:
                parts_needing_prefix.update(part_set)

        # También prefijar epígrafes internos de cada Parte (ej. Part II · Epigraph)
        for item in resolved:
            pt = item["part_title"]
            if not pt:
                continue
            pt_norm = _strip_accents_lower(pt)
            if item["kind"] == "divider" and _strip_accents_lower(item["base_title"]) in {"epigraph", "epigrafe"}:
                parts_needing_prefix.add(pt_norm)

        # Construir título canónico + toc_title
        for item in resolved:
            base = item["base_title"]
            pt = item["part_title"]
            item["toc_title"] = base
            # Los interludios ya nombrados (ej. "Third Interlude: ...") son únicos por sí mismos
            is_unique_interlude = (
                item["kind"] == "interlude" and base_global_counts.get(_strip_accents_lower(base), 0) == 1
            )
            if pt and _strip_accents_lower(pt) in parts_needing_prefix and not is_unique_interlude:
                short_pt = _shorten_part_prefix(pt)
                if short_pt and not _strip_accents_lower(base).startswith(_strip_accents_lower(short_pt)):
                    item["canonical_title"] = f"{short_pt} · {base}"
                else:
                    item["canonical_title"] = base
            else:
                item["canonical_title"] = base

        # Post-paso 3: Desambiguar cualquier duplicado restante (ej. Epigraph x2, Epígrafe x3)
        title_counts: Dict[str, int] = {}
        for item in resolved:
            tk = _strip_accents_lower(item["canonical_title"])
            title_counts[tk] = title_counts.get(tk, 0) + 1

        seen_counts: Dict[str, int] = {}
        for item in resolved:
            tk = _strip_accents_lower(item["canonical_title"])
            if title_counts.get(tk, 0) > 1:
                seen_counts[tk] = seen_counts.get(tk, 0) + 1
                num = seen_counts[tk]
                if item["kind"] in {"front_matter", "back_matter", "divider"}:
                    item["canonical_title"] = f"{item['canonical_title']} {num}"
                    item["toc_title"] = f"{item['toc_title']} {num}"
                elif num > 1:
                    item["canonical_title"] = f"{item['canonical_title']} ({num})"
                    item["toc_title"] = f"{item['toc_title']} ({num})"

        # Escribir campos finales sobre cada capítulo sin alterar index / sentences / html
        for ch, item in zip(chapters, resolved):
            ch["title"] = item["canonical_title"]
            ch["toc_title"] = item["toc_title"]
            ch["part_title"] = item["part_title"]
            ch["in_toc"] = bool(item["in_toc"])
            ch["kind"] = item["kind"]

    def _extract_images(
        self,
        zf: zipfile.ZipFile,
        manifest: Dict[str, Dict[str, str]],
        assets_folder: Path,
    ) -> None:
        for item in manifest.values():
            mtype = item.get("media_type", "").lower()
            if mtype.startswith("image/"):
                href = item["href"]
                if href in zf.namelist():
                    target_file = assets_folder / href
                    target_file.parent.mkdir(parents=True, exist_ok=True)
                    target_file.write_bytes(zf.read(href))

    def _extract_cover(
        self,
        zf: zipfile.ZipFile,
        opf_root: ET.Element,
        manifest: Dict[str, Dict[str, str]],
        book_folder: Path,
    ) -> Optional[str]:
        cover_item_id = None
        for elem in opf_root.iter():
            tag = elem.tag.split("}")[-1].lower()
            if tag == "meta" and elem.attrib.get("name", "").lower() == "cover":
                cover_item_id = elem.attrib.get("content")
                break

        cover_href = None
        if cover_item_id and cover_item_id in manifest:
            cover_href = manifest[cover_item_id]["href"]

        if not cover_href:
            for item in manifest.values():
                if "cover-image" in item.get("properties", ""):
                    cover_href = item["href"]
                    break

        if not cover_href:
            for item in manifest.values():
                if item.get("media_type", "").startswith("image/") and "cover" in item["href"].lower():
                    cover_href = item["href"]
                    break

        if cover_href and cover_href in zf.namelist():
            ext = Path(cover_href).suffix or ".jpg"
            cover_path = book_folder / f"cover{ext}"
            cover_path.write_bytes(zf.read(cover_href))
            return cover_path.name

        return None

    def _extract_smil_overlays(
        self,
        zf: zipfile.ZipFile,
        manifest: Dict[str, Dict[str, str]],
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        Extrae todos los ficheros SMIL 3.0 (application/smil+xml) del EPUB y construye un mapa:
        xhtml_href_normalizado -> lista ordenada de fragmentos:
          {"frag_id": str, "audio_href": str, "clip_begin": float, "clip_end": float}
        """
        smil_map: Dict[str, List[Dict[str, Any]]] = {}
        namelist_set = set(zf.namelist())

        # Localizar todos los ficheros .smil del manifest o del zip
        smil_hrefs: List[str] = []
        for item in manifest.values():
            mtype = item.get("media_type", "").lower()
            href = item.get("href", "")
            if "smil" in mtype or href.lower().endswith(".smil"):
                if href in namelist_set and href not in smil_hrefs:
                    smil_hrefs.append(href)

        for name in zf.namelist():
            if name.lower().endswith(".smil") and name not in smil_hrefs:
                smil_hrefs.append(name)

        for smil_href in smil_hrefs:
            try:
                raw_smil = zf.read(smil_href)
                smil_root = ET.fromstring(raw_smil)
            except Exception:
                continue

            smil_dir = posixpath.dirname(smil_href)
            default_textref = ""
            for el in smil_root.iter():
                for k, v in el.attrib.items():
                    if k.endswith("textref") and v:
                        default_textref = v.split("#")[0].strip()
                        break
                if default_textref:
                    break

            for elem in smil_root.iter():
                tag = elem.tag.split("}")[-1].lower()
                if tag != "par":
                    continue

                text_src = None
                audio_src = None
                clip_begin = 0.0
                clip_end = 0.0

                for child in elem.iter():
                    ctag = child.tag.split("}")[-1].lower()
                    if ctag == "text" and not text_src:
                        text_src = child.attrib.get("src", "").strip()
                    elif ctag == "audio" and not audio_src:
                        audio_src = child.attrib.get("src", "").strip()
                        cb = parse_smil_clock(
                            child.attrib.get("clipBegin")
                            or child.attrib.get("clip-begin")
                            or "0s"
                        )
                        ce = parse_smil_clock(
                            child.attrib.get("clipEnd")
                            or child.attrib.get("clip-end")
                            or "0s"
                        )
                        clip_begin = cb if cb is not None else 0.0
                        clip_end = ce if ce is not None else 0.0

                if not text_src or not audio_src or "#" not in text_src:
                    continue

                doc_part, frag_id = text_src.split("#", 1)
                frag_id = urllib.parse.unquote(frag_id.strip())
                if not frag_id:
                    continue

                doc_part = urllib.parse.unquote(doc_part.strip()) or default_textref
                audio_src_clean = urllib.parse.unquote(audio_src.strip())
                target_xhtml = (
                    posixpath.normpath(posixpath.join(smil_dir, doc_part))
                    if doc_part
                    else ""
                )
                target_audio = posixpath.normpath(posixpath.join(smil_dir, audio_src_clean))
                if target_audio not in namelist_set:
                    if audio_src.strip() in namelist_set:
                        target_audio = audio_src.strip()
                    else:
                        # Buscar por nombre de archivo si la ruta relativa difería
                        base_aud = posixpath.basename(target_audio).lower()
                        alt_aud = next(
                            (n for n in namelist_set if posixpath.basename(n).lower() == base_aud),
                            None,
                        )
                        if not alt_aud:
                            continue
                        target_audio = alt_aud

                if not target_xhtml:
                    continue

                par_entry = {
                    "frag_id": frag_id,
                    "audio_href": target_audio,
                    "clip_begin": max(0.0, float(clip_begin)),
                    "clip_end": max(0.0, float(clip_end)),
                }
                smil_map.setdefault(target_xhtml, []).append(par_entry)
                base_xhtml = posixpath.basename(target_xhtml)
                if base_xhtml:
                    smil_map.setdefault(f"__basename__:{base_xhtml}", []).append(par_entry)

        return smil_map

    def _parse_chapter_html(
        self,
        raw_html: str,
        chapter_index: int,
        chapter_dir: str,
        book_id: str,
        fallback_title: Optional[str] = None,
        smil_pars: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        Limpia el HTML del capítulo, reescribe rutas de imágenes y envuelve cada frase
        en un <span class="tts-sentence" id="sent-{i}" data-index="{i}"> para resaltado sincronizado.
        Si el capítulo incluye Media Overlays (smil_pars), reutiliza exactamente los elementos
        referenciados por los IDs del SMIL sin recalcular ni re-segmentar frases.
        """
        soup = BeautifulSoup(raw_html, "html.parser")

        # Eliminar scripts, estilos y elementos ocultos
        for tag in soup(["script", "style", "head", "meta", "link", "noscript"]):
            tag.decompose()

        body = soup.find("body") or soup

        # Reescribir rutas de imágenes para que apunten a /api/books/{book_id}/assets/...
        for img in list(body.find_all(["img", "image"])):
            src_attr = "src" if img.name == "img" else "xlink:href"
            raw_src = img.get(src_attr) or img.get("href") or img.get("src")
            if raw_src and not raw_src.startswith(("http://", "https://", "data:")):
                norm_img = posixpath.normpath(posixpath.join(chapter_dir, raw_src)) if chapter_dir else raw_src
                img_src = f"/api/books/{book_id}/assets/{norm_img}"
                if img.name == "image":
                    new_img = soup.new_tag("img", attrs={"src": img_src, "alt": img.get("alt", ""), "class": "epub-illustration"})
                    svg_parent = img.find_parent("svg")
                    if svg_parent and not svg_parent.get_text(strip=True):
                        svg_parent.replace_with(new_img)
                    else:
                        img.replace_with(new_img)
                else:
                    img["src"] = img_src

        # Detectar título provisional del capítulo (luego refinado por _resolve_book_chapter_titles)
        detected_title = _clean_heading_text(fallback_title) if fallback_title else ""
        if not detected_title:
            heading = body.find(["h1", "h2", "h3"])
            if heading:
                detected_title = _extract_clean_element_text(heading)
        if not detected_title or len(detected_title) > 120:
            detected_title = f"Capítulo {chapter_index + 1}"

        sentences_list: List[Dict[str, Any]] = []
        sentence_idx = 0

        # MODO 1: Capítulo con EPUB 3 Media Overlays (SMIL) pre-sincronizado
        used_smil_mode = False
        if smil_pars:
            id_map: Dict[str, Tag] = {}
            for el in body.find_all(True):
                el_id = el.get("id")
                if el_id and el_id not in id_map:
                    id_map[el_id] = el

            matched_pars = [p for p in smil_pars if p["frag_id"] in id_map]
            if matched_pars:
                used_smil_mode = True
                block_tags_set = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "dt", "dd", "figcaption"}
                for par in matched_pars:
                    target_el = id_map.get(par["frag_id"])
                    if not target_el:
                        continue
                    sent_text = re.sub(r"\s+", " ", target_el.get_text(" ", strip=True)).strip()
                    if not sent_text:
                        continue

                    parent_tag_name = target_el.name
                    if target_el.name in block_tags_set:
                        # Si el ID del SMIL apunta a un bloque (<p id="f1">...), envolvemos su interior en un span.tts-sentence
                        target_el.attrs.pop("id", None)
                        span = soup.new_tag(
                            "span",
                            attrs={
                                "class": "tts-sentence",
                                "id": f"sent-{sentence_idx}",
                                "data-index": str(sentence_idx),
                            },
                        )
                        for child in list(target_el.contents):
                            span.append(child.extract())
                        target_el.append(span)
                    else:
                        # Ya es un span/inline: normalizar como span.tts-sentence
                        parent_block = target_el.find_parent(list(block_tags_set))
                        parent_tag_name = parent_block.name if parent_block else "p"
                        target_el.name = "span"
                        target_el.attrs = {
                            "class": "tts-sentence",
                            "id": f"sent-{sentence_idx}",
                            "data-index": str(sentence_idx),
                        }

                    sentences_list.append(
                        {
                            "index": sentence_idx,
                            "text": sent_text,
                            "tag": parent_tag_name,
                            "smil_audio": par["audio_href"],
                            "clip_begin": round(float(par["clip_begin"]), 3),
                            "clip_end": round(float(par["clip_end"]), 3),
                        }
                    )
                    sentence_idx += 1

        # MODO 2: Capítulo estándar (segmentación automática en frases)
        if not used_smil_mode:
            # Bloques de texto o imagen candidatos
            block_tags = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "dt", "dd", "figcaption", "figure"}

            def has_nested_block(el: Tag) -> bool:
                return any(child.name in block_tags for child in el.find_all(block_tags))

            # Recorrer bloques hoja o contenedores con texto o imágenes
            candidates: List[Tag] = []
            for el in body.find_all(list(block_tags) + ["div", "section", "article"]):
                if el.name in block_tags and not has_nested_block(el):
                    candidates.append(el)
                elif el.name in {"div", "section", "article"} and not el.find(list(block_tags) + ["div", "section", "article"]):
                    if el.get_text(strip=True) or el.find("img"):
                        candidates.append(el)

            # Si el capítulo tiene texto plano directo en body sin etiquetas p/div
            if not candidates and (body.get_text(strip=True) or body.find("img")):
                candidates = [body]

            for block in candidates:
                # Preservar imágenes si las hubiera dentro del bloque (con o sin texto)
                preserved_imgs = [img.extract() for img in block.find_all("img")]
                block_text = block.get_text(" ", strip=True)
                block_sentences = split_into_sentences(block_text) if block_text else []

                if not block_sentences and not preserved_imgs:
                    continue

                block.clear()
                if not block_sentences and preserved_imgs:
                    existing_cls = block.get("class") or []
                    if isinstance(existing_cls, str):
                        existing_cls = existing_cls.split()
                    if "epub-image-block" not in existing_cls:
                        existing_cls.append("epub-image-block")
                    block["class"] = existing_cls

                for img in preserved_imgs:
                    block.append(img)

                for s_pos, sent_text in enumerate(block_sentences):
                    span = soup.new_tag(
                        "span",
                        attrs={
                            "class": "tts-sentence",
                            "id": f"sent-{sentence_idx}",
                            "data-index": str(sentence_idx),
                        },
                    )
                    span.string = sent_text
                    block.append(span)
                    if s_pos < len(block_sentences) - 1:
                        block.append(NavigableString(" "))

                    sentences_list.append(
                        {
                            "index": sentence_idx,
                            "text": sent_text,
                            "tag": block.name,
                        }
                    )
                    sentence_idx += 1

        # Limpiar atributos inline molestos pero mantener estructura semántica
        for tag in body.find_all(True):
            classes = tag.get("class") or []
            if isinstance(classes, str):
                classes = classes.split()
            if "tts-sentence" in classes:
                tag.attrs = {
                    "class": "tts-sentence",
                    "id": tag.get("id", ""),
                    "data-index": tag.get("data-index", ""),
                }
                continue
            allowed_attrs = {}
            if tag.name == "img" and tag.get("src"):
                allowed_attrs["src"] = tag["src"]
                allowed_attrs["alt"] = tag.get("alt", "")
                allowed_attrs["class"] = "epub-illustration"
            elif "epub-image-block" in classes:
                allowed_attrs["class"] = "epub-image-block"
            tag.attrs = allowed_attrs

        inner_html = "".join(str(child) for child in body.contents)

        return {
            "index": chapter_index,
            "title": detected_title,
            "sentence_count": len(sentences_list),
            "sentences": sentences_list,
            "html": inner_html,
            "has_media_overlay": used_smil_mode,
        }

    def _extract_embedded_media_overlay_audio(
        self,
        zf: zipfile.ZipFile,
        book_folder: Path,
        epub_path: Path,
        chapters: List[Dict[str, Any]],
    ) -> int:
        """
        Prepara en <1 segundo (0% TTS / 0% Whisper / sin crear miles de ficheros pequeños)
        las pistas de audio embebidas en un EPUB 3 Media Overlay y su índice exacto [clip_begin, clip_end]
        para reproducción instantánea bajo la voz 'audiobook:original'.
        """
        from backend.exporter import get_voice_hash

        vhash = get_voice_hash("audiobook:original", 1.0)
        mo_audio_dir = book_folder / "media_overlay_audio"
        mo_audio_dir.mkdir(parents=True, exist_ok=True)

        namelist_set = set(zf.namelist())
        mo_index: Dict[str, Dict[str, Any]] = {}
        unique_audio_hrefs = set()

        for ch in chapters:
            ch_idx = ch["index"]
            for sent in ch.get("sentences", []):
                audio_href = sent.get("smil_audio")
                if not audio_href or audio_href not in namelist_set:
                    continue
                c_begin = float(sent.get("clip_begin", 0.0))
                c_end = float(sent.get("clip_end", 0.0))
                s_idx = int(sent["index"])
                mo_index[f"{ch_idx}:{s_idx}"] = {
                    "audio_href": audio_href,
                    "clip_begin": round(c_begin, 3),
                    "clip_end": round(c_end, 3),
                }
                unique_audio_hrefs.add(audio_href)

        if not mo_index or not unique_audio_hrefs:
            return 0

        # Extraer únicamente los archivos de audio por capítulo (normalmente 10-40 archivos en total)
        extracted_audio_files = 0
        for audio_href in sorted(unique_audio_hrefs):
            try:
                target_file = mo_audio_dir / audio_href
                target_file.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(audio_href, "r") as src_f, target_file.open("wb") as dst_f:
                    shutil.copyfileobj(src_f, dst_f, length=1024 * 1024)
                extracted_audio_files += 1
            except Exception as exc:
                logger.warning("No se pudo extraer pista Media Overlay %s: %s", audio_href, exc)

        if extracted_audio_files == 0:
            return 0

        extracted_count = len(mo_index)
        (book_folder / "media_overlay_index.json").write_text(
            json.dumps(mo_index, ensure_ascii=False),
            encoding="utf-8",
        )

        # Crear carpeta de caché y exportación para que figure como 100% listo sin recalcular
        cache_dir = book_folder / "audio_cache" / vhash
        cache_dir.mkdir(parents=True, exist_ok=True)

        export_dir = book_folder / "exports" / vhash
        export_dir.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(epub_path, export_dir / "book_media_overlay.epub")
        except Exception:
            pass

        export_info = {
            "voice_id": "audiobook:original",
            "voice_name": "🎧 EPUB Media Overlay Original (Sincronizado)",
            "voice": "audiobook:original",
            "speed": 1.0,
            "rate": 1.0,
            "voice_hash": vhash,
            "updated_at": int(time.time()),
            "source": "embedded_epub_media_overlay",
            "cached_sentences": extracted_count,
            "epub_filename": "book_media_overlay.epub",
        }
        (export_dir / "export_info.json").write_text(
            json.dumps(export_info, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        return extracted_count

    def _detect_language_heuristic(self, sample_text: str, metadata_lang: str) -> str:
        """Verifica si el texto es español o inglés por palabras frecuentes."""
        if not sample_text:
            return metadata_lang
        lower = f" {sample_text.lower()} "
        es_markers = [" el ", " la ", " de ", " que ", " en ", " los ", " las ", " del ", " por ", " con ", " una ", " para "]
        en_markers = [" the ", " and ", " of ", " to ", " in ", " that ", " was ", " for ", " with ", " as ", " his ", " her "]

        es_score = sum(lower.count(m) for m in es_markers)
        en_score = sum(lower.count(m) for m in en_markers)

        if es_score > en_score * 1.3:
            return "es-ES"
        if en_score > es_score * 1.3:
            return metadata_lang if metadata_lang.startswith("en") else "en-US"
        return metadata_lang

    def refresh_book_chapter_titles_from_epub(self, book_id: str) -> Dict[str, Any]:
        """
        Recalcula los títulos canónicos de capítulos (title, toc_title, part_title, in_toc, kind)
        leyendo el book.epub original, SIN alterar índices (0..N-1), sentence_count, sentences,
        html, audios cacheados ni progreso de lectura.
        """
        book_folder = self.books_dir / book_id
        epub_path = book_folder / "book.epub"
        chapters_path = book_folder / "chapters.json"
        meta_path = book_folder / "metadata.json"
        if not epub_path.exists() or not chapters_path.exists():
            return {"ok": False, "changed": False, "reason": "missing_files"}

        existing_chapters = json.loads(chapters_path.read_text(encoding="utf-8"))
        existing_meta: Dict[str, Any] = {}
        if meta_path.exists():
            try:
                existing_meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                existing_meta = {}

        with zipfile.ZipFile(epub_path, "r") as zf:
            opf_path = self._find_opf_path(zf)
            opf_dir = posixpath.dirname(opf_path)
            opf_root = ET.fromstring(zf.read(opf_path))

            opf_meta = self._extract_metadata(opf_root, existing_meta.get("filename") or epub_path.name)
            book_title = existing_meta.get("title") or opf_meta["title"]
            book_lang = existing_meta.get("language") or opf_meta["language"]
            manifest, id_to_href = self._extract_manifest(opf_root, opf_dir)
            spine_hrefs = self._extract_spine(opf_root, id_to_href)
            toc_entries, _ = self._extract_toc_entries(
                zf, opf_root, manifest, opf_dir, book_title=book_title
            )
            smil_by_xhtml = self._extract_smil_overlays(zf, manifest)

            namelist_set = set(zf.namelist())
            reparsed_stubs: List[Dict[str, Any]] = []
            title_contexts: List[Dict[str, Any]] = []
            pending_skipped_part = ""

            for href in spine_hrefs:
                resolved_href = href
                if resolved_href not in namelist_set:
                    decoded_href = urllib.parse.unquote(resolved_href)
                    if decoded_href in namelist_set:
                        resolved_href = decoded_href
                    else:
                        continue

                norm_href = _normalize_toc_href("", resolved_href)
                toc_entry = (
                    toc_entries.get(norm_href)
                    or toc_entries.get(norm_href.lower())
                    or toc_entries.get(_normalize_toc_href("", href))
                    or toc_entries.get(_normalize_toc_href("", href).lower())
                )
                raw_html = zf.read(resolved_href).decode("utf-8", errors="replace")
                chapter_dir = posixpath.dirname(resolved_href)
                chapter_smil_pars = (
                    smil_by_xhtml.get(resolved_href)
                    or smil_by_xhtml.get(urllib.parse.unquote(resolved_href))
                    or smil_by_xhtml.get(f"__basename__:{posixpath.basename(resolved_href)}")
                    or smil_by_xhtml.get(f"__basename__:{posixpath.basename(urllib.parse.unquote(resolved_href))}")
                    or []
                )
                title_ctx = self._extract_html_title_context(raw_html, norm_href)
                parsed_ch = self._parse_chapter_html(
                    raw_html=raw_html,
                    chapter_index=len(reparsed_stubs),
                    chapter_dir=chapter_dir,
                    book_id=book_id,
                    fallback_title=toc_entry["label"] if toc_entry else None,
                    smil_pars=chapter_smil_pars,
                )
                if parsed_ch["sentence_count"] == 0:
                    if toc_entry and _DIVIDER_TITLE_RE.match(_strip_accents_lower(toc_entry["label"])):
                        pending_skipped_part = _normalize_heading_casing(toc_entry["label"])
                    continue

                title_ctx["toc_entry"] = toc_entry
                title_ctx["inherited_skipped_part"] = pending_skipped_part
                pending_skipped_part = ""
                title_contexts.append(title_ctx)
                reparsed_stubs.append(
                    {
                        "index": len(reparsed_stubs),
                        "title": parsed_ch["title"],
                        "sentence_count": parsed_ch["sentence_count"],
                    }
                )

        if len(reparsed_stubs) != len(existing_chapters):
            logger.warning(
                "refresh_book_chapter_titles_from_epub(%s): chapter count mismatch (%s vs %s), aborting safe update",
                book_id,
                len(reparsed_stubs),
                len(existing_chapters),
            )
            return {
                "ok": False,
                "changed": False,
                "reason": f"chapter_count_mismatch:{len(reparsed_stubs)}!={len(existing_chapters)}",
            }

        self._resolve_book_chapter_titles(
            chapters=reparsed_stubs,
            title_contexts=title_contexts,
            book_title=book_title,
            book_lang=book_lang,
        )

        changed = False
        for old_ch, new_ch in zip(existing_chapters, reparsed_stubs):
            for field in ("title", "toc_title", "part_title", "in_toc", "kind"):
                if old_ch.get(field) != new_ch.get(field):
                    old_ch[field] = new_ch.get(field)
                    changed = True

        story_indices = [
            int(ch["index"])
            for ch in existing_chapters
            if ch.get("kind") in {"prologue", "chapter", "interlude", "epilogue"}
        ]
        story_chapter_count = len(story_indices) or len(existing_chapters)

        chapters_meta = [
            {
                "index": int(ch["index"]),
                "title": ch["title"],
                "toc_title": ch.get("toc_title") or ch["title"],
                "part_title": ch.get("part_title") or "",
                "in_toc": bool(ch.get("in_toc", False)),
                "kind": ch.get("kind") or "chapter",
                "sentence_count": int(ch.get("sentence_count", 0)),
            }
            for ch in existing_chapters
        ]

        if changed or existing_meta.get("story_chapter_count") != story_chapter_count or existing_meta.get("chapters") != chapters_meta:
            chapters_path.write_text(
                json.dumps(existing_chapters, ensure_ascii=False), encoding="utf-8"
            )
            if existing_meta:
                existing_meta["story_chapter_count"] = story_chapter_count
                existing_meta["chapters"] = chapters_meta
                existing_meta["chapters_summary"] = [dict(cm) for cm in chapters_meta]
                meta_path.write_text(
                    json.dumps(existing_meta, ensure_ascii=False, indent=2), encoding="utf-8"
                )
            changed = True

        return {
            "ok": True,
            "changed": changed,
            "book_id": book_id,
            "chapter_count": len(existing_chapters),
            "story_chapter_count": story_chapter_count,
            "chapters_meta": chapters_meta,
            "story_indices": story_indices,
        }

    def refresh_book_images_from_epub(self, book_id: str) -> Dict[str, Any]:
        """
        Re-extrae imágenes y actualiza el HTML de chapters.json desde book.epub para libros ya importados,
        preservando exactamente los índices de capítulo, frases (sent-N), audios cacheados y progreso.
        """
        book_folder = self.books_dir / book_id
        epub_path = book_folder / "book.epub"
        chapters_path = book_folder / "chapters.json"
        if not epub_path.exists() or not chapters_path.exists():
            return {"ok": False, "updated_chapters": 0}

        existing_chapters = json.loads(chapters_path.read_text(encoding="utf-8"))
        assets_folder = book_folder / "assets"
        assets_folder.mkdir(parents=True, exist_ok=True)

        with zipfile.ZipFile(epub_path, "r") as zf:
            opf_path = self._find_opf_path(zf)
            opf_dir = posixpath.dirname(opf_path)
            opf_root = ET.fromstring(zf.read(opf_path))

            manifest, id_to_href = self._extract_manifest(opf_root, opf_dir)
            spine_hrefs = self._extract_spine(opf_root, id_to_href)
            toc_map = self._extract_toc(zf, opf_root, manifest, opf_dir)
            self._extract_images(zf, manifest, assets_folder)

            has_cover_file = any(book_folder.glob("cover.*"))
            cover_rel_path = None
            if not has_cover_file:
                cover_rel_path = self._extract_cover(zf, opf_root, manifest, book_folder)
            else:
                cover_rel_path = next(book_folder.glob("cover.*")).name

            smil_by_xhtml = self._extract_smil_overlays(zf, manifest)

            reparsed_chapters: List[Dict[str, Any]] = []
            pending_image_blocks: List[str] = []
            for idx, href in enumerate(spine_hrefs):
                if href not in zf.namelist():
                    decoded_href = urllib.parse.unquote(href)
                    if decoded_href in zf.namelist():
                        href = decoded_href
                    else:
                        continue
                raw_html = zf.read(href).decode("utf-8", errors="replace")
                chapter_dir = posixpath.dirname(href)
                chapter_title = toc_map.get(href) or toc_map.get(urllib.parse.unquote(href))
                chapter_smil_pars = (
                    smil_by_xhtml.get(href)
                    or smil_by_xhtml.get(urllib.parse.unquote(href))
                    or smil_by_xhtml.get(f"__basename__:{posixpath.basename(href)}")
                    or smil_by_xhtml.get(f"__basename__:{posixpath.basename(urllib.parse.unquote(href))}")
                    or []
                )
                parsed_chapter = self._parse_chapter_html(
                    raw_html=raw_html,
                    chapter_index=len(reparsed_chapters),
                    chapter_dir=chapter_dir,
                    book_id=book_id,
                    fallback_title=chapter_title,
                    smil_pars=chapter_smil_pars,
                )
                if parsed_chapter["sentence_count"] == 0:
                    img_soup = BeautifulSoup(parsed_chapter.get("html") or "", "html.parser")
                    imgs = img_soup.find_all("img")
                    if imgs and not (len(reparsed_chapters) == 0 and idx == 0 and cover_rel_path):
                        for im in imgs:
                            pending_image_blocks.append(f'<p class="epub-image-block">{str(im)}</p>')
                    continue
                if pending_image_blocks:
                    parsed_chapter["html"] = "".join(pending_image_blocks) + (parsed_chapter.get("html") or "")
                    pending_image_blocks.clear()
                reparsed_chapters.append(parsed_chapter)

            if pending_image_blocks and reparsed_chapters:
                reparsed_chapters[-1]["html"] = (reparsed_chapters[-1].get("html") or "") + "".join(pending_image_blocks)
                pending_image_blocks.clear()

        updated_count = 0
        if len(reparsed_chapters) == len(existing_chapters):
            for old_ch, new_ch in zip(existing_chapters, reparsed_chapters):
                if int(old_ch.get("sentence_count", 0)) == int(new_ch.get("sentence_count", 0)):
                    if old_ch.get("html") != new_ch.get("html"):
                        old_ch["html"] = new_ch["html"]
                        updated_count += 1
            if updated_count > 0:
                chapters_path.write_text(
                    json.dumps(existing_chapters, ensure_ascii=False), encoding="utf-8"
                )

        return {
            "ok": True,
            "updated_chapters": updated_count,
            "cover_url": f"/api/books/{book_id}/cover" if cover_rel_path else None,
        }
