import html
import json
import logging
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("epub_tts.dictionary")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class DictionaryService:
    """Servicio bilingüe de traducción (EN ↔ ES) y diccionario monolingüe (EN y ES)."""

    def __init__(self, data_dir: Path) -> None:
        self.cache_file = data_dir / "dictionary_cache.json"
        self._cache: Dict[str, Dict[str, Any]] = self._load_cache()

    @staticmethod
    def _has_real_definitions(entry: Dict[str, Any]) -> bool:
        if not isinstance(entry, dict):
            return False
        defs = entry.get("definitions")
        if not isinstance(defs, list) or not defs:
            return False
        for d in defs:
            if not isinstance(d, dict):
                continue
            for s in d.get("senses") or []:
                if not isinstance(s, dict):
                    continue
                txt = str(s.get("definition") or "").strip()
                if (
                    len(txt) >= 18
                    and not txt.startswith("Acepciones equivalentes:")
                    and not txt.startswith("Equivalent meanings:")
                ):
                    return True
        return False

    def _load_cache(self) -> Dict[str, Dict[str, Any]]:
        if not self.cache_file.exists():
            return {}
        try:
            raw = json.loads(self.cache_file.read_text(encoding="utf-8"))
            # Descartar entradas antiguas incompletas donde la traducción o las definiciones fallaron
            valid = {}
            for k, v in raw.items():
                if (
                    isinstance(v, dict)
                    and v.get("translation")
                    and self._has_real_definitions(v)
                    and (
                        v.get("translation", "").lower() != v.get("word", "").lower()
                        or v.get("bilingual_entries")
                    )
                ):
                    valid[k] = v
            return valid
        except Exception:
            return {}

    def _save_cache(self) -> None:
        try:
            if len(self._cache) > 1500:
                keys = list(self._cache.keys())[-1000:]
                self._cache = {k: self._cache[k] for k in keys}
            self.cache_file.write_text(
                json.dumps(self._cache, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            logger.debug("No se pudo guardar caché de diccionario: %s", exc)

    def _http_get_json(self, url: str, timeout: float = 6.0) -> Any:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json, text/plain, */*",
            },
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw_bytes = resp.read()
            return json.loads(raw_bytes.decode("utf-8", errors="replace"))

    @staticmethod
    def clean_word(raw_word: str) -> str:
        cleaned = re.sub(
            r"^[^\wáéíóúüñÁÉÍÓÚÜÑ]+|[^\wáéíóúüñÁÉÍÓÚÜÑ]+$",
            "",
            (raw_word or "").strip(),
        )
        return cleaned

    @staticmethod
    def clean_phonetic(raw_phonetic: str) -> str:
        return (raw_phonetic or "").strip().strip("/").strip()

    def lookup(
        self, word: str, source_lang: str = "en", context_sentence: Optional[str] = None
    ) -> Dict[str, Any]:
        cleaned = self.clean_word(word)
        if not cleaned:
            raise ValueError("No se ha seleccionado ninguna palabra válida.")

        src = "es" if (source_lang or "").lower().startswith("es") else "en"
        tgt = "en" if src == "es" else "es"

        cache_key = f"{src}:{cleaned.lower()}"
        cached = self._cache.get(cache_key)

        if (
            cached
            and self._has_real_definitions(cached)
            and (
                cached.get("translation", "").lower() != cleaned.lower()
                or cached.get("bilingual_entries")
            )
        ):
            result = dict(cached)
        else:
            result = self._build_word_entry(cleaned, src, tgt)
            if self._has_real_definitions(result) and (
                result.get("translation", "").lower() != cleaned.lower()
                or result.get("bilingual_entries")
            ):
                self._cache[cache_key] = dict(result)
                self._save_cache()

        # Si hay frase de contexto, traducirla también para entender la acepción exacta
        if context_sentence and len(context_sentence.strip()) > 3:
            short_sent = context_sentence.strip()[:450]
            result["context_sentence"] = short_sent
            result["context_translation"] = self._translate_plain_text(short_sent, src, tgt)

        return result

    def _build_word_entry(self, word: str, src: str, tgt: str) -> Dict[str, Any]:
        # 1. Consultar Google GTX (traducción directa + diccionario bilingüe + definiciones monolingües + lema)
        gtx_info = self._query_google_gtx(word, src, tgt)

        primary_translation = gtx_info.get("translation") or ""
        bilingual_entries = gtx_info.get("bilingual_entries", [])
        phonetic = self.clean_phonetic(gtx_info.get("phonetic") or "")
        detected_lemma = gtx_info.get("lemma") or word.lower()

        # Si la traducción principal está vacía o igual a la palabra original pero hay entradas bilingües, usar la 1ª acepción
        if (
            not primary_translation
            or primary_translation.lower() == word.lower()
        ) and bilingual_entries:
            first_terms = bilingual_entries[0].get("terms", [])
            if first_terms:
                primary_translation = ", ".join(first_terms[:3])

        # Respaldo adicional con clients5 / MyMemory si no se obtuvo traducción
        if not primary_translation or primary_translation.lower() == word.lower():
            fallback_trans, fallback_terms = self._query_fallback_translators(word, src, tgt)
            if fallback_trans:
                primary_translation = fallback_trans
            if fallback_terms and not bilingual_entries:
                bilingual_entries.append({"pos": "traducción", "terms": fallback_terms})

        if not primary_translation:
            primary_translation = word

        definitions: List[Dict[str, Any]] = []

        if src == "en":
            en_defs, en_phonetic = self._fetch_english_dictionary(word, detected_lemma)
            if en_phonetic:
                phonetic = self.clean_phonetic(en_phonetic)
            definitions.extend(en_defs)
            for md in gtx_info.get("monolingual_definitions", []):
                if not any(
                    d["part_of_speech"].lower() == md["part_of_speech"].lower()
                    for d in definitions
                ):
                    definitions.append(md)
        else:
            definitions.extend(gtx_info.get("monolingual_definitions", []))
            es_defs = self._fetch_spanish_wiktionary(word, detected_lemma)
            for ed in es_defs:
                definitions.append(ed)

        if not definitions and bilingual_entries:
            for b_entry in bilingual_entries:
                terms_str = ", ".join(b_entry.get("terms", [])[:6])
                if terms_str:
                    definitions.append(
                        {
                            "part_of_speech": b_entry.get("pos", ""),
                            "senses": [
                                {
                                    "definition": (
                                        f"Acepciones equivalentes: {terms_str}."
                                        if src == "es"
                                        else f"Equivalent meanings: {terms_str}."
                                    ),
                                    "example": "",
                                }
                            ],
                        }
                    )

        return {
            "word": word,
            "lemma": detected_lemma,
            "source_lang": src,
            "target_lang": tgt,
            "phonetic": phonetic,
            "translation": primary_translation,
            "bilingual_entries": bilingual_entries,
            "definitions": definitions,
            "dictionary_lang_label": (
                "Diccionario en Inglés (EN)"
                if src == "en"
                else "Diccionario en Castellano (ES)"
            ),
            "translation_lang_label": (
                "Traducción al Castellano (ES)"
                if src == "en"
                else "Traducción al Inglés (EN)"
            ),
        }

    def _translate_plain_text(self, text: str, src: str, tgt: str) -> str:
        q = urllib.parse.quote(text)
        urls = [
            f"https://translate.googleapis.com/translate_a/single?client=gtx&sl={src}&tl={tgt}&dt=t&q={q}",
            f"https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl={src}&tl={tgt}&q={q}",
        ]
        for url in urls:
            try:
                data = self._http_get_json(url, timeout=4.5)
                if isinstance(data, list) and data:
                    if isinstance(data[0], str):
                        return data[0].strip()
                    if isinstance(data[0], list):
                        parts = [
                            seg[0]
                            for seg in data[0]
                            if isinstance(seg, list) and seg and isinstance(seg[0], str)
                        ]
                        joined = "".join(parts).strip()
                        if joined:
                            return joined
            except Exception as exc:
                logger.debug("Error traduciendo frase con %s: %s", url, exc)
        return ""

    def _query_google_gtx(self, word: str, src: str, tgt: str) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "translation": "",
            "phonetic": "",
            "lemma": word.lower(),
            "bilingual_entries": [],
            "monolingual_definitions": [],
        }
        try:
            q = urllib.parse.quote(word)
            hl = "es"
            # Nota: cada parámetro dt= debe ir por separado; usar los soportados por client=gtx
            url = (
                f"https://translate.googleapis.com/translate_a/single"
                f"?client=gtx&sl={src}&tl={tgt}&hl={hl}"
                f"&dt=t&dt=bd&q={q}"
            )
            data = self._http_get_json(url, timeout=5.0)
            if not isinstance(data, list):
                return result

            # [0]: Traducción principal y transcripción fonética
            if len(data) > 0 and isinstance(data[0], list):
                trans_parts = []
                for item in data[0]:
                    if isinstance(item, list) and len(item) >= 1 and item[0]:
                        trans_parts.append(str(item[0]))
                    if isinstance(item, list) and len(item) >= 4 and item[3]:
                        result["phonetic"] = str(item[3])
                result["translation"] = "".join(trans_parts).strip()

            # [1]: Diccionario bilingüe por categoría gramatical
            if len(data) > 1 and isinstance(data[1], list):
                for pos_block in data[1]:
                    if not isinstance(pos_block, list) or len(pos_block) < 2:
                        continue
                    pos_name = str(pos_block[0] or "")
                    terms = [
                        str(t) for t in (pos_block[1] or []) if isinstance(t, str)
                    ][:8]
                    if (
                        len(pos_block) > 3
                        and isinstance(pos_block[3], str)
                        and pos_block[3]
                    ):
                        result["lemma"] = pos_block[3]
                    if terms:
                        result["bilingual_entries"].append(
                            {
                                "pos": pos_name,
                                "terms": terms,
                            }
                        )

            # [12]: Definiciones monolingües en el idioma origen (src)
            if len(data) > 12 and isinstance(data[12], list):
                for def_block in data[12]:
                    if not isinstance(def_block, list) or len(def_block) < 2:
                        continue
                    pos_name = str(def_block[0] or "")
                    senses = []
                    if isinstance(def_block[1], list):
                        for s_item in def_block[1][:5]:
                            if (
                                isinstance(s_item, list)
                                and len(s_item) >= 1
                                and s_item[0]
                            ):
                                definition_text = str(s_item[0]).strip()
                                example_text = (
                                    str(s_item[2]).strip()
                                    if len(s_item) > 2 and s_item[2]
                                    else ""
                                )
                                senses.append(
                                    {
                                        "definition": definition_text,
                                        "example": example_text,
                                    }
                                )
                    if (
                        len(def_block) > 2
                        and isinstance(def_block[2], str)
                        and def_block[2]
                    ):
                        result["lemma"] = def_block[2]
                    if senses:
                        result["monolingual_definitions"].append(
                            {
                                "part_of_speech": pos_name,
                                "senses": senses,
                            }
                        )
        except Exception as exc:
            logger.warning("Error consultando Google GTX para '%s': %s", word, exc)
            result["debug_error"] = str(exc)

        return result

    def _query_fallback_translators(
        self, word: str, src: str, tgt: str
    ) -> tuple[str, List[str]]:
        q = urllib.parse.quote(word)
        # 1. Google clients5 dict-chrome-ex
        try:
            url = f"https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl={src}&tl={tgt}&q={q}"
            data = self._http_get_json(url, timeout=4.5)
            if isinstance(data, list) and data:
                if isinstance(data[0], str) and data[0].strip():
                    return data[0].strip(), []
                if isinstance(data[0], list) and data[0] and isinstance(data[0][0], str):
                    return data[0][0].strip(), []
        except Exception:
            pass

        # 2. MyMemory Translated API
        try:
            url = f"https://api.mymemory.translated.net/get?q={q}&langpair={src}|{tgt}"
            data = self._http_get_json(url, timeout=4.5)
            if isinstance(data, dict):
                main_t = (
                    (data.get("responseData") or {}).get("translatedText") or ""
                ).strip()
                extra_terms: List[str] = []
                for m in data.get("matches") or []:
                    if isinstance(m, dict) and m.get("translation"):
                        t_str = str(m["translation"]).strip()
                        if t_str and t_str.lower() != word.lower() and t_str not in extra_terms:
                            extra_terms.append(t_str)
                return main_t, extra_terms[:6]
        except Exception:
            pass

        return "", []

    @staticmethod
    def _strip_html(raw_html: str) -> str:
        if not raw_html:
            return ""
        no_tags = re.sub(r"<[^>]+>", "", raw_html)
        text = html.unescape(no_tags)
        return re.sub(r"\s+", " ", text).strip()

    @staticmethod
    def _expand_english_candidates(word: str, lemma: str) -> List[str]:
        candidates: List[str] = []
        for base in (word, lemma, word.lower(), (lemma or "").lower()):
            b = (base or "").strip()
            if b and b not in candidates:
                candidates.append(b)
        w_low = word.lower().strip()
        if len(w_low) > 4:
            if w_low.endswith("ies"):
                stem = w_low[:-3] + "y"
                if stem not in candidates:
                    candidates.append(stem)
            if w_low.endswith("es"):
                for s in (w_low[:-2], w_low[:-1]):
                    if len(s) >= 3 and s not in candidates:
                        candidates.append(s)
            elif w_low.endswith("s") and not w_low.endswith("ss"):
                s = w_low[:-1]
                if len(s) >= 3 and s not in candidates:
                    candidates.append(s)
            if w_low.endswith("ed"):
                for s in (w_low[:-2], w_low[:-1]):
                    if len(s) >= 3 and s not in candidates:
                        candidates.append(s)
            if w_low.endswith("ing") and len(w_low) > 5:
                for s in (w_low[:-3], w_low[:-3] + "e"):
                    if len(s) >= 3 and s not in candidates:
                        candidates.append(s)
        return candidates

    def _fetch_english_dictionary(
        self, word: str, lemma: str
    ) -> tuple[List[Dict[str, Any]], str]:
        candidates = self._expand_english_candidates(word, lemma)
        definitions: List[Dict[str, Any]] = []
        phonetic = ""

        # 1. Fuente principal: Free Dictionary API (dictionaryapi.dev)
        for cand in candidates:
            if not cand.islower():
                continue
            try:
                url = f"https://api.dictionaryapi.dev/api/v2/entries/en/{urllib.parse.quote(cand)}"
                data = self._http_get_json(url, timeout=4.0)
                if isinstance(data, list) and data:
                    entry = data[0]
                    phonetic = entry.get("phonetic") or ""
                    if not phonetic and isinstance(entry.get("phonetics"), list):
                        for ph in entry["phonetics"]:
                            if isinstance(ph, dict) and ph.get("text"):
                                phonetic = ph["text"]
                                break

                    for meaning in entry.get("meanings", []):
                        pos = meaning.get("partOfSpeech", "")
                        senses = []
                        for d in meaning.get("definitions", [])[:4]:
                            def_txt = (d.get("definition") or "").strip()
                            ex_txt = (d.get("example") or "").strip()
                            if def_txt:
                                senses.append(
                                    {"definition": def_txt, "example": ex_txt}
                                )
                        if senses:
                            definitions.append(
                                {
                                    "part_of_speech": pos,
                                    "senses": senses,
                                }
                            )
                    if definitions:
                        return definitions, phonetic
            except Exception:
                continue

        # 2. Respaldo directo: Wiktionary REST API en inglés (en.wiktionary.org)
        for cand in candidates:
            try:
                url = f"https://en.wiktionary.org/api/rest_v1/page/definition/{urllib.parse.quote(cand)}"
                data = self._http_get_json(url, timeout=4.5)
                if isinstance(data, dict) and isinstance(data.get("en"), list):
                    for meaning in data["en"]:
                        if not isinstance(meaning, dict):
                            continue
                        pos = (meaning.get("partOfSpeech") or "").strip()
                        senses = []
                        for d in (meaning.get("definitions") or [])[:4]:
                            if not isinstance(d, dict):
                                continue
                            def_txt = self._strip_html(d.get("definition") or "")
                            if not def_txt:
                                continue
                            ex_txt = ""
                            examples_list = d.get("parsedExamples") or d.get("examples") or []
                            if isinstance(examples_list, list) and examples_list:
                                first_ex = examples_list[0]
                                if isinstance(first_ex, dict):
                                    ex_txt = self._strip_html(first_ex.get("example") or "")
                                elif isinstance(first_ex, str):
                                    ex_txt = self._strip_html(first_ex)
                            senses.append({"definition": def_txt, "example": ex_txt})
                        if senses:
                            definitions.append({"part_of_speech": pos, "senses": senses})
                    if definitions:
                        return definitions[:4], phonetic
            except Exception:
                continue

        return definitions, phonetic

    @staticmethod
    def _expand_spanish_candidates(word: str, lemma: str) -> List[str]:
        candidates: List[str] = []
        for base in (word.lower(), (lemma or "").lower(), word):
            b = (base or "").strip()
            if b and b not in candidates:
                candidates.append(b)
        w_low = word.lower().strip()
        if len(w_low) > 4:
            if w_low.endswith("ces"):
                s = w_low[:-3] + "z"
                if s not in candidates:
                    candidates.append(s)
            if w_low.endswith("es") and len(w_low) > 4:
                for s in (w_low[:-2], w_low[:-1]):
                    if len(s) >= 3 and s not in candidates:
                        candidates.append(s)
            elif w_low.endswith("s") and not w_low.endswith("ss"):
                s = w_low[:-1]
                if len(s) >= 3 and s not in candidates:
                    candidates.append(s)
            if w_low.endswith("as") and len(w_low) > 4:
                s = w_low[:-2] + "o"
                if s not in candidates:
                    candidates.append(s)
            elif w_low.endswith("a") and len(w_low) > 4:
                s = w_low[:-1] + "o"
                if s not in candidates:
                    candidates.append(s)
        return candidates

    def _fetch_spanish_wiktionary(
        self, word: str, lemma: str
    ) -> List[Dict[str, Any]]:
        candidates = self._expand_spanish_candidates(word, lemma)
        visited = set()

        idx = 0
        while idx < len(candidates) and idx < 8:
            cand = candidates[idx]
            idx += 1
            if not cand or cand in visited:
                continue
            visited.add(cand)
            try:
                q = urllib.parse.quote(cand)
                url = (
                    f"https://es.wiktionary.org/w/api.php"
                    f"?action=query&prop=extracts&titles={q}"
                    f"&explaintext=1&redirects=1&format=json"
                )
                data = self._http_get_json(url, timeout=4.5)
                pages = data.get("query", {}).get("pages", {})
                for page_id, page_info in pages.items():
                    if str(page_id) == "-1":
                        continue
                    extract = page_info.get("extract") or ""
                    parsed, ref_lemma = self._parse_es_wiktionary_extract(extract, cand)
                    if ref_lemma and ref_lemma.lower() not in visited and ref_lemma.lower() not in candidates:
                        candidates.append(ref_lemma.lower())
                    if parsed:
                        return parsed
            except Exception as exc:
                logger.debug("Wikcionario ES no disponible para '%s': %s", cand, exc)
                continue

        return []

    @staticmethod
    def _parse_es_wiktionary_extract(
        extract: str, title: str
    ) -> tuple[List[Dict[str, Any]], str]:
        if not extract:
            return [], ""

        es_match = re.search(r"==\s*Español\s*==", extract, flags=re.IGNORECASE)
        if es_match:
            section = extract[es_match.end() :]
            next_lang = re.search(r"\n==\s*[^=]+\s*==", section)
            if next_lang:
                section = section[: next_lang.start()]
        else:
            section = extract

        results: List[Dict[str, Any]] = []
        current_pos = f"Definición ({title})"
        current_senses: List[Dict[str, str]] = []
        in_ignored_section = False
        pending_sense_domain: Optional[str] = None
        referenced_lemma = ""

        ignored_headers = (
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
        )
        meta_prefixes = (
            "sinónimo",
            "sinónimos:",
            "antónimo",
            "antónimos:",
            "relacionado",
            "relacionados:",
            "hiperónimo",
            "hipónimo",
            "cohipónimo",
            "uso:",
            "ámbito:",
            "registro:",
            "nota:",
        )

        for raw_line in section.splitlines():
            line = raw_line.strip()
            if not line:
                continue

            header_match = re.match(r"^===+\s*(.+?)\s*===+$", line)
            if header_match:
                pending_sense_domain = None
                h_title = header_match.group(1).strip()
                if any(kw in h_title.lower() for kw in ignored_headers):
                    in_ignored_section = True
                    continue
                in_ignored_section = False
                if current_senses:
                    results.append(
                        {"part_of_speech": current_pos, "senses": current_senses[:5]}
                    )
                    current_senses = []
                current_pos = h_title
                continue

            if in_ignored_section:
                continue

            # Ignorar línea de lema/plural (ej: "triclinio ¦ plural: triclinios")
            if "¦" in line or line.lower() == title.lower():
                continue

            low_line = line.lower()
            if low_line.startswith(("ejemplo:", "ejemplos:")):
                ex_text = re.sub(r"^ejemplos?:\s*", "", line, flags=re.IGNORECASE).strip()
                if current_senses and ex_text and not current_senses[-1].get("example"):
                    current_senses[-1]["example"] = ex_text[:220]
                continue

            if low_line.startswith(meta_prefixes):
                continue

            # Detectar inicio de acepción numerada: "1", "1 Historia, mobiliario", ";1: Definición..."
            sense_match = re.match(r"^;?\s*(\d{1,2})\b\s*[:.]?\s*(.*)$", line)
            if sense_match:
                inline_rest = html.unescape(sense_match.group(2) or "").strip()
                inline_rest = re.sub(r"(\w)\d+(?=[.;,]|$)", r"\1", inline_rest)
                if not inline_rest:
                    pending_sense_domain = ""
                elif len(inline_rest) < 42 and not inline_rest.endswith("."):
                    # En Wikcionario ES, el texto corto en la misma línea del número es el ámbito ("Historia, política")
                    # y la definición real viene en la línea inmediatamente siguiente.
                    pending_sense_domain = inline_rest
                else:
                    current_senses.append({"definition": inline_rest, "example": ""})
                    pending_sense_domain = None
                continue

            # Si venimos de una línea de número de acepción ("1" o "1 Ámbito"), esta línea es la definición real
            if pending_sense_domain is not None:
                def_text = html.unescape(line).strip()
                def_text = re.sub(r"(\w)\d+(?=[.;,]|$)", r"\1", def_text)
                if len(def_text) > 3:
                    if pending_sense_domain:
                        full_def = f"({pending_sense_domain}) {def_text}"
                    else:
                        full_def = def_text
                    current_senses.append({"definition": full_def, "example": ""})
                    # Si es una forma flexionada ("Forma del plural de X", "Primera persona... de X"), extraer lema base
                    if not referenced_lemma:
                        ref_m = re.search(
                            r"(?:forma del|plural de|femenino de|participio de|gerundio de|infinitivo|persona\b[^.]+?\bde)\s+([a-záéíóúüñ]{3,})",
                            def_text,
                            flags=re.IGNORECASE,
                        )
                        if ref_m:
                            referenced_lemma = ref_m.group(1).strip()
                pending_sense_domain = None

        if current_senses:
            results.append(
                {"part_of_speech": current_pos, "senses": current_senses[:5]}
            )

        return results[:4], referenced_lemma
