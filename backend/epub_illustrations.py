import hashlib
import posixpath
import re
import struct
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from bs4 import BeautifulSoup


JUNK_FILENAME_RE = re.compile(
    r"(?i)(?:^|[/\\_-])(?:"
    r"cover|cubierta|portada|audio[-_]?cover|frontcover|"
    r"logo|epl_logo|ex_?libris|publisher|editorial|penguin|planeta|minotauro|nova|gigamesh|salamandra|alfaguara|anagrama|"
    r"social[-_]|facebook|twitter|patreon|instagram|tiktok|amazon|goodreads|"
    r"qrcode|barcode|isbn|autor|author[_-]?photo|fuente|font|"
    r"portadilla|title[_-]?page|copyright|colofon|pagina_captacion|newsletter|sinopsis|publicidad|promo|"
    r"img_cap|img_inter|cap_\d|chap_?\d|chapter_?\d|header|banner|ornament|divider|separador|vignette|fleuron|vineta|viñeta"
    r")(?:[/\\._\-\d]|$)"
)

PART_DIVIDER_RE = re.compile(
    r"(?i)^(?:parte[_-]?\d+|part[_-]?\d+|parte_inter[_-]?\d+|libro_(?:primero|segundo|tercero|cuarto|quinto|sexto|\d+))$"
)

KEEP_HINT_RE = re.compile(
    r"(?i)(?:mapa|map|ilustra|illustra|plate|lamina|lámina|plano|arbol|árbol|tree|diagram|tabla|ars|guarda|endpaper|herald|sketch)"
)

PROMO_PAGE_RE = re.compile(
    r"(?i)\b(?:sobre\s+el\s+autor|about\s+the\s+author|copyright|cr[ée]ditos|portadilla|title\s*page|newsletter|otros\s+t[íi]tulos|also\s+by|sinopsis|publicidad)\b"
)


def _safe_filename(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*]+', "", (name or "").strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or "Libro"


def get_image_dimensions_from_bytes(data: bytes) -> Optional[Tuple[int, int]]:
    """Obtiene (width, height) de PNG, JPEG, GIF o WEBP usando solo librería estándar."""
    n = len(data)
    if n < 24:
        return None

    # PNG
    if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        w, h = struct.unpack(">II", data[16:24])
        return (int(w), int(h)) if w > 0 and h > 0 else None

    # GIF
    if data[:6] in (b"GIF87a", b"GIF89a"):
        w, h = struct.unpack("<HH", data[6:10])
        return (int(w), int(h)) if w > 0 and h > 0 else None

    # WEBP
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and n >= 30:
        chunk = data[12:16]
        if chunk == b"VP8 " and n >= 30:
            w, h = struct.unpack("<HH", data[26:30])
            return (w & 0x3FFF, h & 0x3FFF)
        if chunk == b"VP8L" and n >= 25:
            b0, b1, b2, b3 = data[21], data[22], data[23], data[24]
            w = 1 + (((b1 & 0x3F) << 8) | b0)
            h = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
            return (w, h)
        if chunk == b"VP8X" and n >= 30:
            w = 1 + int.from_bytes(data[24:27], "little")
            h = 1 + int.from_bytes(data[27:30], "little")
            return (w, h)

    # JPEG
    if data[:2] == b"\xff\xd8":
        idx = 2
        sof_markers = {
            0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
            0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
        }
        while idx < n - 1:
            if data[idx] != 0xFF:
                idx += 1
                continue
            while idx < n and data[idx] == 0xFF:
                idx += 1
            if idx >= n:
                break
            marker = data[idx]
            idx += 1
            if marker in (0xD8, 0xD9, 0x01) or (0xD0 <= marker <= 0xD7):
                continue
            if idx + 2 > n:
                break
            seg_len = struct.unpack(">H", data[idx : idx + 2])[0]
            if seg_len < 2 or idx + seg_len > n:
                break
            if marker in sof_markers and idx + 7 <= n:
                h, w = struct.unpack(">HH", data[idx + 3 : idx + 7])
                return (int(w), int(h)) if w > 0 and h > 0 else None
            idx += seg_len

    return None


def _find_opf_path(zf: zipfile.ZipFile) -> Optional[str]:
    if "META-INF/container.xml" in zf.namelist():
        try:
            root = ET.fromstring(zf.read("META-INF/container.xml"))
            for elem in root.iter():
                if elem.tag.endswith("rootfile") and "full-path" in elem.attrib:
                    return elem.attrib["full-path"]
        except Exception:
            pass
    for name in zf.namelist():
        if name.lower().endswith(".opf"):
            return name
    return None


def _clean_caption_label(raw: str, book_title: str) -> str:
    if not raw:
        return ""
    s = re.sub(r"\s+", " ", raw).strip(" -—–:·.|_")
    if not s or len(s) > 90:
        return ""
    low = s.lower()
    if low in {"cover", "portada", "cubierta", "image", "imagen", "img", "sin título", "untitled"}:
        return ""
    if book_title and low == book_title.strip().lower():
        return ""
    if re.match(r"^(?:img|image|pic|photo|page|part|split)[_-]?\d+$", low):
        return ""
    if re.match(r"^\d+$", low):
        return ""
    human = s.replace("_", " ")
    human = re.sub(r"(?i)^(?:img|image)\s+", "", human).strip()
    human = re.sub(r"(?i)^ilustra\b", "Ilustración", human)
    if human:
        human = human[0].upper() + human[1:]
    return human


def extract_relevant_epub_illustrations(
    epub_path: Path,
    dest_book_images_dir: Path,
    book_title: str,
) -> List[Dict[str, Any]]:
    """
    Analiza un archivo .epub, filtra portadas, logos editoriales, iconos, cabeceras repetidas de capítulo
    y páginas divisorias ("Parte I"), y extrae únicamente mapas, guardas, esquemas e ilustraciones reales
    en orden de aparición dentro del libro.
    """
    if not epub_path.exists():
        return []

    safe_book = _safe_filename(book_title)

    with zipfile.ZipFile(epub_path, "r") as zf:
        namelist_set = set(zf.namelist())
        opf_path = _find_opf_path(zf)
        if not opf_path or opf_path not in namelist_set:
            return []

        opf_dir = posixpath.dirname(opf_path)
        opf_root = ET.fromstring(zf.read(opf_path))

        manifest: Dict[str, Dict[str, str]] = {}
        cover_hrefs: Set[str] = set()
        cover_meta_id = ""

        for elem in opf_root.iter():
            tag = elem.tag.split("}")[-1].lower()
            if tag == "meta" and elem.attrib.get("name", "").lower() == "cover":
                cover_meta_id = elem.attrib.get("content", "")
            elif tag == "reference" and elem.attrib.get("type", "").lower() == "cover":
                ref_h = elem.attrib.get("href", "").split("#")[0]
                if ref_h:
                    cover_hrefs.add(posixpath.normpath(posixpath.join(opf_dir, ref_h)) if opf_dir else ref_h)

        for elem in opf_root.iter():
            if elem.tag.split("}")[-1].lower() == "item":
                iid = elem.attrib.get("id", "")
                href = elem.attrib.get("href", "")
                props = elem.attrib.get("properties", "")
                mtype = elem.attrib.get("media-type", "")
                if iid and href:
                    norm_h = posixpath.normpath(posixpath.join(opf_dir, href)) if opf_dir else href
                    manifest[iid] = {"href": norm_h, "media_type": mtype, "properties": props}
                    if iid == cover_meta_id or "cover-image" in props.split():
                        cover_hrefs.add(norm_h)

        spine_xhtml: List[str] = []
        for elem in opf_root.iter():
            if elem.tag.split("}")[-1].lower() == "itemref":
                idref = elem.attrib.get("idref", "")
                if idref in manifest:
                    spine_xhtml.append(manifest[idref]["href"])

        # Recorrer el spine en orden de lectura para recoger apariciones y contexto/pie de foto
        occurrences: Dict[str, Dict[str, Any]] = {}
        ordered_hashes: List[str] = []

        for spine_idx, xh_href in enumerate(spine_xhtml):
            actual_xh = xh_href if xh_href in namelist_set else urllib.parse.unquote(xh_href)
            if actual_xh not in namelist_set:
                continue
            # Saltar la primera página si es explícitamente cubierta/portada
            xh_base = posixpath.basename(actual_xh).lower()
            if spine_idx == 0 and any(k in xh_base for k in ("cover", "cubierta", "portada")):
                continue

            try:
                raw_html = zf.read(actual_xh).decode("utf-8", errors="replace")
            except Exception:
                continue

            soup = BeautifulSoup(raw_html, "html.parser")
            page_title = ""
            if soup.title and soup.title.string:
                page_title = soup.title.string.strip()

            if PROMO_PAGE_RE.search(page_title) and not KEEP_HINT_RE.search(page_title):
                continue

            xh_dir = posixpath.dirname(actual_xh)
            for tag in soup.find_all(["img", "image"]):
                raw_src = (
                    tag.get("src")
                    or tag.get("xlink:href")
                    or tag.get("href")
                    or ""
                ).split("#")[0].strip()
                if not raw_src or raw_src.startswith(("http://", "https://", "data:")):
                    continue

                img_href = posixpath.normpath(posixpath.join(xh_dir, raw_src)) if xh_dir else raw_src
                if img_href not in namelist_set:
                    dec_img = urllib.parse.unquote(img_href)
                    if dec_img in namelist_set:
                        img_href = dec_img
                    else:
                        continue

                if img_href in cover_hrefs:
                    continue

                ext = Path(img_href).suffix.lower()
                if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
                    continue

                stem = Path(img_href).stem
                if JUNK_FILENAME_RE.search(img_href) and not KEEP_HINT_RE.search(stem):
                    continue
                if PART_DIVIDER_RE.match(stem):
                    continue

                try:
                    img_bytes = zf.read(img_href)
                except Exception:
                    continue

                # Tamaño mínimo de archivo (28 KB) salvo que el nombre indique explícitamente mapa
                min_bytes = 14 * 1024 if KEEP_HINT_RE.search(stem) else 28 * 1024
                if len(img_bytes) < min_bytes:
                    continue

                dims = get_image_dimensions_from_bytes(img_bytes)
                if not dims:
                    continue
                w, h = dims
                area = w * h
                ratio = max(w / max(1, h), h / max(1, w))

                # Filtrar iconos, viñetas pequeñas y banners alargados
                if ratio > 3.0:
                    continue
                if area < 160_000 or min(w, h) < 280 or max(w, h) < 420:
                    continue

                sha = hashlib.sha256(img_bytes).hexdigest()

                # Intentar obtener leyenda / título descriptivo
                caption = ""
                fig = tag.find_parent("figure")
                if fig:
                    fc = fig.find("figcaption")
                    if fc:
                        caption = _clean_caption_label(fc.get_text(" ", strip=True), book_title)
                if not caption:
                    nxt = tag.find_parent(["div", "p"])
                    if nxt:
                        sib = nxt.find_next_sibling(["p", "div"])
                        if sib and any(
                            c in " ".join(sib.get("class") or []).lower()
                            for c in ("caption", "pie", "leyenda", "illus", "fig")
                        ):
                            caption = _clean_caption_label(sib.get_text(" ", strip=True), book_title)
                if not caption:
                    caption = _clean_caption_label(tag.get("alt") or tag.get("title") or "", book_title)
                if not caption:
                    caption = _clean_caption_label(page_title, book_title)
                if not caption and KEEP_HINT_RE.search(stem):
                    caption = _clean_caption_label(stem, book_title)

                if sha not in occurrences:
                    occurrences[sha] = {
                        "sha": sha,
                        "href": img_href,
                        "stem": stem,
                        "ext": ".jpg" if ext == ".jpeg" else ext,
                        "bytes": img_bytes,
                        "width": w,
                        "height": h,
                        "caption": caption,
                        "xhtml_files": {actual_xh},
                    }
                    ordered_hashes.append(sha)
                else:
                    occurrences[sha]["xhtml_files"].add(actual_xh)
                    if not occurrences[sha]["caption"] and caption:
                        occurrences[sha]["caption"] = caption

        if not ordered_hashes:
            return []

        # Filtrar imágenes repetidas en >= 3 archivos XHTML distintos (ornamentos recurrentes)
        candidates = [
            occurrences[h]
            for h in ordered_hashes
            if len(occurrences[h]["xhtml_files"]) < 3
        ]

        # Filtrar plantillas de cabeceras de capítulo con dimensiones exactas repetidas (>= 8 veces en apaisado)
        dim_counts: Dict[Tuple[int, int], int] = {}
        for c in candidates:
            key_dim = (c["width"], c["height"])
            dim_counts[key_dim] = dim_counts.get(key_dim, 0) + 1

        filtered: List[Dict[str, Any]] = []
        for c in candidates:
            w, h = c["width"], c["height"]
            same_dim_n = dim_counts.get((w, h), 0)
            if same_dim_n >= 8 and w > h and not KEEP_HINT_RE.search(c["stem"]):
                continue
            filtered.append(c)

        if not filtered:
            return []

        dest_book_images_dir.mkdir(parents=True, exist_ok=True)
        saved_items: List[Dict[str, Any]] = []

        for i, item in enumerate(filtered, start=1):
            raw_label = item["caption"]
            if not raw_label:
                if "mapa" in item["stem"].lower() or "map" in item["stem"].lower():
                    raw_label = f"Mapa {i}"
                elif "guarda" in item["stem"].lower():
                    raw_label = f"Guarda {i}"
                else:
                    raw_label = f"Ilustración {i}"

            safe_label = _safe_filename(raw_label)[:55].strip()
            out_name = f"{safe_book} - {i:02d} - {safe_label}{item['ext']}"
            out_path = dest_book_images_dir / out_name
            out_path.write_bytes(item["bytes"])

            saved_items.append(
                {
                    "filename": out_name,
                    "label": raw_label,
                    "width": item["width"],
                    "height": item["height"],
                }
            )

        return saved_items
