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
import urllib.parse
import wave
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from bs4 import BeautifulSoup, NavigableString, Tag

logger = logging.getLogger("epub_tts.parser")


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
            toc_map = self._extract_toc(zf, opf_root, manifest, opf_dir)

            # Extraer imágenes y recursos para poder mostrarlos en el visor
            self._extract_images(zf, manifest, assets_folder)

            # Detectar portada
            cover_rel_path = self._extract_cover(zf, opf_root, manifest, book_folder)

            # Detectar si el EPUB ya incluye EPUB 3 Media Overlays (.smil + audio sincronizado)
            smil_by_xhtml = self._extract_smil_overlays(zf, manifest)

            chapters: List[Dict[str, Any]] = []
            pending_image_blocks: List[str] = []
            for idx, href in enumerate(spine_hrefs):
                if href not in zf.namelist():
                    # Intentar decodificar URL (%20, etc.)
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
                    chapter_index=len(chapters),
                    chapter_dir=chapter_dir,
                    book_id=book_id,
                    fallback_title=chapter_title,
                    smil_pars=chapter_smil_pars,
                )

                # Si la página no tiene texto pero sí ilustraciones (láminas/mapas entre capítulos),
                # conservar sus imágenes adjuntándolas al capítulo contiguo sin alterar los índices.
                if parsed_chapter["sentence_count"] == 0:
                    img_soup = BeautifulSoup(parsed_chapter.get("html") or "", "html.parser")
                    imgs = img_soup.find_all("img")
                    if imgs and not (len(chapters) == 0 and idx == 0 and cover_rel_path):
                        for im in imgs:
                            pending_image_blocks.append(f'<p class="epub-image-block">{str(im)}</p>')
                    continue

                if pending_image_blocks:
                    parsed_chapter["html"] = "".join(pending_image_blocks) + (parsed_chapter.get("html") or "")
                    pending_image_blocks.clear()

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

        has_embedded_mo = embedded_overlay_count > 0
        total_words = sum(
            len((s.get("text") or "").split())
            for c in chapters
            for s in c.get("sentences", [])
        )
        estimated_pages = max(1, round(total_words / 250)) if total_words > 0 else 1
        now_ts = int(time.time())

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
            "chapters": [
                {
                    "index": c["index"],
                    "title": c["title"],
                    "sentence_count": c["sentence_count"],
                }
                for c in chapters
            ],
            "chapters_summary": [
                {
                    "index": c["index"],
                    "title": c["title"],
                    "sentence_count": c["sentence_count"],
                }
                for c in chapters
            ],
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
    ) -> Dict[str, str]:
        """Mapea rutas de archivo de capítulo -> título del capítulo usando NCX o EPUB3 nav."""
        toc_map: Dict[str, str] = {}

        # 1. Intentar EPUB 3 Nav Document
        for item in manifest.values():
            if "nav" in item.get("properties", "").split():
                nav_href = item["href"]
                if nav_href in zf.namelist():
                    nav_dir = posixpath.dirname(nav_href)
                    soup = BeautifulSoup(zf.read(nav_href), "html.parser")
                    for a in soup.find_all("a", href=True):
                        raw_target = a["href"].split("#")[0]
                        if raw_target:
                            target_path = posixpath.normpath(posixpath.join(nav_dir, raw_target))
                            label = a.get_text(" ", strip=True)
                            if label and target_path not in toc_map:
                                toc_map[target_path] = label

        # 2. Intentar EPUB 2 NCX
        for item in manifest.values():
            if "ncx" in item.get("media_type", "").lower() or item["href"].lower().endswith(".ncx"):
                ncx_href = item["href"]
                if ncx_href in zf.namelist():
                    ncx_dir = posixpath.dirname(ncx_href)
                    try:
                        ncx_root = ET.fromstring(zf.read(ncx_href))
                        for nav_point in ncx_root.iter():
                            if nav_point.tag.split("}")[-1].lower() == "navpoint":
                                label = ""
                                src = ""
                                for child in nav_point.iter():
                                    ctag = child.tag.split("}")[-1].lower()
                                    if ctag == "text" and child.text and not label:
                                        label = child.text.strip()
                                    elif ctag == "content" and "src" in child.attrib and not src:
                                        src = child.attrib["src"].split("#")[0]
                                if label and src:
                                    target_path = posixpath.normpath(posixpath.join(ncx_dir, src))
                                    if target_path not in toc_map:
                                        toc_map[target_path] = label
                    except Exception:
                        pass

        return toc_map

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

        # Detectar título del capítulo
        detected_title = fallback_title
        if not detected_title:
            heading = body.find(["h1", "h2", "h3"])
            if heading:
                detected_title = heading.get_text(" ", strip=True)
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
