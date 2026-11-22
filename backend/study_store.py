import datetime
import json
import logging
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from backend.epub_illustrations import extract_relevant_epub_illustrations

logger = logging.getLogger("epub_tts.study")


def _format_ts_date(ts: Optional[int]) -> str:
    if not ts:
        return "—"
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def _format_ts_datetime(ts: Optional[int]) -> str:
    if not ts:
        return "—"
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def _format_duration_human(total_seconds: int) -> str:
    if total_seconds <= 0:
        return "0 min"
    minutes = max(1, round(total_seconds / 60))
    hours = minutes // 60
    rem_min = minutes % 60
    if hours > 0:
        return f"{hours} h {rem_min} min"
    return f"{minutes} min"


def _safe_filename(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*]+', "", (name or "").strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or "Libro"


def _normalize_half_star_rating(val: Any) -> Any:
    try:
        v = float(val or 0.0)
    except Exception:
        v = 0.0
    norm = round(max(0.0, min(5.0, v)) * 2.0) / 2.0
    return int(norm) if norm.is_integer() else norm


def _format_stars_obsidian(rating_val: Any, is_en: bool = False) -> str:
    r = float(_normalize_half_star_rating(rating_val))
    if r <= 0:
        return "Unrated" if is_en else "Sin calificar"
    full = int(r)
    has_half = (r - full) >= 0.49
    stars_str = ("⭐" * full) + ("½" if has_half else "")
    if is_en:
        num_str = str(int(r)) if r.is_integer() else f"{r:.1f}"
    else:
        num_str = str(int(r)) if r.is_integer() else f"{r:.1f}".replace(".", ",")
    return f"{stars_str} ({num_str}/5)".strip()


class BookStudyStore:
    """
    Gestiona el cuaderno de lectura de cada libro:
    - Registro de hábitos (cuándo se empezó, cuándo se terminó, cuántas veces se ha leído, sesiones de lectura)
    - Pasajes resaltados (highlights) y notas sobre pasajes
    - Vocabulario buscado/subrayado en el diccionario
    - Generación y exportación automática a Markdown compatible con Obsidian (.md)
    """

    def __init__(self, data_dir: Path, books_dir: Path) -> None:
        self.data_dir = data_dir
        self.books_dir = books_dir
        self.obsidian_dir = data_dir / "obsidian_notes"
        self.obsidian_dir.mkdir(parents=True, exist_ok=True)
        self.study_records_dir = data_dir / "study_records"
        self.study_records_dir.mkdir(parents=True, exist_ok=True)
        self.archived_books_file = data_dir / "archived_books.json"
        self.archived_covers_dir = data_dir / "archived_covers"
        self.archived_covers_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._cached_vaults: Optional[List[Dict[str, str]]] = None
        self._cached_vaults_ts: float = 0.0
        self._cached_obs_cfg: Optional[Dict[str, Any]] = None
        self._cached_obs_cfg_ts: float = 0.0
        self._migrate_legacy_study_files()

    def _migrate_legacy_study_files(self) -> None:
        """Migra ficheros legacy books/<id>/study_data.json a study_records/<id>.json si aún no existen."""
        if not self.books_dir.exists():
            return
        try:
            for d in self.books_dir.iterdir():
                if not d.is_dir():
                    continue
                legacy_sf = d / "study_data.json"
                target_sf = self.study_records_dir / f"{d.name}.json"
                if legacy_sf.exists() and not target_sf.exists():
                    try:
                        shutil.copy2(legacy_sf, target_sf)
                    except Exception:
                        pass
        except Exception:
            pass

    def _study_file(self, book_id: str) -> Path:
        return self.study_records_dir / f"{book_id}.json"

    def _legacy_study_file(self, book_id: str) -> Path:
        return self.books_dir / book_id / "study_data.json"

    def _meta_file(self, book_id: str) -> Path:
        return self.books_dir / book_id / "metadata.json"

    def _load_archived_books_map(self) -> Dict[str, Dict[str, Any]]:
        if not self.archived_books_file.exists():
            return {}
        try:
            data = json.loads(self.archived_books_file.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _get_book_meta(self, book_id: str) -> Dict[str, Any]:
        mf = self._meta_file(book_id)
        if mf.exists():
            try:
                return json.loads(mf.read_text(encoding="utf-8"))
            except Exception:
                pass
        archived = self._load_archived_books_map()
        if book_id in archived and isinstance(archived[book_id], dict):
            return archived[book_id]
        lib_file = self.data_dir / "library.json"
        if lib_file.exists():
            try:
                lib = json.loads(lib_file.read_text(encoding="utf-8"))
                if isinstance(lib, dict) and book_id in lib and isinstance(lib[book_id], dict):
                    return lib[book_id]
            except Exception:
                pass
        return {"id": book_id, "title": book_id, "author": "Desconocido", "language": "es"}

    def _default_study_data(self, book_id: str) -> Dict[str, Any]:
        meta = self._get_book_meta(book_id)
        now = int(time.time())
        return {
            "book_id": book_id,
            "title": meta.get("title", book_id),
            "author": meta.get("author", ""),
            "language": meta.get("language", "es"),
            "genre": meta.get("genre", ""),
            "published_date": meta.get("published_date", ""),
            "reading_status": "reading",  # reading | completed | paused | wishlist
            "started_at": now,
            "finished_at": None,
            "times_read": 1,
            "rating": 0,
            "general_notes": "",
            "auto_underline_lookups": True,
            "vocabulary": [],
            "highlights": [],
            "sessions": [],
            "pairing_info": None,
            "epub_illustrations": [],
            "illustrations_extracted": False,
            "obsidian_linked_relpath": "",
            "last_obsidian_sync_ts": 0,
            "last_obsidian_vault_mtime": 0.0,
            "updated_at": now,
        }

    # =========================================================================
    # CONEXIÓN BIDIRECCIONAL CON BÓVEDA DE OBSIDIAN (VAULT SYNC)
    # =========================================================================
    def _obsidian_config_file(self) -> Path:
        return self.data_dir / "obsidian_config.json"

    def _discover_obsidian_vaults(self, force_refresh: bool = False) -> List[Dict[str, str]]:
        """Detecta automáticamente las bóvedas de Obsidian disponibles en el PC / contenedor (con caché en RAM y máx 2 niveles)."""
        now_t = time.time()
        if not force_refresh and self._cached_vaults is not None and (now_t - self._cached_vaults_ts) < 60.0:
            return self._cached_vaults

        candidates: List[Path] = []
        for root in [
            Path("/app/obsidian_vaults"),
            Path.home() / "obsidian",
            Path.home() / "Obsidian",
            Path.home() / "Documents" / "Obsidian",
        ]:
            if root.exists() and root.is_dir():
                candidates.append(root)

        vaults: List[Dict[str, str]] = []
        seen_paths = set()

        for root in candidates:
            # Buscar carpetas con .obsidian hasta 2 niveles de profundidad sin recorrer toda la bóveda
            try:
                shallow_matches = [
                    root / ".obsidian",
                    *sorted(root.glob("*/.obsidian")),
                    *sorted(root.glob("*/*/.obsidian")),
                ]
                for sub in shallow_matches:
                    if sub.exists() and sub.is_dir():
                        v_dir = sub.parent
                        v_str = str(v_dir.resolve())
                        if v_str not in seen_paths:
                            seen_paths.add(v_str)
                            vaults.append({
                                "name": v_dir.name,
                                "path": v_str,
                                "display_path": v_str,
                            })
            except Exception:
                pass

        self._cached_vaults = vaults
        self._cached_vaults_ts = now_t
        return vaults

    def get_obsidian_config_unlocked(self, force_refresh: bool = False) -> Dict[str, Any]:
        now_t = time.time()
        if not force_refresh and self._cached_obs_cfg is not None and (now_t - self._cached_obs_cfg_ts) < 30.0:
            return dict(self._cached_obs_cfg)

        vaults = self._discover_obsidian_vaults(force_refresh=force_refresh)
        default_vault = vaults[0]["path"] if vaults else str(self.obsidian_dir.resolve())
        default_vault_name = vaults[0]["name"] if vaults else "VozLectura"
        cfg_file = self._obsidian_config_file()
        cfg = {
            "vault_path": default_vault,
            "vault_name": default_vault_name,
            "books_subfolder": "Libros",
            "auto_sync": True,
        }
        if cfg_file.exists():
            try:
                loaded = json.loads(cfg_file.read_text(encoding="utf-8"))
                for k in ("vault_path", "vault_name", "books_subfolder", "auto_sync"):
                    if k in loaded and loaded[k] is not None:
                        cfg[k] = loaded[k]
            except Exception:
                pass

        # Si la ruta configurada no existe pero hay bóvedas detectadas, usar la primera bóveda válida
        if cfg["vault_path"] and not Path(cfg["vault_path"]).exists() and vaults:
            cfg["vault_path"] = vaults[0]["path"]
            cfg["vault_name"] = vaults[0]["name"]

        # coincidir nombre de bóveda
        for v in vaults:
            if v["path"] == cfg["vault_path"]:
                cfg["vault_name"] = v["name"]
                cfg["display_path"] = v["display_path"]
                break
        else:
            cfg["display_path"] = str(cfg["vault_path"])

        cfg["available_vaults"] = vaults
        self._cached_obs_cfg = dict(cfg)
        self._cached_obs_cfg_ts = now_t
        return cfg

    def get_obsidian_config(self, book_id: Optional[str] = None) -> Dict[str, Any]:
        with self._lock:
            cfg = self.get_obsidian_config_unlocked()
            vault_dir = Path(cfg["vault_path"])
            md_files: List[str] = []
            if vault_dir.exists() and vault_dir.is_dir():
                try:
                    for p in sorted(vault_dir.rglob("*.md")):
                        rel = p.relative_to(vault_dir).as_posix()
                        if not any(part.startswith(".") for part in p.parts):
                            md_files.append(rel)
                except Exception:
                    pass
            cfg["vault_md_files"] = md_files[:300]
            if book_id:
                data = self._load_unlocked(book_id)
                target_path, rel_path = self._resolve_obsidian_vault_file_unlocked(book_id, data, cfg)
                cfg["book_linked_relpath"] = rel_path
                cfg["book_vault_file_exists"] = target_path.exists() if target_path else False
                cfg["obsidian_uri"] = self._build_obsidian_uri(cfg.get("vault_name", "Personal"), rel_path)
            return cfg

    def update_obsidian_config(
        self,
        vault_path: Optional[str] = None,
        books_subfolder: Optional[str] = None,
        auto_sync: Optional[bool] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            cfg = self.get_obsidian_config_unlocked()
            if vault_path is not None and vault_path.strip():
                cfg["vault_path"] = vault_path.strip()
            if books_subfolder is not None:
                cfg["books_subfolder"] = re.sub(r'[<>:"|?*]+', "", books_subfolder.strip()).strip("/\\")
            if auto_sync is not None:
                cfg["auto_sync"] = bool(auto_sync)

            for v in cfg.get("available_vaults", []):
                if v["path"] == cfg["vault_path"]:
                    cfg["vault_name"] = v["name"]
                    break

            to_save = {
                "vault_path": cfg["vault_path"],
                "vault_name": cfg.get("vault_name", "Personal"),
                "books_subfolder": cfg["books_subfolder"],
                "auto_sync": cfg["auto_sync"],
            }
            self._obsidian_config_file().write_text(
                json.dumps(to_save, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            self._cached_obs_cfg = None
            self._cached_vaults = None
            return self.get_obsidian_config_unlocked(force_refresh=True)

    def _build_obsidian_uri(self, vault_name: str, rel_path: str) -> str:
        from urllib.parse import quote
        v_enc = quote(vault_name or "Personal", safe="")
        f_enc = quote((rel_path or "").replace("\\", "/"), safe="/")
        return f"obsidian://open?vault={v_enc}&file={f_enc}"

    def _resolve_obsidian_vault_file_unlocked(
        self, book_id: str, data: Dict[str, Any], cfg: Optional[Dict[str, Any]] = None
    ) -> tuple[Optional[Path], str]:
        if cfg is None:
            cfg = self.get_obsidian_config_unlocked()
        vault_dir = Path(cfg.get("vault_path") or "")
        if not vault_dir.exists():
            return None, ""

        linked_rel = (data.get("obsidian_linked_relpath") or "").strip().lstrip("/\\")
        if linked_rel:
            if not linked_rel.lower().endswith(".md"):
                linked_rel += ".md"
            candidate = (vault_dir / linked_rel).resolve()
            if str(candidate).startswith(str(vault_dir.resolve())):
                return candidate, linked_rel.replace("\\", "/")

        safe_title = _safe_filename(data.get("title") or book_id)
        sub = (cfg.get("books_subfolder") or "").strip().strip("/\\")
        rel = f"{sub}/{safe_title}.md" if sub else f"{safe_title}.md"
        target = (vault_dir / rel).resolve()
        if not target.exists():
            # Buscar en subcarpetas de Libros (ej. Libros/Leídos/, Libros/Libros Pendientes/) hasta 2 niveles
            search_root = (vault_dir / sub) if (sub and (vault_dir / sub).exists()) else vault_dir
            try:
                stem_lower = safe_title.lower()
                candidates_md = [*search_root.glob("*.md"), *search_root.glob("*/*.md")]
                for cand in candidates_md:
                    if cand.stem.lower() == stem_lower and not any(part.startswith(".") for part in cand.parts):
                        found_rel = cand.relative_to(vault_dir).as_posix()
                        data["obsidian_linked_relpath"] = found_rel
                        return cand.resolve(), found_rel
            except Exception:
                pass
        return target, rel.replace("\\", "/")

    def _read_study_readonly_unlocked(self, book_id: str) -> Dict[str, Any]:
        """Lee el study record de otro libro sin adquirir bloqueos ni escribir en disco."""
        for cand in (
            self._study_file(book_id),
            self._legacy_study_file(book_id),
        ):
            if cand.exists():
                try:
                    loaded = json.loads(cand.read_text(encoding="utf-8"))
                    if isinstance(loaded, dict):
                        return loaded
                except Exception:
                    pass
        meta = self._get_book_meta(book_id)
        return {
            "book_id": book_id,
            "title": meta.get("title", book_id),
            "author": meta.get("author", ""),
            "language": meta.get("language", "es"),
            "sessions": [],
            "obsidian_linked_relpath": "",
        }

    def _get_pairing_render_context_unlocked(
        self, book_id: str, data: Dict[str, Any], cfg: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        """Obtiene de forma segura (solo lectura) los datos de la edición pareja para enlazar ambas notas en Obsidian."""
        if not book_id:
            return None

        pairing_raw: Optional[Dict[str, Any]] = None
        found_in_active_lib = False
        lib_dict: Dict[str, Any] = {}
        lib_file = self.data_dir / "library.json"
        if lib_file.exists():
            try:
                loaded_lib = json.loads(lib_file.read_text(encoding="utf-8"))
                if isinstance(loaded_lib, dict):
                    lib_dict = loaded_lib
                    if book_id in lib_dict and isinstance(lib_dict[book_id], dict):
                        found_in_active_lib = True
                        p_cand = lib_dict[book_id].get("pairing")
                        if isinstance(p_cand, dict) and p_cand.get("paired_book_id"):
                            pairing_raw = p_cand
            except Exception:
                pass

        if not found_in_active_lib:
            mf = self._meta_file(book_id)
            if mf.exists():
                try:
                    m_data = json.loads(mf.read_text(encoding="utf-8"))
                    p_cand = m_data.get("pairing")
                    if isinstance(p_cand, dict) and p_cand.get("paired_book_id"):
                        pairing_raw = p_cand
                except Exception:
                    pass
            if not pairing_raw and isinstance(data.get("pairing_info"), dict) and data["pairing_info"].get("paired_book_id"):
                pairing_raw = data["pairing_info"]

        if not pairing_raw or not pairing_raw.get("paired_book_id"):
            if found_in_active_lib:
                data["pairing_info"] = None
            return None

        partner_id = str(pairing_raw["paired_book_id"])
        partner_lib = lib_dict.get(partner_id) if isinstance(lib_dict.get(partner_id), dict) else self._get_book_meta(partner_id)
        partner_study = self._read_study_readonly_unlocked(partner_id)

        partner_title = (
            partner_lib.get("title")
            or partner_study.get("title")
            or pairing_raw.get("paired_book_title")
            or partner_id
        )
        partner_lang = (
            partner_lib.get("language")
            or partner_study.get("language")
            or pairing_raw.get("paired_book_lang")
            or "es"
        )

        partner_probe = dict(partner_study)
        if not partner_probe.get("title"):
            partner_probe["title"] = partner_title
        _, partner_rel = self._resolve_obsidian_vault_file_unlocked(partner_id, partner_probe, cfg)
        partner_stem = Path(partner_rel).stem if partner_rel else _safe_filename(partner_title)

        partner_sessions = partner_study.get("sessions") or []
        partner_total_sec = sum(int(s.get("duration_seconds") or 0) for s in partner_sessions)

        ctx = {
            "paired_book_id": partner_id,
            "paired_book_title": partner_title,
            "paired_book_lang": partner_lang,
            "partner_obsidian_note": partner_stem,
            "partner_obsidian_relpath": partner_rel,
            "partner_total_seconds": partner_total_sec,
            "partner_time_human": _format_duration_human(partner_total_sec),
        }
        data["pairing_info"] = {
            "paired_book_id": partner_id,
            "paired_book_title": partner_title,
            "paired_book_lang": partner_lang,
            "partner_obsidian_note": partner_stem,
        }
        return ctx

    def sync_paired_books_obsidian(
        self,
        book_a_id: Optional[str] = None,
        book_b_id: Optional[str] = None,
        unpair_ids: Optional[List[str]] = None,
    ) -> None:
        """Regenera las notas .md de Obsidian de los libros recién emparejados o desemparejados para mantener enlaces recíprocos."""
        with self._lock:
            for uid in (unpair_ids or []):
                if not uid:
                    continue
                try:
                    u_data = self._load_unlocked(str(uid))
                    u_data = self._sync_from_obsidian_vault_if_newer_unlocked(str(uid), u_data)
                    u_data["pairing_info"] = None
                    self._save_unlocked(str(uid), u_data)
                except Exception as exc:
                    logger.debug("Error actualizando nota Obsidian tras desvincular %s: %s", uid, exc)

            for bid in filter(None, [book_a_id, book_b_id]):
                try:
                    b_data = self._load_unlocked(str(bid))
                    b_data = self._sync_from_obsidian_vault_if_newer_unlocked(str(bid), b_data)
                    self._get_pairing_render_context_unlocked(str(bid), b_data)
                    self._save_unlocked(str(bid), b_data)
                except Exception as exc:
                    logger.debug("Error actualizando nota Obsidian tras emparejar %s: %s", bid, exc)

    def find_obsidian_attachment(self, name: str) -> Optional[Path]:
        """Busca una imagen o adjunto incrustado de Obsidian (![[archivo.png]]) dentro de la bóveda activa."""
        clean_name = (name or "").strip().split("|")[0].strip().lstrip("/\\")
        if not clean_name or ".." in clean_name:
            return None
        with self._lock:
            cfg = self.get_obsidian_config_unlocked()
        vault_dir = Path(cfg.get("vault_path") or "")
        if not vault_dir.exists():
            return None
        direct = (vault_dir / clean_name).resolve()
        if direct.exists() and direct.is_file() and str(direct).startswith(str(vault_dir.resolve())):
            return direct
        sub = (cfg.get("books_subfolder") or "").strip().strip("/\\")
        if sub:
            sub_direct = (vault_dir / sub / clean_name).resolve()
            if sub_direct.exists() and sub_direct.is_file() and str(sub_direct).startswith(str(vault_dir.resolve())):
                return sub_direct
            illus_root = vault_dir / sub / "Ilustraciones"
            if illus_root.exists():
                target_lower = Path(clean_name).name.lower()
                for cand_img in illus_root.glob("*/*"):
                    if cand_img.is_file() and cand_img.name.lower() == target_lower:
                        return cand_img.resolve()
        target_name_lower = Path(clean_name).name.lower()
        try:
            for p in vault_dir.rglob("*"):
                if p.is_file() and p.name.lower() == target_name_lower:
                    return p.resolve()
        except Exception:
            pass
        return None

    def _ensure_epub_illustrations_unlocked(
        self, book_id: str, data: Dict[str, Any], force: bool = False
    ) -> bool:
        """
        Si el libro está en estado 'reading' y aún no se han analizado sus ilustraciones internas,
        extrae automáticamente mapas, guardas e ilustraciones del EPUB hacia Libros/Ilustraciones/<Título>/
        y las incorpora a la nota de Obsidian.
        """
        if not force:
            if data.get("reading_status", "reading") != "reading":
                return False
            if data.get("illustrations_extracted"):
                return False

        epub_candidates = [
            self.books_dir / book_id / "book.epub",
        ]
        epub_path = next((p for p in epub_candidates if p.exists()), None)
        if not epub_path:
            return False

        try:
            cfg = self.get_obsidian_config_unlocked()
            vault_dir = Path(cfg.get("vault_path") or "")
            sub = (cfg.get("books_subfolder") or "").strip().strip("/\\")
            if vault_dir.exists():
                books_root = (vault_dir / sub) if sub else vault_dir
            else:
                books_root = self.obsidian_dir

            safe_title = _safe_filename(data.get("title") or book_id)
            dest_images_dir = books_root / "Ilustraciones" / safe_title
            extracted = extract_relevant_epub_illustrations(
                epub_path=epub_path,
                dest_book_images_dir=dest_images_dir,
                book_title=data.get("title") or book_id,
            )
            data["illustrations_extracted"] = True
            if extracted:
                data["epub_illustrations"] = extracted
            return True
        except Exception as exc:
            logger.warning("No se pudieron extraer ilustraciones de %s: %s", book_id, exc)
            return False

    def get_study_data(self, book_id: str, sync_obsidian: bool = True) -> Dict[str, Any]:
        with self._lock:
            data = self._load_unlocked(book_id)
            if sync_obsidian:
                data = self._sync_from_obsidian_vault_if_newer_unlocked(book_id, data)
            prev_pair = data.get("pairing_info")
            self._get_pairing_render_context_unlocked(book_id, data)
            pair_changed = data.get("pairing_info") != prev_pair
            if pair_changed and not sync_obsidian:
                data = self._sync_from_obsidian_vault_if_newer_unlocked(book_id, data)
                self._get_pairing_render_context_unlocked(book_id, data)
            ill_changed = self._ensure_epub_illustrations_unlocked(book_id, data)
            if pair_changed or ill_changed:
                self._save_unlocked(book_id, data)
            return self._enrich_stats(data)

    def _sanitize_and_recalibrate_sessions_unlocked(self, data: Dict[str, Any]) -> bool:
        """
        Limpia sesiones fantasma (0-1 frases sin nota creadas al abrir un libro o dejar una pestaña en pausa)
        y recalibra sesiones cuya duración quedó inflada por tiempo de reloj de pared con la pestaña en pausa
        (ajustándolas al tiempo real de escucha/lectura según las frases leídas: ~4.0s por frase).
        """
        raw_sessions = data.get("sessions")
        if not isinstance(raw_sessions, list) or not raw_sessions:
            return False

        changed = False
        cleaned: List[Dict[str, Any]] = []
        for s in raw_sessions:
            if not isinstance(s, dict):
                changed = True
                continue
            sid = str(s.get("id") or "")
            sents = int(s.get("sentences_read") or 0)
            dur = int(s.get("duration_seconds") or 0)
            note = str(s.get("note") or "").strip()

            # 1. Eliminar sesiones automáticas vacías (0 o 1 frase sin nota manual)
            if sents <= 1 and not note:
                changed = True
                continue

            # 2. Recalibrar sesiones con frases leídas cuya duración excede el tiempo real máximo (~5.2s/frase)
            # o sesiones offline estimadas previamente para que reflejen exactamente el ritmo real (~4.0s/frase)
            if sents >= 2:
                realistic_max_sec = max(60, int(round(sents * 5.2)))
                realistic_target_sec = max(45, int(round(sents * 4.0)))
                if dur > realistic_max_sec or sid.startswith("sess_offline_"):
                    if dur != realistic_target_sec:
                        s["duration_seconds"] = realistic_target_sec
                        started_ts = int(s.get("started_at") or 0)
                        if started_ts > 0:
                            s["ended_at"] = started_ts + realistic_target_sec
                        changed = True

            cleaned.append(s)

        if changed:
            cleaned.sort(key=lambda x: int(x.get("started_at") or 0), reverse=True)
            data["sessions"] = cleaned
        return changed

    def _load_unlocked(self, book_id: str) -> Dict[str, Any]:
        sf = self._study_file(book_id)
        source_file = sf if sf.exists() else None
        if source_file is None:
            legacy = self._legacy_study_file(book_id)
            if legacy.exists():
                source_file = legacy

        if source_file is None:
            data = self._default_study_data(book_id)
            self._save_unlocked(book_id, data)
            return data
        try:
            data = json.loads(source_file.read_text(encoding="utf-8"))
            defaults = self._default_study_data(book_id)
            dirty = not sf.exists()
            for k, v in defaults.items():
                if k not in data:
                    data[k] = v
                    dirty = True
            if self._sanitize_and_recalibrate_sessions_unlocked(data):
                dirty = True
            if dirty:
                self._save_unlocked(book_id, data)
            return data
        except Exception as exc:
            logger.warning("Error leyendo study_data.json de %s: %s", book_id, exc)
            return self._default_study_data(book_id)

    def _sync_from_obsidian_vault_if_newer_unlocked(
        self, book_id: str, data: Dict[str, Any], force: bool = False
    ) -> Dict[str, Any]:
        """Si la nota .md en la bóveda de Obsidian fue editada desde Obsidian, importa e integra sus cambios en la app."""
        try:
            cfg = self.get_obsidian_config_unlocked()
            if not cfg.get("auto_sync", True) and not force:
                return data
            vault_file, rel_path = self._resolve_obsidian_vault_file_unlocked(book_id, data, cfg)
            if not vault_file:
                return data

            if not vault_file.exists():
                # Si aún no existe en la bóveda de Obsidian, crearla automáticamente
                self._save_unlocked(book_id, data)
                return data

            file_mtime = vault_file.stat().st_mtime
            last_known_mtime = float(data.get("last_obsidian_vault_mtime") or 0.0)
            if not force and file_mtime <= last_known_mtime + 0.5:
                return data

            md_text = vault_file.read_text(encoding="utf-8")
            changed = self._parse_and_merge_obsidian_markdown_unlocked(data, md_text)
            data["obsidian_linked_relpath"] = rel_path
            data["last_obsidian_sync_ts"] = int(time.time())
            data["last_obsidian_vault_mtime"] = file_mtime
            if changed or force:
                self._save_unlocked(book_id, data)
        except Exception as exc:
            logger.debug("No se pudo sincronizar desde bóveda Obsidian (%s): %s", book_id, exc)
        return data

    def _parse_and_merge_obsidian_markdown_unlocked(
        self, data: Dict[str, Any], md_text: str
    ) -> bool:
        """
        Analiza un archivo Markdown de Obsidian (tanto el generado por VozLectura como notas escritas libremente en Obsidian)
        e integra las notas, metadatos (YAML frontmatter), reflexiones y citas directamente en el cuaderno del libro.
        """
        if not md_text or not md_text.strip():
            return False

        changed = False
        body = md_text.replace("\r\n", "\n")

        # 1. Extraer YAML Frontmatter si existe
        fm_match = re.match(r"^---\n([\s\S]*?)\n---\n?", body)
        if fm_match:
            fm_block = fm_match.group(1)
            body = body[fm_match.end() :]

            status_m = re.search(r"(?m)^(?:status|estado):\s*([^\n]+?)\s*$", fm_block)
            if status_m:
                raw_st = status_m.group(1).strip().strip('"\'').lower()
                es_to_en = {
                    "leyendo": "reading",
                    "reading": "reading",
                    "leido": "completed",
                    "leído": "completed",
                    "terminado": "completed",
                    "completed": "completed",
                    "pausado": "paused",
                    "abandonado": "paused",
                    "paused": "paused",
                    "pendiente": "wishlist",
                    "wishlist": "wishlist",
                }
                st_val = es_to_en.get(raw_st)
                if st_val and st_val != data.get("reading_status"):
                    data["reading_status"] = st_val
                    if st_val == "completed" and not data.get("finished_at"):
                        data["finished_at"] = int(time.time())
                    changed = True

            rating_m = re.search(r"(?m)^(?:rating|calificacion|calificación):\s*(\d+(?:[.,]\d+)?)\s*$", fm_block)
            if rating_m:
                r_val = _normalize_half_star_rating(rating_m.group(1).replace(",", "."))
                if r_val != _normalize_half_star_rating(data.get("rating")):
                    data["rating"] = r_val
                    changed = True

            times_m = re.search(r"(?m)^(?:times_read|Nº Lecturas|n_lecturas):\s*(\d+)\s*$", fm_block)
            if times_m:
                t_val = max(0, int(times_m.group(1)))
                if t_val != int(data.get("times_read") or 1):
                    data["times_read"] = t_val
                    changed = True

            genre_m = re.search(r'(?m)^(?:genre|genero|género):\s*"?([^"\n]+)"?\s*$', fm_block)
            if genre_m:
                g_val = genre_m.group(1).strip()
                if g_val and g_val != "—" and g_val != data.get("genre"):
                    data["genre"] = g_val
                    changed = True

            author_m = re.search(r'(?m)^author:\s*"?([^"\n]+)"?\s*$', fm_block)
            if author_m:
                a_val = author_m.group(1).strip()
                if a_val and a_val != "—" and (not data.get("author") or data.get("author") in ("Desconocido", "Autor desconocido")):
                    data["author"] = a_val
                    changed = True

            lang_m = re.search(r"(?m)^language:\s*([^\n]+?)\s*$", fm_block)
            if lang_m:
                l_val = lang_m.group(1).strip().strip('"\'')
                if l_val and not data.get("language"):
                    data["language"] = l_val
                    changed = True

            started_m = re.search(r"(?m)^(?:started|fecha_inicio):\s*(\d{4}-\d{2}-\d{2})\s*$", fm_block)
            if started_m and not data.get("started_at"):
                try:
                    dt_s = datetime.datetime.strptime(started_m.group(1), "%Y-%m-%d").replace(hour=12)
                    data["started_at"] = int(dt_s.timestamp())
                    changed = True
                except Exception:
                    pass

            finished_m = re.search(r"(?m)^(?:finished|fecha_fin):\s*(\d{4}-\d{2}-\d{2})\s*$", fm_block)
            if finished_m and not data.get("finished_at"):
                try:
                    dt_f = datetime.datetime.strptime(finished_m.group(1), "%Y-%m-%d").replace(hour=12)
                    data["finished_at"] = int(dt_f.timestamp())
                    changed = True
                except Exception:
                    pass

        # 2. Analizar secciones ## del cuerpo Markdown
        placeholder_notes = (
            "_Escribe aquí tus notas, ideas o reflexiones (en la app o directamente en Obsidian)..._",
            "_Write your general notes, ideas, or reflections here (in the app or directly in Obsidian)..._",
        )
        sections = re.split(r"(?m)^(?=##\s+)", body)
        extracted_notes_parts: List[str] = []

        # Comprobar si el encabezado previo al primer ## tiene texto libre añadido por el usuario en Obsidian
        preamble = sections[0] if sections else ""
        preamble_lines = []
        in_paired_callout = False
        for line in preamble.splitlines():
            s_line = line.strip()
            if s_line.startswith("# 📖 ") or s_line.startswith("**Autor:**") or s_line.startswith("**Author:**"):
                in_paired_callout = False
                continue
            if s_line.startswith("> [!abstract] 🌐"):
                in_paired_callout = True
                continue
            if in_paired_callout:
                if s_line.startswith(">"):
                    continue
                in_paired_callout = False
            preamble_lines.append(line)
        preamble_clean = "\n".join(preamble_lines).strip()
        if preamble_clean:
            extracted_notes_parts.append(preamble_clean)

        for sec in sections[1:]:
            lines = sec.splitlines()
            if not lines:
                continue
            heading = lines[0].strip()
            sec_body = "\n".join(lines[1:]).strip()

            if heading.startswith("## 📊 Registro de Hábitos") or heading.startswith("## 📊 Reading Habits"):
                continue
            elif heading.startswith("## 💭 Notas Generales") or heading.startswith("## 💭 General Notes"):
                cleaned_sec = sec_body
                for ph in placeholder_notes:
                    cleaned_sec = cleaned_sec.replace(ph, "")
                cleaned_sec = cleaned_sec.strip()
                if cleaned_sec:
                    extracted_notes_parts.append(cleaned_sec)
            elif heading.startswith("## 🖍️ Pasajes Resaltados") or heading.startswith("## 🖍️ Highlighted Passages"):
                # Sincronizar notas editadas en pasajes existentes o nuevos bloques citados en Obsidian
                if self._sync_highlights_from_markdown_section_unlocked(data, sec_body):
                    changed = True
            elif heading.startswith("## 📚 Vocabulario") or heading.startswith("## 📚 Vocabulary"):
                if not data.get("vocabulary") and self._sync_vocabulary_from_markdown_section_unlocked(data, sec_body):
                    changed = True
                continue
            elif heading.startswith("## ⏱️ Historial de Sesiones") or heading.startswith("## ⏱️ Reading Sessions"):
                if not data.get("sessions") and self._sync_sessions_from_markdown_section_unlocked(data, sec_body):
                    changed = True
                continue
            elif heading.startswith("## 🗺️ Mapas e Ilustraciones") or heading.startswith("## 🗺️ Maps & Illustrations"):
                parsed_ills: List[Dict[str, Any]] = []
                last_lbl = ""
                for raw_l in sec_body.splitlines():
                    cl = raw_l.lstrip(">").strip()
                    if cl.startswith("[!"):
                        continue
                    m_lbl = re.match(r"^\*\*(?:\d+\.\s*)?(.+?)\*\*$", cl)
                    if m_lbl:
                        last_lbl = m_lbl.group(1).strip()
                        continue
                    m_emb = re.search(r"!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]", cl)
                    if m_emb:
                        fn = Path(m_emb.group(1).strip()).name
                        parsed_ills.append({"filename": fn, "label": last_lbl or Path(fn).stem})
                        last_lbl = ""
                if parsed_ills and parsed_ills != data.get("epub_illustrations"):
                    data["epub_illustrations"] = parsed_ills
                    data["illustrations_extracted"] = True
                    changed = True
                continue
            else:
                # Cualquier otra sección ## creada por el usuario en Obsidian (ej. ## Ideas clave, ## Personajes, etc.)
                # se conserva e integra directamente en las notas generales del libro en la app
                full_custom_sec = f"{heading}\n{sec_body}".strip()
                if full_custom_sec:
                    extracted_notes_parts.append(full_custom_sec)

        # Si el archivo de Obsidian no tenía ninguna sección de VozLectura (nota libre creada en Obsidian),
        # importar todo el cuerpo limpio como notas del libro
        if len(sections) <= 1 and preamble_clean:
            new_general_notes = preamble_clean
        else:
            new_general_notes = "\n\n".join(p for p in extracted_notes_parts if p).strip()

        old_general_notes = (data.get("general_notes") or "").strip()
        if new_general_notes != old_general_notes:
            data["general_notes"] = new_general_notes
            changed = True

        return changed

    def _sync_highlights_from_markdown_section_unlocked(
        self, data: Dict[str, Any], sec_body: str
    ) -> bool:
        if (
            not sec_body
            or "_Aún no hay pasajes resaltados" in sec_body
            or "_No highlighted passages" in sec_body
        ):
            return False
        changed = False
        highlights: List[Dict[str, Any]] = data.get("highlights") or []
        blocks = re.split(r"(?m)^###\s+📍\s+", sec_body)
        for blk in blocks[1:]:
            blk_lines = blk.strip().splitlines()
            if not blk_lines:
                continue
            header_line = blk_lines[0].strip()
            ch_title = re.sub(r"\s*_\([^)]+\)_\s*$", "", header_line).strip()
            quote_lines: List[str] = []
            note_text = ""
            for bl in blk_lines[1:]:
                s_bl = bl.strip()
                if s_bl.startswith("> [!quote]"):
                    continue
                elif s_bl.startswith(">"):
                    quote_lines.append(s_bl.lstrip(">").strip())
                elif s_bl.startswith("**📝 Nota:**") or s_bl.startswith("**📝 Note:**"):
                    note_text = re.sub(r"^\*\*📝\s*(?:Nota|Note):\*\*\s*", "", s_bl).strip()
            quote_str = "\n".join(quote_lines).strip()
            if not quote_str:
                continue
            existing = next(
                (h for h in highlights if (h.get("text") or "").strip() == quote_str),
                None,
            )
            if existing:
                if note_text and existing.get("note") != note_text:
                    existing["note"] = note_text
                    existing["updated_at"] = int(time.time())
                    changed = True
            else:
                highlights.insert(
                    0,
                    {
                        "id": f"hl_{uuid.uuid4().hex[:10]}",
                        "text": quote_str,
                        "note": note_text,
                        "color": "yellow",
                        "chapter_index": 0,
                        "chapter_title": ch_title or "Nota desde Obsidian",
                        "sentence_indices": [],
                        "created_at": int(time.time()),
                        "updated_at": int(time.time()),
                    },
                )
                changed = True
        data["highlights"] = highlights
        return changed

    def _sync_vocabulary_from_markdown_section_unlocked(
        self, data: Dict[str, Any], sec_body: str
    ) -> bool:
        if (
            not sec_body
            or "_Aún no hay palabras guardadas" in sec_body
            or "_No vocabulary words saved yet" in sec_body
        ):
            return False
        recovered: List[Dict[str, Any]] = []
        cur_entry: Optional[Dict[str, Any]] = None
        now_ts = int(time.time())
        for raw_line in sec_body.splitlines():
            s_raw = raw_line.strip()
            m_head = re.match(
                r"^- \*\*(.+?)\*\*(?:\s+`/([^/`]+)/`)?\s+→\s+\*\*(.+?)\*\*\s+_\((?:consultada|looked up)\s+(\d+)\s+(?:ve(?:z|ces)|times?)\s+•\s+(.+?)\)_\s*$",
                s_raw,
            )
            if m_head:
                if cur_entry:
                    recovered.append(cur_entry)
                w_txt = m_head.group(1).strip()
                cur_entry = {
                    "id": f"voc_{uuid.uuid4().hex[:10]}",
                    "word": w_txt,
                    "lemma": w_txt.lower(),
                    "phonetic": (m_head.group(2) or "").strip(),
                    "source_lang": data.get("language", "es")[:2],
                    "translation": m_head.group(3).strip(),
                    "definitions_summary": "",
                    "context_sentence": "",
                    "context_translation": "",
                    "chapter_index": 0,
                    "chapter_title": m_head.group(5).strip(),
                    "sentence_index": 0,
                    "user_note": "",
                    "note": "",
                    "lookup_count": max(1, int(m_head.group(4) or 1)),
                    "created_at": now_ts,
                    "updated_at": now_ts,
                }
                continue
            if cur_entry:
                s = raw_line.strip()
                if s.startswith("- *Definición:*") or s.startswith("- *Definition:*"):
                    cur_entry["definitions_summary"] = re.sub(
                        r"^- \*(?:Definición|Definition):\*\s*", "", s
                    ).strip()
                elif s.startswith("- *Contexto en el libro:*") or s.startswith("- *Context in book:*"):
                    ctx = re.sub(
                        r"^- \*(?:Contexto en el libro|Context in book):\*\s*", "", s
                    ).strip().strip("«»")
                    cur_entry["context_sentence"] = ctx
                elif s.startswith("- *Traducción del contexto:*") or s.startswith("- *Context translation:*"):
                    ct = re.sub(
                        r"^- \*(?:Traducción del contexto|Context translation):\*\s*", "", s
                    ).strip().strip("«»")
                    cur_entry["context_translation"] = ct
                elif s.startswith("- *Nota personal:*") or s.startswith("- *Personal note:*"):
                    nt = re.sub(
                        r"^- \*(?:Nota personal|Personal note):\*\s*", "", s
                    ).strip()
                    cur_entry["user_note"] = nt
                    cur_entry["note"] = nt
        if cur_entry:
            recovered.append(cur_entry)
        if recovered:
            data["vocabulary"] = recovered
            return True
        return False

    def _sync_sessions_from_markdown_section_unlocked(
        self, data: Dict[str, Any], sec_body: str
    ) -> bool:
        if (
            not sec_body
            or "_Aún no se han registrado sesiones" in sec_body
            or "_No reading sessions recorded yet" in sec_body
        ):
            return False
        recovered: List[Dict[str, Any]] = []
        for raw_line in sec_body.splitlines():
            s = raw_line.strip()
            if (
                not s.startswith("|")
                or s.startswith("| Fecha |")
                or s.startswith("| Date |")
                or s.startswith("| :---")
            ):
                continue
            parts = [p.strip() for p in s.strip("|").split("|")]
            if len(parts) < 5:
                continue
            date_s, time_s, dur_s, ch_s, fr_s = parts[:5]
            note_s = parts[5] if len(parts) > 5 else ""
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_s):
                continue
            hh, mm = 12, 0
            m_t = re.match(r"^(\d{1,2}):(\d{2})$", time_s)
            if m_t:
                hh, mm = int(m_t.group(1)), int(m_t.group(2))
            try:
                started_ts = int(datetime.datetime.strptime(f"{date_s} {hh:02d}:{mm:02d}", "%Y-%m-%d %H:%M").timestamp())
            except Exception:
                continue
            dur_sec = 60
            m_hm = re.search(r"(\d+)\s*h\s*(\d+)\s*min", dur_s)
            m_m = re.search(r"(\d+)\s*min", dur_s)
            if m_hm:
                dur_sec = (int(m_hm.group(1)) * 60 + int(m_hm.group(2))) * 60
            elif m_m:
                dur_sec = max(1, int(m_m.group(1))) * 60
            sc, ec = 0, 0
            ch_title = ch_s
            m_ch_rng = re.match(r"^(?:Cap\.|Ch\.)\s*(\d+)(?:\s*→\s*(\d+))?(?:\s*\((.+)\))?$", ch_s)
            if m_ch_rng:
                sc = max(0, int(m_ch_rng.group(1)) - 1)
                ec = max(sc, int(m_ch_rng.group(2) or m_ch_rng.group(1)) - 1)
                if m_ch_rng.group(3):
                    ch_title = m_ch_rng.group(3).strip()
            try:
                sents_read = max(0, int(fr_s))
            except Exception:
                sents_read = 0
            recovered.append({
                "id": f"sess_md_{uuid.uuid4().hex[:8]}",
                "started_at": started_ts,
                "ended_at": started_ts + dur_sec,
                "duration_seconds": dur_sec,
                "start_chapter": sc,
                "end_chapter": ec,
                "chapter_title": ch_title,
                "sentences_read": sents_read,
                "note": note_s,
            })
        if recovered:
            recovered.sort(key=lambda x: int(x.get("started_at") or 0), reverse=True)
            data["sessions"] = recovered
            return True
        return False

    def migrate_book_id(
        self, old_book_id: str, new_book_id: str, new_meta: Optional[Dict[str, Any]] = None
    ) -> bool:
        """Revincula el cuaderno de estudio y sesiones de un libro archivado a un nuevo book_id."""
        with self._lock:
            if not old_book_id or not new_book_id:
                return False
            if old_book_id == new_book_id:
                return True
            data = self._load_unlocked(old_book_id)
            data["book_id"] = new_book_id
            if isinstance(new_meta, dict):
                if new_meta.get("title"):
                    data["title"] = new_meta["title"]
                if new_meta.get("author") and (not data.get("author") or data.get("author") in ("Desconocido", "Autor desconocido")):
                    data["author"] = new_meta["author"]
                if new_meta.get("language"):
                    data["language"] = new_meta["language"]
            self._save_unlocked(new_book_id, data)
            old_sf = self._study_file(old_book_id)
            if old_sf.exists():
                try:
                    old_sf.unlink()
                except Exception:
                    pass
            return True

    def delete_study_data(self, book_id: str) -> None:
        with self._lock:
            sf = self._study_file(book_id)
            if sf.exists():
                try:
                    sf.unlink()
                except Exception:
                    pass

    def sync_book_with_obsidian(
        self, book_id: str, link_relpath: Optional[str] = None
    ) -> Dict[str, Any]:
        """Sincroniza inmediatamente el libro con su archivo .md en la bóveda de Obsidian (o lo vincula a un archivo .md existente)."""
        with self._lock:
            data = self._load_unlocked(book_id)
            if link_relpath is not None:
                data["obsidian_linked_relpath"] = link_relpath.strip()
                data["last_obsidian_vault_mtime"] = 0.0
            self._get_pairing_render_context_unlocked(book_id, data)
            data = self._sync_from_obsidian_vault_if_newer_unlocked(book_id, data, force=True)
            md_text = self._render_obsidian_markdown(data)
            cfg = self.get_obsidian_config_unlocked()
            _, rel_path = self._resolve_obsidian_vault_file_unlocked(book_id, data, cfg)
            return {
                "study": self._enrich_stats(data),
                "obsidian_markdown": md_text,
                "obsidian_config": {
                    **cfg,
                    "book_linked_relpath": rel_path,
                    "obsidian_uri": self._build_obsidian_uri(cfg.get("vault_name", "Personal"), rel_path),
                },
            }

    def save_raw_obsidian_markdown(self, book_id: str, md_text: str) -> Dict[str, Any]:
        """Guarda y parsea ediciones hechas directamente sobre el Markdown de Obsidian en la app o al importar un archivo .md."""
        with self._lock:
            data = self._load_unlocked(book_id)
            self._parse_and_merge_obsidian_markdown_unlocked(data, md_text)
            self._save_unlocked(book_id, data)
            rendered = self._render_obsidian_markdown(data)
            return {
                "study": self._enrich_stats(data),
                "obsidian_markdown": rendered,
            }

    def _save_unlocked(self, book_id: str, data: Dict[str, Any]) -> None:
        sf = self._study_file(book_id)
        sf.parent.mkdir(parents=True, exist_ok=True)
        now_ts = int(time.time())
        data["updated_at"] = now_ts
        book_dir = self.books_dir / book_id
        try:
            md_text = self._render_obsidian_markdown(data)
            if book_dir.is_dir():
                (book_dir / "obsidian_note.md").write_text(md_text, encoding="utf-8")
            safe_title = _safe_filename(data.get("title") or book_id)
            (self.obsidian_dir / f"{safe_title}.md").write_text(md_text, encoding="utf-8")

            # Escribir directamente en la bóveda activa de Obsidian configurada por el usuario
            cfg = self.get_obsidian_config_unlocked()
            if cfg.get("auto_sync", True):
                vault_file, rel_path = self._resolve_obsidian_vault_file_unlocked(book_id, data, cfg)
                if vault_file:
                    vault_file.parent.mkdir(parents=True, exist_ok=True)
                    vault_file.write_text(md_text, encoding="utf-8")
                    data["obsidian_linked_relpath"] = rel_path
                    data["last_obsidian_sync_ts"] = now_ts
                    try:
                        data["last_obsidian_vault_mtime"] = vault_file.stat().st_mtime
                    except Exception:
                        pass
        except Exception as exc:
            logger.debug("No se pudo sincronizar archivo Markdown Obsidian: %s", exc)

        json_text = json.dumps(data, ensure_ascii=False, indent=2)
        sf.write_text(json_text, encoding="utf-8")
        if book_dir.is_dir():
            try:
                (book_dir / "study_data.json").write_text(json_text, encoding="utf-8")
            except Exception:
                pass

    def _enrich_stats(self, data: Dict[str, Any]) -> Dict[str, Any]:
        sessions = data.get("sessions") or []
        total_sec = sum(int(s.get("duration_seconds") or 0) for s in sessions)
        unique_days = {
            _format_ts_date(s.get("started_at"))
            for s in sessions
            if s.get("started_at")
        }
        out = dict(data)
        out["stats"] = {
            "total_seconds": total_sec,
            "total_time_human": _format_duration_human(total_sec),
            "session_count": len(sessions),
            "days_read_count": len(unique_days),
            "vocabulary_count": len(data.get("vocabulary") or []),
            "highlights_count": len(data.get("highlights") or []),
            "started_date_str": _format_ts_date(data.get("started_at")),
            "finished_date_str": _format_ts_date(data.get("finished_at"))
            if data.get("finished_at")
            else "En curso",
        }
        return out

    def update_reading_meta(
        self,
        book_id: str,
        reading_status: Optional[str] = None,
        started_date: Optional[str] = None,
        finished_date: Optional[str] = None,
        times_read: Optional[int] = None,
        rating: Optional[float] = None,
        general_notes: Optional[str] = None,
        auto_underline_lookups: Optional[bool] = None,
        genre: Optional[str] = None,
        published_date: Optional[str] = None,
        author: Optional[str] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            data = self._load_unlocked(book_id)
            if reading_status is not None:
                data["reading_status"] = reading_status
                if reading_status == "completed" and not data.get("finished_at"):
                    data["finished_at"] = int(time.time())
            if started_date is not None:
                if started_date.strip():
                    try:
                        dt = datetime.datetime.strptime(started_date.strip(), "%Y-%m-%d")
                        data["started_at"] = int(dt.timestamp())
                    except Exception:
                        pass
            if finished_date is not None:
                if not finished_date.strip():
                    data["finished_at"] = None
                else:
                    try:
                        dt = datetime.datetime.strptime(finished_date.strip(), "%Y-%m-%d")
                        data["finished_at"] = int(dt.timestamp())
                    except Exception:
                        pass
            if times_read is not None:
                data["times_read"] = max(0, int(times_read))
            if rating is not None:
                data["rating"] = _normalize_half_star_rating(rating)
            if general_notes is not None:
                data["general_notes"] = general_notes
            if auto_underline_lookups is not None:
                data["auto_underline_lookups"] = bool(auto_underline_lookups)
            if genre is not None:
                data["genre"] = genre.strip()
            if published_date is not None:
                data["published_date"] = published_date.strip()
            if author is not None and author.strip():
                data["author"] = author.strip()

            if data.get("reading_status") == "reading" and not data.get("illustrations_extracted"):
                self._ensure_epub_illustrations_unlocked(book_id, data)

            self._save_unlocked(book_id, data)
            return self._enrich_stats(data)

    def add_or_update_vocabulary(
        self,
        book_id: str,
        word: str,
        lemma: str = "",
        phonetic: str = "",
        source_lang: str = "en",
        translation: str = "",
        definitions_summary: str = "",
        context_sentence: str = "",
        context_translation: str = "",
        chapter_index: int = 0,
        chapter_title: str = "",
        sentence_index: int = 0,
        user_note: str = "",
    ) -> Dict[str, Any]:
        clean_w = (word or "").strip()
        if not clean_w:
            raise ValueError("Palabra vacía")

        with self._lock:
            data = self._load_unlocked(book_id)
            vocab_list: List[Dict[str, Any]] = data.get("vocabulary") or []
            now = int(time.time())

            existing = next(
                (
                    v
                    for v in vocab_list
                    if v.get("word", "").lower() == clean_w.lower()
                ),
                None,
            )

            if existing:
                existing["lookup_count"] = int(existing.get("lookup_count") or 1) + 1
                if translation:
                    existing["translation"] = translation
                if phonetic:
                    existing["phonetic"] = phonetic
                if definitions_summary:
                    existing["definitions_summary"] = definitions_summary
                if context_sentence:
                    existing["context_sentence"] = context_sentence
                if context_translation:
                    existing["context_translation"] = context_translation
                if user_note:
                    existing["user_note"] = user_note
                    existing["note"] = user_note
                existing["updated_at"] = now
                entry = existing
            else:
                entry = {
                    "id": f"voc_{uuid.uuid4().hex[:10]}",
                    "word": clean_w,
                    "lemma": lemma or clean_w.lower(),
                    "phonetic": phonetic,
                    "source_lang": source_lang,
                    "translation": translation,
                    "definitions_summary": definitions_summary,
                    "context_sentence": context_sentence,
                    "context_translation": context_translation,
                    "chapter_index": chapter_index,
                    "chapter_title": chapter_title,
                    "sentence_index": sentence_index,
                    "user_note": user_note,
                    "note": user_note,
                    "lookup_count": 1,
                    "created_at": now,
                    "updated_at": now,
                }
                vocab_list.insert(0, entry)

            data["vocabulary"] = vocab_list
            self._save_unlocked(book_id, data)
            return {"entry": entry, "study": self._enrich_stats(data)}

    def update_vocabulary_note(
        self, book_id: str, vocab_id: str, user_note: str, translation: Optional[str] = None
    ) -> Dict[str, Any]:
        with self._lock:
            data = self._load_unlocked(book_id)
            for v in data.get("vocabulary") or []:
                if v.get("id") == vocab_id:
                    v["user_note"] = user_note
                    v["note"] = user_note
                    if translation is not None and translation.strip():
                        v["translation"] = translation.strip()
                    v["updated_at"] = int(time.time())
                    break
            self._save_unlocked(book_id, data)
            return self._enrich_stats(data)

    def delete_vocabulary(self, book_id: str, vocab_id: str) -> Dict[str, Any]:
        with self._lock:
            data = self._load_unlocked(book_id)
            data["vocabulary"] = [
                v for v in (data.get("vocabulary") or []) if v.get("id") != vocab_id
            ]
            self._save_unlocked(book_id, data)
            return self._enrich_stats(data)

    def add_highlight(
        self,
        book_id: str,
        text: str,
        note: str = "",
        color: str = "yellow",
        chapter_index: int = 0,
        chapter_title: str = "",
        sentence_indices: Optional[List[int]] = None,
    ) -> Dict[str, Any]:
        clean_txt = (text or "").strip()
        if not clean_txt:
            raise ValueError("El texto resaltado no puede estar vacío")

        with self._lock:
            data = self._load_unlocked(book_id)
            hl_list: List[Dict[str, Any]] = data.get("highlights") or []
            now = int(time.time())

            entry = {
                "id": f"hl_{uuid.uuid4().hex[:10]}",
                "text": clean_txt,
                "note": (note or "").strip(),
                "color": color if color in ("yellow", "green", "blue", "pink") else "yellow",
                "chapter_index": chapter_index,
                "chapter_title": chapter_title or f"Capítulo {chapter_index + 1}",
                "sentence_indices": sentence_indices or [],
                "created_at": now,
                "updated_at": now,
            }
            hl_list.insert(0, entry)
            data["highlights"] = hl_list
            self._save_unlocked(book_id, data)
            return {"entry": entry, "study": self._enrich_stats(data)}

    def update_highlight(
        self,
        book_id: str,
        highlight_id: str,
        note: Optional[str] = None,
        color: Optional[str] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            data = self._load_unlocked(book_id)
            for h in data.get("highlights") or []:
                if h.get("id") == highlight_id:
                    if note is not None:
                        h["note"] = note.strip()
                    if color in ("yellow", "green", "blue", "pink"):
                        h["color"] = color
                    h["updated_at"] = int(time.time())
                    break
            self._save_unlocked(book_id, data)
            return self._enrich_stats(data)

    def delete_highlight(self, book_id: str, highlight_id: str) -> Dict[str, Any]:
        with self._lock:
            data = self._load_unlocked(book_id)
            data["highlights"] = [
                h for h in (data.get("highlights") or []) if h.get("id") != highlight_id
            ]
            self._save_unlocked(book_id, data)
            return self._enrich_stats(data)

    def _parse_flexible_ts(self, val: Any, fallback: int) -> int:
        if val is None:
            return fallback
        if isinstance(val, (int, float)):
            v_int = int(val)
            if v_int > 10_000_000_000:
                v_int = v_int // 1000
            return v_int if v_int > 100_000 else fallback
        s = str(val).strip()
        if not s:
            return fallback
        if s.isdigit():
            v_int = int(s)
            if v_int > 10_000_000_000:
                v_int = v_int // 1000
            return v_int if v_int > 100_000 else fallback
        try:
            iso_clean = s.replace("Z", "+00:00")
            dt = datetime.datetime.fromisoformat(iso_clean)
            return int(dt.timestamp())
        except Exception:
            pass
        try:
            dt = datetime.datetime.strptime(s[:10], "%Y-%m-%d").replace(hour=12, minute=0, second=0)
            return int(dt.timestamp())
        except Exception:
            return fallback

    def record_or_update_session(
        self,
        book_id: str,
        session_id: Optional[str],
        duration_seconds: int,
        start_chapter: int,
        end_chapter: int,
        chapter_title: str = "",
        sentences_read: int = 0,
        note: str = "",
        custom_date: Optional[str] = None,
        started_at: Optional[Any] = None,
        ended_at: Optional[Any] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            data = self._load_unlocked(book_id)
            sessions: List[Dict[str, Any]] = data.get("sessions") or []
            now = int(time.time())
            target_ts = now
            if custom_date and custom_date.strip():
                try:
                    dt = datetime.datetime.strptime(custom_date.strip()[:10], "%Y-%m-%d")
                    dt = dt.replace(hour=12, minute=0, second=0)
                    target_ts = int(dt.timestamp())
                except Exception:
                    target_ts = now

            parsed_start = self._parse_flexible_ts(started_at, 0)
            parsed_end = self._parse_flexible_ts(ended_at, 0)

            is_manual = bool((custom_date and custom_date.strip()) or (note and note.strip()))
            clean_sents = max(0, int(sentences_read))
            clean_dur = max(1, int(duration_seconds))

            # Ignorar sesiones automáticas sin lectura real (0 o 1 frase sin nota manual)
            if not is_manual and clean_sents < 2:
                return {"session": None, "study": self._enrich_stats(data)}

            # Acotar la duración de sesiones automáticas al tiempo real de escucha/lectura (~5.2s máx por frase)
            if not is_manual and clean_sents >= 2:
                max_realistic_sec = max(45, int(round(clean_sents * 5.2)))
                if clean_dur > max_realistic_sec:
                    clean_dur = max(45, int(round(clean_sents * 4.0)))

            existing = None
            if session_id:
                existing = next(
                    (s for s in sessions if s.get("id") == session_id), None
                )

            if existing:
                new_sents = max(int(existing.get("sentences_read") or 0), clean_sents)
                existing["sentences_read"] = new_sents
                if not is_manual and new_sents >= 2:
                    max_sec_for_existing = max(45, int(round(new_sents * 5.2)))
                    combined_dur = max(int(existing.get("duration_seconds") or 0), clean_dur)
                    existing["duration_seconds"] = (
                        max(45, int(round(new_sents * 4.0)))
                        if combined_dur > max_sec_for_existing
                        else combined_dur
                    )
                else:
                    existing["duration_seconds"] = max(
                        int(existing.get("duration_seconds") or 0), clean_dur
                    )
                existing["ended_at"] = (
                    int(existing.get("started_at") or now) + int(existing["duration_seconds"])
                )
                existing["end_chapter"] = end_chapter
                if chapter_title:
                    existing["chapter_title"] = chapter_title
                if note:
                    existing["note"] = note
                session_entry = existing
            else:
                new_id = session_id or f"ses_{uuid.uuid4().hex[:10]}"
                if custom_date and custom_date.strip():
                    started_ts = parsed_start if parsed_start > 0 else target_ts
                elif parsed_start > 0:
                    started_ts = parsed_start
                else:
                    started_ts = now - max(0, clean_dur)

                ended_ts = started_ts + max(1, clean_dur)
                session_entry = {
                    "id": new_id,
                    "started_at": started_ts,
                    "ended_at": ended_ts,
                    "duration_seconds": clean_dur,
                    "start_chapter": start_chapter,
                    "end_chapter": end_chapter,
                    "chapter_title": chapter_title or f"Capítulo {end_chapter + 1}",
                    "sentences_read": clean_sents,
                    "note": note,
                }
                sessions.insert(0, session_entry)

            sessions.sort(key=lambda s: int(s.get("started_at") or 0), reverse=True)
            data["sessions"] = sessions
            self._save_unlocked(book_id, data)
            return {"session": session_entry, "study": self._enrich_stats(data)}

    def delete_session(self, book_id: str, session_id: str) -> Dict[str, Any]:
        with self._lock:
            data = self._load_unlocked(book_id)
            data["sessions"] = [
                s for s in (data.get("sessions") or []) if s.get("id") != session_id
            ]
            self._save_unlocked(book_id, data)
            return self._enrich_stats(data)

    def get_obsidian_markdown(self, book_id: str) -> str:
        with self._lock:
            data = self._load_unlocked(book_id)
            return self._render_obsidian_markdown(data)

    def _render_obsidian_markdown(self, data: Dict[str, Any]) -> str:
        enriched = self._enrich_stats(data)
        stats = enriched["stats"]
        lang = data.get("language") or "es"
        is_en = str(lang).lower().startswith("en")
        title = data.get("title") or ("Book" if is_en else "Libro")
        raw_author = (data.get("author") or "").strip()
        if not raw_author or (is_en and raw_author in ("Desconocido", "Autor desconocido")):
            author = "Unknown" if is_en else "Desconocido"
        else:
            author = raw_author

        if is_en:
            status_map = {
                "reading": "📖 Reading",
                "completed": "✅ Completed",
                "paused": "⏸️ Paused",
                "wishlist": "📌 Wishlist",
            }
            status_str = status_map.get(data.get("reading_status", "reading"), "📖 Reading")
        else:
            status_map = {
                "reading": "📖 Leyendo",
                "completed": "✅ Terminado",
                "paused": "⏸️ En pausa",
                "wishlist": "📌 Pendiente",
            }
            status_str = status_map.get(data.get("reading_status", "reading"), "📖 Leyendo")

        stars = _format_stars_obsidian(data.get("rating"), is_en=is_en)
        body_finished_str = (
            "In progress"
            if (is_en and stats["finished_date_str"] == "En curso")
            else stats["finished_date_str"]
        )

        es_status_map = {
            "reading": "leyendo",
            "completed": "leido",
            "paused": "abandonado",
            "wishlist": "pendiente",
        }
        es_estado = es_status_map.get(data.get("reading_status", "reading"), "leyendo")
        genre_str = (data.get("genre") or "").strip()
        pair_ctx = self._get_pairing_render_context_unlocked(
            str(data.get("book_id") or ""), data
        )

        lines: List[str] = [
            "---",
            f'title: "{title.replace(chr(34), chr(39))}"',
            f'author: "{author.replace(chr(34), chr(39))}"',
            f"language: {lang}",
            f'genre: "{genre_str.replace(chr(34), chr(39))}"' if genre_str else 'genre: ""',
            f"status: {data.get('reading_status', 'reading')}",
        ]
        if not is_en:
            lines.append(f"estado: {es_estado}")
        lines.append(f"started: {stats['started_date_str']}")
        if not is_en:
            lines.append(
                f"fecha_inicio: {stats['started_date_str'] if stats['started_date_str'] != '—' else ''}"
            )
        lines.append(f"finished: {body_finished_str}")
        if not is_en:
            lines.append(
                f"fecha_fin: {stats['finished_date_str'] if stats['finished_date_str'] not in ('—', 'En curso') else ''}"
            )
        lines.append(f"times_read: {data.get('times_read', 1)}")
        if not is_en:
            lines.append(f"Nº Lecturas: {data.get('times_read', 1)}")
        lines.extend(
            [
                f'reading_time: "{stats["total_time_human"]}"',
                f"sessions_count: {stats['session_count']}",
                f"rating: {data.get('rating', 0)}",
            ]
        )
        if not is_en:
            lines.append(f"calificacion: {data.get('rating', 0) if data.get('rating') else ''}")

        if pair_ctx:
            partner_note_esc = pair_ctx["partner_obsidian_note"].replace(chr(34), chr(39))
            lines.append(f'paired_edition: "[[{partner_note_esc}]]"')
            lines.append(f"paired_language: {pair_ctx['paired_book_lang']}")

        lines.append("tags:")
        if is_en:
            lines.extend(["  - books", "  - reading", "  - vozlectura"])
            if pair_ctx:
                lines.append("  - bilingual-reading")
        else:
            lines.extend(["  - libros", "  - lectura", "  - vozlectura"])
            if pair_ctx:
                lines.append("  - lectura-bilingue")

        lines.extend(["---", "", f"# 📖 {title}"])
        if is_en:
            lines.append(
                f"**Author:** {author} | **Language:** `{lang}` | **Status:** {status_str}"
            )
        else:
            lines.append(
                f"**Autor:** {author} | **Idioma:** `{lang}` | **Estado:** {status_str}"
            )

        if pair_ctx:
            p_note = pair_ctx["partner_obsidian_note"]
            p_lang = pair_ctx["paired_book_lang"]
            p_time = pair_ctx["partner_time_human"]
            lines.append("")
            if is_en:
                lines.extend(
                    [
                        "> [!abstract] 🌐 Paired Bilingual Edition (EN ⇄ ES)",
                        f"> Same book in another language: **[[{p_note}]]** (`{p_lang}`)",
                        f"> **Reading time:** {stats['total_time_human']} (`{lang}`) · {p_time} (`{p_lang}`)",
                    ]
                )
            else:
                lines.extend(
                    [
                        "> [!abstract] 🌐 Edición Bilingüe Emparejada (ES ⇄ EN)",
                        f"> Mismo libro en otro idioma: **[[{p_note}]]** (`{p_lang}`)",
                        f"> **Tiempo de lectura:** {stats['total_time_human']} (`{lang}`) · {p_time} (`{p_lang}`)",
                    ]
                )

        lines.append("")
        if is_en:
            lines.extend(
                [
                    "## 📊 Reading Habits Log",
                    f"- **Started:** {stats['started_date_str']}",
                    f"- **Finished:** {body_finished_str}",
                    f"- **Times read:** {data.get('times_read', 1)}",
                    f"- **Total reading/listening time:** {stats['total_time_human']} ({stats['session_count']} sessions across {stats['days_read_count']} days)",
                    f"- **Rating:** {stars}",
                    "",
                ]
            )
        else:
            lines.extend(
                [
                    "## 📊 Registro de Hábitos de Lectura",
                    f"- **Fecha de inicio:** {stats['started_date_str']}",
                    f"- **Fecha de finalización:** {body_finished_str}",
                    f"- **Veces leído:** {data.get('times_read', 1)}",
                    f"- **Tiempo total de lectura/escucha:** {stats['total_time_human']} ({stats['session_count']} sesiones en {stats['days_read_count']} días)",
                    f"- **Valoración:** {stars}",
                    "",
                ]
            )

        # Notas generales del libro (siempre visible para edición bidireccional con Obsidian)
        gen_notes = (data.get("general_notes") or "").strip()
        if is_en:
            lines.extend(
                [
                    "## 💭 General Notes & Reflections",
                    gen_notes
                    if gen_notes
                    else "_Write your general notes, ideas, or reflections here (in the app or directly in Obsidian)..._",
                    "",
                ]
            )
        else:
            lines.extend(
                [
                    "## 💭 Notas Generales y Reflexiones",
                    gen_notes
                    if gen_notes
                    else "_Escribe aquí tus notas, ideas o reflexiones (en la app o directamente en Obsidian)..._",
                    "",
                ]
            )

        # Mapas e ilustraciones extraídos del EPUB (desplegable abierto por defecto)
        illustrations = data.get("epub_illustrations") or []
        if illustrations:
            if is_en:
                lines.append(f"## 🗺️ Maps & Illustrations ({len(illustrations)})")
                lines.append(
                    f"> [!info]+ 🗺️ Book maps & illustrations ({len(illustrations)})"
                )
            else:
                lines.append(f"## 🗺️ Mapas e Ilustraciones ({len(illustrations)})")
                lines.append(
                    f"> [!info]+ 🗺️ Mapas e ilustraciones del libro ({len(illustrations)})"
                )
            for idx_ill, ill in enumerate(illustrations, start=1):
                ill_fn = (ill.get("filename") or "").strip()
                if not ill_fn:
                    continue
                default_ill_lbl = (
                    f"Illustration {idx_ill}" if is_en else f"Ilustración {idx_ill}"
                )
                ill_lbl = (ill.get("label") or default_ill_lbl).strip()
                lines.append(f"> **{idx_ill}. {ill_lbl}**")
                lines.append(f"> ![[{ill_fn}]]")
                if idx_ill < len(illustrations):
                    lines.append(">")
            lines.append("")

        # Pasajes resaltados y notas
        highlights = data.get("highlights") or []
        if is_en:
            lines.append(f"## 🖍️ Highlighted Passages & Notes ({len(highlights)})")
        else:
            lines.append(f"## 🖍️ Pasajes Resaltados y Notas ({len(highlights)})")
        if not highlights:
            lines.append(
                "_No highlighted passages in this book yet._\n"
                if is_en
                else "_Aún no hay pasajes resaltados en este libro._\n"
            )
        else:
            lines.append("")
            # Ordenar por capítulo y fecha
            sorted_hl = sorted(
                highlights,
                key=lambda h: (
                    int(h.get("chapter_index") or 0),
                    (h.get("sentence_indices") or [0])[0]
                    if h.get("sentence_indices")
                    else 0,
                    int(h.get("created_at") or 0),
                ),
            )
            for h in sorted_hl:
                ch_num_hl = int(h.get("chapter_index") or 0) + 1
                ch_label = h.get("chapter_title") or (
                    f"Chapter {ch_num_hl}" if is_en else f"Capítulo {ch_num_hl}"
                )
                date_str = _format_ts_datetime(h.get("created_at"))
                lines.append(f"### 📍 {ch_label} _({date_str})_")
                lines.append(
                    "> [!quote] Highlighted passage"
                    if is_en
                    else "> [!quote] Pasaje resaltado"
                )
                for q_line in (h.get("text") or "").splitlines():
                    lines.append(f"> {q_line}")
                lines.append("")
                if h.get("note"):
                    note_lbl = "**📝 Note:**" if is_en else "**📝 Nota:**"
                    lines.append(f"{note_lbl} {h['note']}")
                    lines.append("")

        # Vocabulario buscado y subrayado
        vocab = data.get("vocabulary") or []
        if is_en:
            lines.append(f"## 📚 Vocabulary & Underlined Words ({len(vocab)})")
        else:
            lines.append(f"## 📚 Vocabulario y Palabras Subrayadas ({len(vocab)})")
        if not vocab:
            lines.append(
                "_No vocabulary words saved yet for this book._\n"
                if is_en
                else "_Aún no hay palabras guardadas en el vocabulario de este libro._\n"
            )
        else:
            lines.append("")
            for v in vocab:
                w = v.get("word", "")
                phon = f" `/{v['phonetic']}/`" if v.get("phonetic") else ""
                trans = v.get("translation") or "—"
                count = int(v.get("lookup_count") or 1)
                ch_num_v = int(v.get("chapter_index") or 0) + 1
                ch_label = v.get("chapter_title") or (
                    f"Ch. {ch_num_v}" if is_en else f"Cap. {ch_num_v}"
                )
                if is_en:
                    lines.append(
                        f"- **{w}**{phon} → **{trans}** _(looked up {count} {'time' if count == 1 else 'times'} • {ch_label})_"
                    )
                    if v.get("definitions_summary"):
                        lines.append(f"  - *Definition:* {v['definitions_summary']}")
                    if v.get("context_sentence"):
                        lines.append(f'  - *Context in book:* «{v["context_sentence"]}»')
                    if v.get("context_translation"):
                        lines.append(f'  - *Context translation:* «{v["context_translation"]}»')
                    if v.get("user_note"):
                        lines.append(f"  - *Personal note:* {v['user_note']}")
                else:
                    lines.append(
                        f"- **{w}**{phon} → **{trans}** _(consultada {count} {'vez' if count == 1 else 'veces'} • {ch_label})_"
                    )
                    if v.get("definitions_summary"):
                        lines.append(f"  - *Definición:* {v['definitions_summary']}")
                    if v.get("context_sentence"):
                        lines.append(f'  - *Contexto en el libro:* «{v["context_sentence"]}»')
                    if v.get("context_translation"):
                        lines.append(f'  - *Traducción del contexto:* «{v["context_translation"]}»')
                    if v.get("user_note"):
                        lines.append(f"  - *Nota personal:* {v['user_note']}")
            lines.append("")

        # Historial de Sesiones de Lectura
        sessions = data.get("sessions") or []
        if is_en:
            lines.append(f"## ⏱️ Reading Sessions History ({len(sessions)})")
        else:
            lines.append(f"## ⏱️ Historial de Sesiones de Lectura ({len(sessions)})")
        if not sessions:
            lines.append(
                "_No reading sessions recorded yet._\n"
                if is_en
                else "_Aún no se han registrado sesiones de lectura._\n"
            )
        else:
            lines.append("")
            if is_en:
                lines.append("| Date | Start time | Duration | Chapters | Sentences | Note |")
            else:
                lines.append("| Fecha | Hora inicio | Duración | Capítulos | Frases | Nota |")
            lines.append("| :--- | :--- | :--- | :--- | :--- | :--- |")
            for s in sessions:
                d_str = _format_ts_date(s.get("started_at"))
                t_str = (
                    datetime.datetime.fromtimestamp(s["started_at"]).strftime("%H:%M")
                    if s.get("started_at")
                    else "—"
                )
                dur_str = _format_duration_human(int(s.get("duration_seconds") or 0))
                sc = int(s.get("start_chapter") or 0) + 1
                ec = int(s.get("end_chapter") or 0) + 1
                ch_prefix = "Ch." if is_en else "Cap."
                ch_range = (
                    f"{ch_prefix} {sc}" if sc == ec else f"{ch_prefix} {sc} → {ec}"
                )
                if s.get("chapter_title"):
                    ch_range += f" ({s['chapter_title']})"
                fr_count = int(s.get("sentences_read") or 0)
                s_note = (s.get("note") or "").replace("|", "/")
                lines.append(
                    f"| {d_str} | {t_str} | {dur_str} | {ch_range} | {fr_count} | {s_note} |"
                )
            lines.append("")

        return "\n".join(lines)

    # =========================================================================
    # METAS DE LECTURA, CALENDARIO Y ESTADÍSTICAS GLOBALES / ANUALES
    # =========================================================================
    def _goals_file(self) -> Path:
        return self.data_dir / "reading_goals.json"

    def get_reading_goals(self) -> Dict[str, Any]:
        gf = self._goals_file()
        defaults = {
            "daily_minutes_goal": 30,
            "yearly_books_goal": 12,
            "yearly_pages_goal": 3600,
        }
        if not gf.exists():
            return defaults
        try:
            loaded = json.loads(gf.read_text(encoding="utf-8"))
            for k, v in defaults.items():
                if k not in loaded:
                    loaded[k] = v
            return loaded
        except Exception:
            return defaults

    def update_reading_goals(
        self,
        daily_minutes_goal: Optional[int] = None,
        yearly_books_goal: Optional[int] = None,
        yearly_pages_goal: Optional[int] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            goals = self.get_reading_goals()
            if daily_minutes_goal is not None:
                goals["daily_minutes_goal"] = max(5, min(720, int(daily_minutes_goal)))
            if yearly_books_goal is not None:
                goals["yearly_books_goal"] = max(1, min(500, int(yearly_books_goal)))
            if yearly_pages_goal is not None:
                goals["yearly_pages_goal"] = max(100, min(200000, int(yearly_pages_goal)))
            self._goals_file().write_text(
                json.dumps(goals, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            return goals

    def _get_or_compute_book_length(
        self, book_id: str, lib_meta: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Calcula y cachea en metadata.json el recuento real de palabras, páginas estimadas (250 pal/pág) y frases."""
        book_dir = self.books_dir / book_id
        meta_path = book_dir / "metadata.json"
        meta = dict(lib_meta or {})
        if meta_path.exists():
            try:
                disk_meta = json.loads(meta_path.read_text(encoding="utf-8"))
                meta.update(disk_meta)
            except Exception:
                pass

        total_words = int(meta.get("total_words") or 0)
        total_chars = int(meta.get("total_chars") or 0)
        chapter_word_counts: List[int] = meta.get("chapter_word_counts") or []
        chapter_sentence_counts: List[int] = meta.get("chapter_sentence_counts") or []

        if total_words <= 0 or not chapter_word_counts:
            chapters_path = book_dir / "chapters.json"
            if chapters_path.exists():
                try:
                    chs = json.loads(chapters_path.read_text(encoding="utf-8"))
                    w_total = 0
                    c_total = 0
                    ch_words = []
                    ch_sents = []
                    for ch in chs:
                        sents = ch.get("sentences") or []
                        cw = 0
                        for s in sents:
                            txt = (s.get("text") or "").strip()
                            if txt:
                                cw += len(txt.split())
                                c_total += len(txt)
                        w_total += cw
                        ch_words.append(cw)
                        ch_sents.append(len(sents))
                    total_words = w_total
                    total_chars = c_total
                    chapter_word_counts = ch_words
                    chapter_sentence_counts = ch_sents
                    meta["total_words"] = total_words
                    meta["total_chars"] = total_chars
                    meta["estimated_pages"] = max(1, round(total_words / 250))
                    meta["chapter_word_counts"] = chapter_word_counts
                    meta["chapter_sentence_counts"] = chapter_sentence_counts
                    try:
                        meta_path.write_text(
                            json.dumps(meta, ensure_ascii=False, indent=2),
                            encoding="utf-8",
                        )
                    except Exception:
                        pass
                except Exception:
                    pass

        estimated_pages = max(1, round(total_words / 250)) if total_words > 0 else max(1, int(meta.get("total_sentences") or 100) // 14)
        if total_words <= 0:
            total_words = estimated_pages * 250

        return {
            "total_words": total_words,
            "total_chars": total_chars,
            "estimated_pages": estimated_pages,
            "chapter_word_counts": chapter_word_counts,
            "chapter_sentence_counts": chapter_sentence_counts,
        }

    def get_global_analytics(
        self, library_books: Dict[str, Dict[str, Any]]
    ) -> Dict[str, Any]:
        with self._lock:
            goals = self.get_reading_goals()
            today_dt = datetime.date.today()
            today_str = today_dt.strftime("%Y-%m-%d")
            current_year = today_dt.year
            week_start_dt = today_dt - datetime.timedelta(days=today_dt.weekday())

            books_summary: List[Dict[str, Any]] = []
            daily_map: Dict[str, Dict[str, Any]] = {}
            authors_map: Dict[str, Dict[str, Any]] = {}
            years_set = {current_year}

            archived_map = self._load_archived_books_map()
            all_book_ids = list(library_books.keys())
            seen_ids = set(all_book_ids)
            if self.books_dir.exists():
                for d in self.books_dir.iterdir():
                    if d.is_dir() and d.name not in seen_ids and (d / "metadata.json").exists():
                        all_book_ids.append(d.name)
                        seen_ids.add(d.name)
            for arch_id in archived_map.keys():
                if arch_id not in seen_ids:
                    all_book_ids.append(arch_id)
                    seen_ids.add(arch_id)
            if self.study_records_dir.exists():
                for sf_item in self.study_records_dir.glob("*.json"):
                    bid = sf_item.stem
                    if bid in seen_ids:
                        continue
                    try:
                        s_raw = json.loads(sf_item.read_text(encoding="utf-8"))
                        has_meaningful = bool(
                            (s_raw.get("title") and s_raw.get("title") != bid)
                            or s_raw.get("sessions")
                            or float(s_raw.get("rating") or 0) > 0
                        )
                        if has_meaningful:
                            all_book_ids.append(bid)
                            seen_ids.add(bid)
                    except Exception:
                        pass

            for book_id in all_book_ids:
                is_archived = book_id not in library_books
                lib_b = library_books.get(book_id) or archived_map.get(book_id) or self._get_book_meta(book_id)
                study = self._load_unlocked(book_id)
                enriched = self._enrich_stats(study)
                st_stats = enriched["stats"]
                length_info = self._get_or_compute_book_length(book_id, lib_b)

                title = lib_b.get("title") or study.get("title") or book_id
                author = (lib_b.get("author") or study.get("author") or "Autor desconocido").strip() or "Autor desconocido"
                lang = lib_b.get("language") or study.get("language") or "es"
                has_disk_cover = any((self.books_dir / book_id).glob("cover.*")) if (self.books_dir / book_id).exists() else False
                has_arch_cover = any(self.archived_covers_dir.glob(f"{book_id}.*")) if self.archived_covers_dir.exists() else False
                cover_url = lib_b.get("cover_url") or (f"/api/books/{book_id}/cover" if (has_disk_cover or has_arch_cover) else None)
                total_sentences = int(lib_b.get("total_sentences") or sum(length_info["chapter_sentence_counts"]) or 1)
                chapter_count = int(lib_b.get("chapter_count") or len(length_info["chapter_sentence_counts"]) or 1)

                # Calcular porcentaje de avance real según capítulo/frase actual
                prog = lib_b.get("progress") or {}
                cur_ch = int(prog.get("chapter_index") or 0)
                cur_sent = int(prog.get("sentence_index") or 0)
                ch_sents = length_info["chapter_sentence_counts"]
                if ch_sents and 0 <= cur_ch < len(ch_sents):
                    sents_before = sum(ch_sents[:cur_ch]) + cur_sent
                else:
                    sents_before = int((cur_ch / max(1, chapter_count)) * total_sentences) + cur_sent

                reading_status = study.get("reading_status") or "reading"
                times_read = int(study.get("times_read") or 1)
                if reading_status == "completed":
                    progress_pct = 100
                elif reading_status == "wishlist" and sents_before <= 1:
                    progress_pct = 0
                else:
                    raw_pct = (sents_before / max(1, total_sentences)) * 100.0
                    progress_pct = 0 if sents_before <= 0 else min(99, max(1, int(round(raw_pct))))

                total_words = length_info["total_words"]
                estimated_pages = length_info["estimated_pages"]
                effective_multiplier = max(1, times_read) if reading_status == "completed" else (progress_pct / 100.0)
                words_read_est = int(round(total_words * effective_multiplier))
                pages_read_est = int(round(estimated_pages * effective_multiplier))

                started_ts = study.get("started_at")
                finished_ts = study.get("finished_at")
                started_date = _format_ts_date(started_ts) if started_ts else None
                finished_date = _format_ts_date(finished_ts) if finished_ts else None

                finished_year: Optional[int] = None
                finished_month: Optional[int] = None
                if finished_ts:
                    fdt = datetime.datetime.fromtimestamp(int(finished_ts))
                    finished_year = fdt.year
                    finished_month = fdt.month
                    years_set.add(finished_year)
                elif reading_status == "completed":
                    fallback_ts = study.get("updated_at") or started_ts or int(time.time())
                    fdt = datetime.datetime.fromtimestamp(int(fallback_ts))
                    finished_year = fdt.year
                    finished_month = fdt.month
                    years_set.add(finished_year)

                if started_ts:
                    years_set.add(datetime.datetime.fromtimestamp(int(started_ts)).year)

                sessions = study.get("sessions") or []
                total_sec = int(st_stats.get("total_seconds") or 0)
                total_min = round(total_sec / 60.0, 1)
                rating = _normalize_half_star_rating(study.get("rating"))

                # Registrar sesiones en el calendario diario
                for s in sessions:
                    s_ts = int(s.get("started_at") or 0)
                    if s_ts <= 0:
                        continue
                    s_dt = datetime.datetime.fromtimestamp(s_ts)
                    d_key = s_dt.strftime("%Y-%m-%d")
                    years_set.add(s_dt.year)
                    dur_s = max(1, int(s.get("duration_seconds") or 0))
                    sents_r = max(0, int(s.get("sentences_read") or 0))
                    sc = int(s.get("start_chapter") or 0) + 1
                    ec = int(s.get("end_chapter") or 0) + 1
                    ch_range = f"Cap. {sc}" if sc == ec else f"Cap. {sc} → {ec}"
                    if s.get("chapter_title"):
                        ch_range = s["chapter_title"]

                    if d_key not in daily_map:
                        daily_map[d_key] = {
                            "date": d_key,
                            "total_seconds": 0,
                            "total_minutes": 0.0,
                            "sentences_read": 0,
                            "session_count": 0,
                            "books_dict": {},
                            "sessions": [],
                        }
                    day_obj = daily_map[d_key]
                    day_obj["total_seconds"] += dur_s
                    day_obj["total_minutes"] = round(day_obj["total_seconds"] / 60.0, 1)
                    day_obj["sentences_read"] += sents_r
                    day_obj["session_count"] += 1

                    if book_id not in day_obj["books_dict"]:
                        day_obj["books_dict"][book_id] = {
                            "book_id": book_id,
                            "title": title,
                            "author": author,
                            "seconds": 0,
                            "minutes": 0.0,
                            "sentences_read": 0,
                            "chapters": [],
                        }
                    b_day = day_obj["books_dict"][book_id]
                    b_day["seconds"] += dur_s
                    b_day["minutes"] = round(b_day["seconds"] / 60.0, 1)
                    b_day["sentences_read"] += sents_r
                    if ch_range not in b_day["chapters"]:
                        b_day["chapters"].append(ch_range)

                    day_obj["sessions"].append({
                        "id": s.get("id") or "",
                        "book_id": book_id,
                        "book_title": title,
                        "author": author,
                        "time_str": s_dt.strftime("%H:%M"),
                        "duration_seconds": dur_s,
                        "duration_minutes": max(1, round(dur_s / 60)),
                        "chapter_range": ch_range,
                        "sentences_read": sents_r,
                        "note": s.get("note") or "",
                    })

                book_record = {
                    "book_id": book_id,
                    "title": title,
                    "author": author,
                    "language": lang,
                    "cover_url": cover_url,
                    "reading_status": reading_status,
                    "rating": rating,
                    "times_read": times_read,
                    "started_at": started_ts,
                    "started_date": started_date if started_date != "—" else "",
                    "finished_at": finished_ts,
                    "finished_date": finished_date if finished_date not in ("—", None) else "",
                    "finished_year": finished_year,
                    "finished_month": finished_month,
                    "total_seconds": total_sec,
                    "total_minutes": total_min,
                    "total_hours": round(total_sec / 3600.0, 2),
                    "total_time_human": _format_duration_human(total_sec),
                    "session_count": len(sessions),
                    "days_read_count": int(st_stats.get("days_read_count") or 0),
                    "total_words": total_words,
                    "estimated_pages": estimated_pages,
                    "total_sentences": total_sentences,
                    "chapter_count": chapter_count,
                    "progress_percent": progress_pct,
                    "words_read_estimated": words_read_est,
                    "pages_read_estimated": pages_read_est,
                    "estimated_listen_hours": round((total_words / 145.0) / 60.0, 1),
                    "highlights_count": int(st_stats.get("highlights_count") or 0),
                    "vocabulary_count": int(st_stats.get("vocabulary_count") or 0),
                    "general_notes": study.get("general_notes") or "",
                    "is_archived": is_archived,
                }
                books_summary.append(book_record)

                # Acumular por autor
                if author not in authors_map:
                    authors_map[author] = {
                        "author": author,
                        "book_count": 0,
                        "completed_count": 0,
                        "total_seconds": 0,
                        "total_minutes": 0.0,
                        "total_pages": 0,
                        "total_words": 0,
                        "pages_read": 0,
                        "words_read": 0,
                        "ratings": [],
                        "books": [],
                    }
                a_obj = authors_map[author]
                a_obj["book_count"] += 1
                if reading_status == "completed":
                    a_obj["completed_count"] += 1
                a_obj["total_seconds"] += total_sec
                a_obj["total_minutes"] = round(a_obj["total_seconds"] / 60.0, 1)
                a_obj["total_pages"] += estimated_pages
                a_obj["total_words"] += total_words
                a_obj["pages_read"] += pages_read_est
                a_obj["words_read"] += words_read_est
                if rating > 0:
                    a_obj["ratings"].append(rating)
                a_obj["books"].append({
                    "book_id": book_id,
                    "title": title,
                    "rating": rating,
                    "reading_status": reading_status,
                    "estimated_pages": estimated_pages,
                    "total_time_human": _format_duration_human(total_sec),
                    "is_archived": is_archived,
                })

            # Finalizar estructura de daily_map
            for d_key, d_val in daily_map.items():
                books_list = sorted(
                    d_val.pop("books_dict").values(),
                    key=lambda x: x["seconds"],
                    reverse=True,
                )
                d_val["books"] = books_list
                d_val["goal_met"] = d_val["total_minutes"] >= goals["daily_minutes_goal"]

            # Calcular racha actual (current_streak) y mejor racha histórica (best_streak)
            active_dates_sorted = sorted(
                datetime.datetime.strptime(k, "%Y-%m-%d").date()
                for k, v in daily_map.items()
                if v["total_seconds"] >= 30
            )
            active_dates_set = set(active_dates_sorted)

            current_streak = 0
            cursor_dt = today_dt if today_dt in active_dates_set else (today_dt - datetime.timedelta(days=1))
            if cursor_dt in active_dates_set:
                while cursor_dt in active_dates_set:
                    current_streak += 1
                    cursor_dt -= datetime.timedelta(days=1)

            best_streak = 0
            run_len = 0
            prev_dt: Optional[datetime.date] = None
            for d_item in active_dates_sorted:
                if prev_dt is not None and (d_item - prev_dt).days == 1:
                    run_len += 1
                else:
                    run_len = 1
                if run_len > best_streak:
                    best_streak = run_len
                prev_dt = d_item

            # Tiempo hoy, esta semana y este mes
            today_sec = daily_map.get(today_str, {}).get("total_seconds", 0)
            week_sec = 0
            month_sec = 0
            for d_str, d_val in daily_map.items():
                dt_obj = datetime.datetime.strptime(d_str, "%Y-%m-%d").date()
                if dt_obj >= week_start_dt and dt_obj <= today_dt:
                    week_sec += d_val["total_seconds"]
                if dt_obj.year == today_dt.year and dt_obj.month == today_dt.month:
                    month_sec += d_val["total_seconds"]

            # Estadísticas de autores
            authors_stats: List[Dict[str, Any]] = []
            for a_name, a_val in authors_map.items():
                ratings_arr = a_val.pop("ratings")
                avg_r = round(sum(ratings_arr) / len(ratings_arr), 2) if ratings_arr else 0.0
                a_val["avg_rating"] = avg_r
                a_val["rated_count"] = len(ratings_arr)
                a_val["total_time_human"] = _format_duration_human(a_val["total_seconds"])
                authors_stats.append(a_val)

            authors_stats.sort(
                key=lambda a: (a["total_seconds"], a["completed_count"], a["avg_rating"], a["pages_read"]),
                reverse=True,
            )

            most_read_author_by_time = authors_stats[0] if authors_stats else None
            most_read_author_by_books = (
                max(authors_stats, key=lambda a: (a["completed_count"], a["book_count"], a["total_seconds"]))
                if authors_stats
                else None
            )
            rated_authors = [a for a in authors_stats if a["rated_count"] > 0]
            best_rated_author = (
                max(rated_authors, key=lambda a: (a["avg_rating"], a["rated_count"], a["total_seconds"]))
                if rated_authors
                else None
            )

            # Estadísticas de longitud de libros
            sorted_by_length = sorted(books_summary, key=lambda b: b["total_words"], reverse=True)
            longest_book = sorted_by_length[0] if sorted_by_length else None
            shortest_book = sorted_by_length[-1] if sorted_by_length else None

            rated_books = [b for b in books_summary if b["rating"] > 0]
            rated_books.sort(key=lambda b: (b["rating"], b["total_seconds"], b["total_words"]), reverse=True)
            top_rated_book = rated_books[0] if rated_books else None

            most_read_book = (
                max(books_summary, key=lambda b: b["total_seconds"])
                if books_summary
                else None
            )

            total_reading_sec = sum(b["total_seconds"] for b in books_summary)
            total_words_read = sum(b["words_read_estimated"] for b in books_summary)
            total_pages_read = sum(b["pages_read_estimated"] for b in books_summary)
            avg_book_pages = (
                round(sum(b["estimated_pages"] for b in books_summary) / len(books_summary))
                if books_summary
                else 0
            )
            avg_book_words = (
                round(sum(b["total_words"] for b in books_summary) / len(books_summary))
                if books_summary
                else 0
            )
            avg_rating_all = (
                round(sum(b["rating"] for b in rated_books) / len(rated_books), 2)
                if rated_books
                else 0.0
            )

            # Estadísticas Anuales (Resumen de Lecturas por Año)
            month_names_es = [
                "Ene", "Feb", "Mar", "Abr", "May", "Jun",
                "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"
            ]
            yearly_stats: Dict[str, Any] = {}
            for yr in sorted(years_set, reverse=True):
                monthly = [
                    {
                        "month": m,
                        "name": month_names_es[m - 1],
                        "seconds": 0,
                        "minutes": 0.0,
                        "hours": 0.0,
                        "active_days": 0,
                        "books_completed": 0,
                        "sentences_read": 0,
                    }
                    for m in range(1, 13)
                ]
                yr_sec = 0
                yr_active_days = 0
                yr_sessions = 0
                yr_sents = 0
                yr_book_seconds: Dict[str, int] = {}

                for d_str, d_val in daily_map.items():
                    dt_obj = datetime.datetime.strptime(d_str, "%Y-%m-%d").date()
                    if dt_obj.year == yr:
                        ds = d_val["total_seconds"]
                        yr_sec += ds
                        if ds >= 30:
                            yr_active_days += 1
                            monthly[dt_obj.month - 1]["active_days"] += 1
                        yr_sessions += d_val["session_count"]
                        yr_sents += d_val["sentences_read"]
                        monthly[dt_obj.month - 1]["seconds"] += ds
                        monthly[dt_obj.month - 1]["minutes"] = round(
                            monthly[dt_obj.month - 1]["seconds"] / 60.0, 1
                        )
                        monthly[dt_obj.month - 1]["hours"] = round(
                            monthly[dt_obj.month - 1]["seconds"] / 3600.0, 2
                        )
                        monthly[dt_obj.month - 1]["sentences_read"] += d_val["sentences_read"]
                        for b_item in d_val["books"]:
                            bid = b_item["book_id"]
                            yr_book_seconds[bid] = yr_book_seconds.get(bid, 0) + b_item["seconds"]

                completed_in_year = [
                    b for b in books_summary
                    if b["reading_status"] == "completed" and b["finished_year"] == yr
                ]
                for cb in completed_in_year:
                    fm = cb.get("finished_month") or 1
                    if 1 <= fm <= 12:
                        monthly[fm - 1]["books_completed"] += 1

                # Libros leídos o escuchados en este año (terminados en el año o con sesiones en el año)
                interacted_books = [
                    b for b in books_summary
                    if b["book_id"] in yr_book_seconds or (b["reading_status"] == "completed" and b["finished_year"] == yr)
                ]

                yr_pages_read = sum(
                    b["estimated_pages"] if (b["reading_status"] == "completed" and b["finished_year"] == yr) else b["pages_read_estimated"]
                    for b in interacted_books
                )
                yr_words_read = sum(
                    b["total_words"] if (b["reading_status"] == "completed" and b["finished_year"] == yr) else b["words_read_estimated"]
                    for b in interacted_books
                )

                best_month_obj = max(monthly, key=lambda m: (m["seconds"], m["books_completed"]))
                best_rated_yr = (
                    max(
                        [b for b in interacted_books if b["rating"] > 0],
                        key=lambda b: (b["rating"], b["total_seconds"], b["total_words"]),
                    )
                    if any(b["rating"] > 0 for b in interacted_books)
                    else None
                )
                longest_yr = (
                    max(interacted_books, key=lambda b: b["total_words"])
                    if interacted_books
                    else None
                )
                most_time_yr = (
                    max(interacted_books, key=lambda b: yr_book_seconds.get(b["book_id"], b["total_seconds"]))
                    if interacted_books
                    else None
                )

                # Autor más leído en el año
                yr_author_sec: Dict[str, int] = {}
                for b in interacted_books:
                    au = b["author"]
                    yr_author_sec[au] = yr_author_sec.get(au, 0) + yr_book_seconds.get(b["book_id"], b["total_seconds"])
                top_author_yr = (
                    max(yr_author_sec.items(), key=lambda kv: kv[1])[0]
                    if yr_author_sec
                    else (interacted_books[0]["author"] if interacted_books else "—")
                )

                yearly_stats[str(yr)] = {
                    "year": yr,
                    "books_completed_count": len(completed_in_year),
                    "books_completed": completed_in_year,
                    "books_interacted_count": len(interacted_books),
                    "books_interacted": interacted_books,
                    "total_seconds": yr_sec,
                    "total_minutes": round(yr_sec / 60.0, 1),
                    "total_hours": round(yr_sec / 3600.0, 1),
                    "total_time_human": _format_duration_human(yr_sec),
                    "active_days_count": yr_active_days,
                    "sessions_count": yr_sessions,
                    "sentences_read": yr_sents,
                    "pages_read": yr_pages_read,
                    "words_read": yr_words_read,
                    "monthly_breakdown": monthly,
                    "best_month": best_month_obj if best_month_obj["seconds"] > 0 or best_month_obj["books_completed"] > 0 else None,
                    "best_rated_book": best_rated_yr,
                    "longest_book": longest_yr,
                    "most_time_book": most_time_yr,
                    "top_author": top_author_yr,
                }

            overview = {
                "today_date": today_str,
                "current_year": current_year,
                "current_streak_days": current_streak,
                "best_streak_days": best_streak,
                "today_seconds": today_sec,
                "today_minutes": round(today_sec / 60.0, 1),
                "today_time_human": _format_duration_human(today_sec),
                "week_seconds": week_sec,
                "week_minutes": round(week_sec / 60.0, 1),
                "week_time_human": _format_duration_human(week_sec),
                "month_seconds": month_sec,
                "month_minutes": round(month_sec / 60.0, 1),
                "month_time_human": _format_duration_human(month_sec),
                "total_books": len(books_summary),
                "completed_books": sum(1 for b in books_summary if b["reading_status"] == "completed"),
                "reading_books": sum(1 for b in books_summary if b["reading_status"] == "reading"),
                "paused_books": sum(1 for b in books_summary if b["reading_status"] == "paused"),
                "wishlist_books": sum(1 for b in books_summary if b["reading_status"] == "wishlist"),
                "total_reading_seconds": total_reading_sec,
                "total_reading_hours": round(total_reading_sec / 3600.0, 1),
                "total_reading_time_human": _format_duration_human(total_reading_sec),
                "total_days_active": len(active_dates_sorted),
                "total_sessions": sum(b["session_count"] for b in books_summary),
                "avg_daily_minutes_active": round((total_reading_sec / 60.0) / max(1, len(active_dates_sorted)), 1) if active_dates_sorted else 0.0,
                "total_words_read": total_words_read,
                "total_pages_read": total_pages_read,
                "avg_book_pages": avg_book_pages,
                "avg_book_words": avg_book_words,
                "avg_rating": avg_rating_all,
                "longest_book": longest_book,
                "shortest_book": shortest_book,
                "top_rated_book": top_rated_book,
                "most_read_book": most_read_book,
                "most_read_author_by_time": most_read_author_by_time,
                "most_read_author_by_books": most_read_author_by_books,
                "best_rated_author": best_rated_author,
            }

            return {
                "goals": goals,
                "overview": overview,
                "books": books_summary,
                "authors": authors_stats,
                "daily_map": daily_map,
                "yearly_stats": yearly_stats,
                "available_years": [str(y) for y in sorted(years_set, reverse=True)],
            }
