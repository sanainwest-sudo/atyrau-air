"""Жергілікті сервер: жоба файлдарын береді және /api/ask арқылы OpenAI-ға сұрақ жібереді.

Кілт тек осы серверде (.env файлынан), браузерге ешқашан берілмейді.
Іске қосу: python server.py [порт]   (әдепкі 8768)
"""
import json
import os
import sys
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BODY = 300_000  # браузерден келетін сұраудың шегі, байт


def read_env():
    env = {}
    try:
        with open(os.path.join(ROOT, '.env'), encoding='utf-8-sig') as f:
            for line in f:
                if '=' in line and not line.lstrip().startswith('#'):
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return env


SYSTEM = """Сен — деректер талдаушысысың. Пайдаланушы кестенің қысқаша мазмұнын (бағандар, топтау нәтижесі, топ-10 жолдар, мысал жолдар) және сұрақ береді.
Ережелер:
- Тек берілген деректерге сүйен. Онда жоқ нәрсені ойдан шығарма; жеткіліксіз болса, соны айт.
- Әр тұжырымға дәлел келтір: топ атауы, жол нөмірі немесе нақты сан.
- Сұрақ қай тілде болса, сол тілде жауап бер.
JSON қайтар: {"answer": "қысқа жауап, 1–3 сөйлем", "why": ["себеп", ...], "evidence": ["деректен нақты дәлел", ...], "caveats": ["шектеу немесе тексеру керек нәрсе", ...]}"""


def ask_openai(question, context):
    env = read_env()
    key = env.get('OPENAI_API_KEY', '')
    if not key.startswith('sk-'):
        return 500, {'error': '.env файлында OPENAI_API_KEY жоқ'}
    body = {
        'model': env.get('OPENAI_MODEL', 'gpt-5.4-mini'),
        'response_format': {'type': 'json_object'},
        'messages': [
            {'role': 'system', 'content': SYSTEM},
            {'role': 'user', 'content': f'ДЕРЕКТЕР:\n{context}\n\nСҰРАҚ: {question}'},
        ],
    }
    req = urllib.request.Request(
        'https://api.openai.com/v1/chat/completions',
        data=json.dumps(body).encode(),
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            j = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e)['error']['message']
        except Exception:
            msg = str(e)
        return 502, {'error': f'OpenAI: {msg}'}
    except Exception as e:
        return 502, {'error': f'OpenAI-ға қосылу мүмкін болмады: {e}'}
    try:
        result = json.loads(j['choices'][0]['message']['content'])
    except Exception:
        return 502, {'error': 'Модель JSON қайтармады'}
    result['model'] = j.get('model')
    result['usage'] = j.get('usage')
    return 200, result


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/api/ask':
            return self.send_error(404)
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_BODY:
            return self.reply(413, {'error': 'Сұрау тым үлкен'})
        try:
            data = json.loads(self.rfile.read(n))
            question, context = str(data['question']).strip(), str(data['context'])
        except Exception:
            return self.reply(400, {'error': 'question және context керек'})
        if not question:
            return self.reply(400, {'error': 'Сұрақ бос'})
        self.reply(*ask_openai(question, context))

    def reply(self, code, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        # .env және жасырын файлдарды бермейміз
        if any(part.startswith('.') for part in self.path.split('?')[0].split('/')):
            return self.send_error(404)
        super().do_GET()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8768
    print(f'http://127.0.0.1:{port}/app/index.html')
    ThreadingHTTPServer(('127.0.0.1', port), partial(Handler, directory=ROOT)).serve_forever()
