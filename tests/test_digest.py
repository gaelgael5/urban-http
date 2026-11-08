import hashlib

from urban_http.digest import build_digest_authorization, parse_digest_challenge


def test_md5_vectors():
    # hashlib fournit MD5 ; on vérifie que la construction s'appuie dessus
    assert hashlib.md5(b"").hexdigest() == "d41d8cd98f00b204e9800998ecf8427e"


def test_parse_challenge():
    ch = parse_digest_challenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')
    assert ch.realm == "testrealm@host.com"
    assert ch.nonce == "dcd98b7102dd2f0e8b11d0f600bfb0c093"
    assert ch.qop == "auth,auth-int"
    assert ch.opaque == "5ccc069c403ebaf9f0171e9517f40e41"


def test_parse_multi_scheme():
    ch = parse_digest_challenge('Basic realm="r1", Digest realm="r2", nonce="n"')
    assert ch.nonce == "n"


def test_parse_no_digest():
    assert parse_digest_challenge('Basic realm="r1"') is None


def test_rfc2617_md5():
    header = build_digest_authorization(
        parse_digest_challenge('Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", qop="auth,auth-int", opaque="5ccc069c403ebaf9f0171e9517f40e41"'),
        "Mufasa", "Circle Of Life", "GET", "/dir/index.html",
        cnonce="0a4f113b", nc="00000001",
    )
    assert 'response="6629fae49393a05397450978507c4ef1"' in header
    assert 'username="Mufasa"' in header
    assert "qop=auth" in header


def test_rfc7616_sha256():
    header = build_digest_authorization(
        parse_digest_challenge('Digest realm="http-auth@example.org", nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", qop="auth", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS", algorithm=SHA-256'),
        "Mufasa", "Circle of Life", "GET", "/dir/index.html",
        cnonce="f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ", nc="00000001",
    )
    assert 'response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"' in header
    assert "algorithm=SHA-256" in header


def test_unknown_algorithm():
    ch = parse_digest_challenge('Digest realm="r", nonce="n", algorithm=MD4')
    assert build_digest_authorization(ch, "u", "p", "GET", "/") is None


def test_rfc2069_no_qop():
    import re
    header = build_digest_authorization(parse_digest_challenge('Digest realm="r", nonce="n"'), "u", "p", "GET", "/x")
    assert re.match(r'^Digest username="u", realm="r", nonce="n", uri="/x", response="[0-9a-f]{32}"$', header)
