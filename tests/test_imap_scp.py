from urban_http.protocols.parse import parse_protocol_command
from urban_http.protocols.types import ProtocolContext
from urban_http.protocols.imap import imap_adapter
from urban_http.protocols.scp import scp_adapter


def req_of(cmd):
    r = parse_protocol_command(cmd)
    assert r.request is not None, r.warnings
    return r.request


def dec(b):
    return b.decode() if b else None


# --- Parsing -------------------------------------------------------------

def test_imap_ports_and_direction():
    assert req_of("curl imap://mail.e.com/").port == 143
    assert req_of("curl imaps://mail.e.com/").port == 993
    assert req_of("curl imaps://mail.e.com/").secure is True
    assert req_of("curl imap://mail.e.com/").direction == "list"
    assert req_of("curl imap://mail.e.com/INBOX").direction == "list"
    assert req_of("curl imap://mail.e.com/INBOX/42").direction == "download"


def test_imap_mailbox_uid():
    r = req_of("curl imap://u:p@mail.e.com/Travail/Projets/17")
    assert r.imap.mailbox == "Travail/Projets" and r.imap.uid == 17
    assert r.username == "u" and r.password == "p"


def test_scp_parsing():
    assert req_of("curl scp://alice@serveur/home/alice/data.csv").direction == "download"
    assert req_of("curl scp://alice@serveur/home/alice/data.csv").port == 22
    up = req_of("curl -T local.csv scp://alice@serveur/home/alice/data.csv")
    assert up.direction == "upload" and up.payload.file_path == "local.csv"


# --- Adaptateur IMAP (client simulé) ------------------------------------

def make_imap(messages):
    class Client:
        def connect(self): pass
        def list_mailboxes(self): return ["INBOX", "Sent", "Travail"]
        def list_messages(self, mailbox): return list(messages.keys())
        def fetch(self, mailbox, uid): return messages.get(str(uid), b"")
        def logout(self): pass
    return lambda req: Client()


def test_imap_list_mailboxes():
    res = imap_adapter.execute(req_of("curl imap://u:p@mail.e.com/"), ProtocolContext(client_factory=make_imap({})))
    assert res.ok and "INBOX" in dec(res.body) and "Travail" in dec(res.body)
    assert res.meta["mailboxes"] == ["INBOX", "Sent", "Travail"]


def test_imap_list_messages():
    res = imap_adapter.execute(req_of("curl imap://u:p@mail.e.com/INBOX"), ProtocolContext(client_factory=make_imap({"1": b"", "2": b""})))
    assert dec(res.body) == "1\n2" and res.meta["mailbox"] == "INBOX"


def test_imap_fetch():
    res = imap_adapter.execute(req_of("curl imap://u:p@mail.e.com/INBOX/42"), ProtocolContext(client_factory=make_imap({"42": b"Subject: Salut\r\n\r\nCorps du mail"})))
    assert "Corps du mail" in dec(res.body)
    assert res.meta["uid"] == 42 and res.meta["mailbox"] == "INBOX"


# --- Adaptateur SCP (client simulé) -------------------------------------

def make_scp(store):
    class Client:
        def connect(self): pass
        def get(self, path): return store.get(path, "").encode()
        def put(self, data, path): store[path] = data.decode()
        def close(self): pass
    return lambda: Client()


def test_scp_download():
    store = {"/home/alice/data.csv": "a,b,c\n1,2,3"}
    res = scp_adapter.execute(req_of("curl scp://alice@serveur/home/alice/data.csv"), ProtocolContext(client_factory=make_scp(store)))
    assert dec(res.body) == "a,b,c\n1,2,3" and res.meta["bytes"] == 11


def test_scp_upload():
    store = {}
    scp_adapter.execute(req_of("curl -T local.csv scp://alice@serveur/home/alice/out.csv"), ProtocolContext(client_factory=make_scp(store), read_file=lambda p: "contenu scp"))
    assert store["/home/alice/out.csv"] == "contenu scp"
