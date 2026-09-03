import json
import hmac
import hashlib
import os
import urllib.request

with open('output.txt', 'r') as f:
    output = f.read()

with open('exit_code.txt', 'r') as f:
    exit_code = int(f.read().strip())

payload = json.dumps({'output': output, 'exit_code': exit_code})
secret = os.environ['HMAC_SECRET'].encode()
signature = hmac.new(secret, payload.encode(), hashlib.sha256).hexdigest()

req = urllib.request.Request(
    'https://fox1-ai.abdelrhym096290.workers.dev/result',
    data=payload.encode(),
    headers={
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=' + signature
    }
)

try:
    resp = urllib.request.urlopen(req)
    print(resp.read().decode())
except Exception as e:
    print('Error:', str(e))
    raise