import os
import tempfile

import pytest

from urban_http.protocols.parse import parse_protocol_command
from urban_http.protocols.types import ProtocolContext
from urban_http.protocols import (
    execute_protocol, get_protocol_adapter, register_default_adapters,
    registered_schemes, unregister_protocol,
)
from urban_http.protocols.file import file_adapter
from urban_http.protocols.smtp import smtp_adapter
from urban_http.protocols.ftp import ftp_adapter
from urban_http.protocols.sftp import sftp_adapter
from urban_http.protocols.pop3 import pop3_adapter
from urban_http.protocols.mqtt import mqtt_adapter
from urban_http.protocols.tftp import tftp_adapter
from urban_http.protocols.smb import smb_adapter


def req_of(cmd):
    r = parse_protocol_command(cmd)
    assert r.request is not None, r.warnings
    return r.request


def dec(b):
    return b.decode() if b else None


def test_registry_defaults():
    for s in registered_schemes():
        unregister_protocol(s)
    register_default_adapters()
    for s in ["file", "smtp", "ftp", "sftp", "pop3", "mqtt", "tftp", "smb", "ws"]:
        assert get_protocol_adapter(s) is not None


def test_registry_missing():
    for s in registered_schemes():
        unregister_protocol(s)
    with pytest.raises(RuntimeError, match="Aucun adaptateur"):
        execute_protocol(req_of("curl ftp://e.com/f"))


# --- FILE (réel) ---------------------------------------------------------

def test_file_read():
    with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
        f.write(b"bonjour fichier")
        path = f.name
    try:
        res = file_adapter.execute(req_of(f"curl file://{path}"), ProtocolContext())
        assert res.ok and dec(res.body) == "bonjour fichier"
    finally:
        os.unlink(path)


def test_file_write():
    out = tempfile.mktemp(suffix=".txt")
    try:
        res = file_adapter.execute(req_of(f"curl -T src.txt file://{out}"), ProtocolContext(read_file=lambda p: "contenu téléversé"))
        assert res.ok
        with open(out) as fh:
            assert fh.read() == "contenu téléversé"
    finally:
        if os.path.exists(out):
            os.unlink(out)


def test_file_range():
    with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
        f.write(b"0123456789")
        path = f.name
    try:
        res = file_adapter.execute(req_of(f"curl -r 2-5 file://{path}"), ProtocolContext())
        assert dec(res.body) == "2345"
    finally:
        os.unlink(path)


# --- SMTP (client simulé) ------------------------------------------------

def test_smtp_send():
    captured = {}

    class Client:
        def send(self, from_addr, recipients, message):
            captured["from"] = from_addr
            captured["to"] = recipients
            captured["msg"] = message
            return {"rejected": [], "response": "250 OK"}

    res = smtp_adapter.execute(
        req_of("curl smtp://mail.e.com --mail-from moi@e.com --mail-rcpt toi@e.com -T message.txt"),
        ProtocolContext(read_file=lambda p: "Subject: Test\r\n\r\nCorps", client_factory=lambda req: Client()),
    )
    assert res.ok
    assert captured["from"] == "moi@e.com" and captured["to"] == ["toi@e.com"]
    assert b"Corps" in captured["msg"]
    assert res.summary == "250 OK"


def test_smtp_no_recipient():
    with pytest.raises(ValueError, match="destinataire"):
        smtp_adapter.execute(req_of("curl smtp://mail.e.com --mail-from m@e.com"), ProtocolContext())


# --- FTP (client simulé) -------------------------------------------------

def make_ftp(calls):
    class Client:
        def connect(self): calls.append("connect")
        def send_quote(self, cmd): calls.append("quote:" + cmd); return 200, "OK"
        def listing(self, path): calls.append("list"); return ["a.txt", "b.txt"]
        def download(self, path): calls.append("download:" + path); return b"contenu distant"
        def upload(self, data, path): calls.append("upload:" + path)
        def close(self): calls.append("close")
    return lambda: Client()


def test_ftp_download():
    calls = []
    res = ftp_adapter.execute(req_of("curl ftp://e.com/pub/f.txt"), ProtocolContext(client_factory=make_ftp(calls)))
    assert dec(res.body) == "contenu distant"
    assert "download:/pub/f.txt" in calls and "close" in calls


def test_ftp_list():
    res = ftp_adapter.execute(req_of("curl -l ftp://e.com/pub/"), ProtocolContext(client_factory=make_ftp([])))
    assert dec(res.body) == "a.txt\nb.txt"


def test_ftp_quote_before_transfer():
    calls = []
    ftp_adapter.execute(req_of('curl -Q "DELE old" ftp://e.com/f'), ProtocolContext(client_factory=make_ftp(calls)))
    assert calls.index("quote:DELE old") < calls.index("download:/f")


# --- SFTP (client simulé) ------------------------------------------------

def make_sftp(store):
    class Client:
        def connect(self): pass
        def get(self, path): return store.get(path, "").encode()
        def put(self, data, path): store[path] = data.decode()
        def listing(self, path): return list(store.keys())
        def close(self): pass
    return lambda: Client()


def test_sftp_roundtrip():
    store = {"/remote/in.txt": "données"}
    dl = sftp_adapter.execute(req_of("curl sftp://u@e.com/remote/in.txt"), ProtocolContext(client_factory=make_sftp(store)))
    assert dec(dl.body) == "données"
    sftp_adapter.execute(req_of("curl -T local.txt sftp://u@e.com/remote/out.txt"), ProtocolContext(client_factory=make_sftp(store), read_file=lambda p: "à écrire"))
    assert store["/remote/out.txt"] == "à écrire"


# --- POP3 (client simulé) ------------------------------------------------

def make_pop3():
    class Client:
        def connect(self): pass
        def listing(self): return "+OK 2 messages\n1 500\n2 1200\n."
        def retrieve(self, n): return f"Subject: msg {n}\n\ncorps {n}"
        def quit(self): pass
    return lambda req: Client()


def test_pop3_list():
    res = pop3_adapter.execute(req_of("curl pop3://u:p@mail.e.com/"), ProtocolContext(client_factory=make_pop3()))
    assert "1 500" in dec(res.body)


def test_pop3_retrieve():
    res = pop3_adapter.execute(req_of("curl pop3://u:p@mail.e.com/2"), ProtocolContext(client_factory=make_pop3()))
    assert "corps 2" in dec(res.body) and res.meta["message"] == 2


# --- MQTT (client simulé) ------------------------------------------------

def test_mqtt_publish():
    published = {}

    class Client:
        def connect(self): pass
        def publish(self, topic, payload, qos, retain): published.update(topic=topic, payload=payload.decode(), qos=qos, retain=retain)
        def subscribe_one(self, topic, qos, timeout_ms): return b""
        def close(self): pass

    res = mqtt_adapter.execute(req_of('curl mqtt://courtier/capteurs/t -d "21.5" --qos 1 --retain'), ProtocolContext(client_factory=lambda: Client()))
    assert res.ok
    assert published == {"topic": "capteurs/t", "payload": "21.5", "qos": 1, "retain": True}


def test_mqtt_subscribe():
    class Client:
        def connect(self): pass
        def publish(self, *a): pass
        def subscribe_one(self, topic, qos, timeout_ms): return b"22.1"
        def close(self): pass

    res = mqtt_adapter.execute(req_of("curl mqtt://courtier/capteurs/t"), ProtocolContext(client_factory=lambda: Client()))
    assert dec(res.body) == "22.1"


# --- TFTP (client simulé) ------------------------------------------------

def test_tftp_roundtrip():
    store = {"firmware": b"binaire"}

    class Client:
        def download(self, host, port, filename, timeout_ms): return store.get(filename, b"")
        def upload(self, data, host, port, filename, timeout_ms): store[filename] = data; return len(data)

    dl = tftp_adapter.execute(req_of("curl tftp://10.0.0.1/firmware"), ProtocolContext(client_factory=lambda: Client()))
    assert dec(dl.body) == "binaire"
    up = tftp_adapter.execute(req_of("curl -T cfg tftp://10.0.0.1/cfg"), ProtocolContext(client_factory=lambda: Client(), read_file=lambda p: "config"))
    assert up.ok and store["cfg"].decode() == "config"


# --- SMB (client simulé) -------------------------------------------------

def make_smb(store):
    class Client:
        def read_file(self, path): return store.get(path, "").encode()
        def write_file(self, path, data): store[path] = data.decode()
        def readdir(self, path): return list(store.keys())
        def disconnect(self): pass
    return lambda coords: Client()


def test_smb_read():
    store = {"dossier/f.txt": "depuis smb"}
    res = smb_adapter.execute(req_of("curl smb://serveur/partage/dossier/f.txt"), ProtocolContext(client_factory=make_smb(store)))
    assert dec(res.body) == "depuis smb" and res.meta["share"] == "partage"


def test_smb_write():
    store = {}
    smb_adapter.execute(req_of("curl -T local.txt smb://serveur/partage/out.txt"), ProtocolContext(client_factory=make_smb(store), read_file=lambda p: "contenu smb"))
    assert store["out.txt"] == "contenu smb"
