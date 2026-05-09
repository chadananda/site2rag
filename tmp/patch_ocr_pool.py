#!/usr/bin/env python3
content = open('/tank/site2rag/app/src/pipeline/ocr-server-pool.js').read()

old = "  throw new Error(`callLocalEngine: unknown engine id '${engineId}'`);\n}"

new_block = """  if (engineId === 'trocr') {
    const HANDWRITING_LANGS = new Set(['ara','fas','per','ug','pus','dzo']);
    const mode = HANDWRITING_LANGS.has(lang) ? 'handwritten' : 'printed';
    const res = await _callOcrServer('trocr', SURYA_PYTHON, `${ENGINES_DIR}/trocr_server.py`, { path: pngPath, lang, mode });
    if (res.error) return { text: '', words: [] };
    return { text: res.text ?? '', words: [] };
  }
  if (engineId === 'docling') {
    const res = await _callOcrServer('docling', SURYA_PYTHON, `${ENGINES_DIR}/docling_server.py`, { path: pngPath, lang });
    if (res.error) return { text: '', words: [] };
    return { text: res.markdown ?? res.text ?? '', words: [], tables: res.tables ?? [] };
  }
  throw new Error(`callLocalEngine: unknown engine id '${engineId}'`);
}"""

if old not in content:
    print('ERROR: old string not found')
    exit(1)

content = content.replace(old, new_block, 1)
open('/tank/site2rag/app/src/pipeline/ocr-server-pool.js', 'w').write(content)
print('done')
