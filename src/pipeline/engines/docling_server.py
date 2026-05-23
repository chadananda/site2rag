#!/tank/site2rag/ocr-venv/bin/python3
"""Docling persistent server. Layout-preserving document conversion.
Protocol: {"path": "...", "lang": "en"} → {"text": "...", "markdown": "...", "tables": [...]}
"""
import sys, json, os, traceback

sys.stderr.write('docling_server: loading...\n'); sys.stderr.flush()
try:
    from docling.document_converter import DocumentConverter
    converter = DocumentConverter()
    sys.stderr.write('docling_server: ready\n'); sys.stderr.flush()
except Exception as e:
    sys.stderr.write(f'docling_server: FATAL: {e}\n'); sys.exit(1)

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        req = json.loads(line)
        path = req.get('path', '')
        if not os.path.exists(path):
            print(json.dumps({'error': f'file not found: {path}'}), flush=True); continue
        result = converter.convert(path)
        md = result.document.export_to_markdown()
        # Extract tables if present
        tables = []
        for table in (result.document.tables or []):
            try:
                tables.append(table.export_to_dataframe().to_dict())
            except: pass
        print(json.dumps({'text': md, 'markdown': md, 'tables': tables}), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}), flush=True)
