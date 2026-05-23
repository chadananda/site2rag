#!/tank/site2rag/ocr-venv/bin/python3
"""Nougat persistent server. Scientific PDF → LaTeX/Markdown.
Protocol: {"path": "...", "lang": "en"} → {"text": "...", "markdown": "..."}
Best for: academic papers, equations, LaTeX math notation.
NOTE: requires transformers<5.0 (nougat uses deprecated PretrainedConfig from modeling_utils)
"""
import sys, json, os, traceback

sys.stderr.write('nougat_server: loading...\n'); sys.stderr.flush()
try:
    from nougat import NougatModel
    from nougat.utils.checkpoint import get_checkpoint
    from PIL import Image
    import torch
    checkpoint = get_checkpoint()
    model = NougatModel.from_pretrained(checkpoint).to('cpu')
    model.eval()
    sys.stderr.write('nougat_server: ready\n'); sys.stderr.flush()
except Exception as e:
    sys.stderr.write(f'nougat_server: FATAL: {e}\n'); sys.exit(1)

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        req = json.loads(line)
        path = req.get('path', '')
        if not os.path.exists(path):
            print(json.dumps({'error': f'file not found: {path}'}), flush=True); continue
        img = Image.open(path).convert('RGB')
        with torch.no_grad():
            output = model.inference(image_tensors=model.encoder.prepare_input(img).unsqueeze(0))
        text = output['predictions'][0] if output.get('predictions') else ''
        print(json.dumps({'text': text, 'markdown': text}), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}), flush=True)
