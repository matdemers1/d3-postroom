#!/usr/bin/env bash
# Regenerates the PGP/MIME and S/MIME interop fixtures for @postroom/pgp (PST-T-12.1, PST-REQ-160).
#
# Every identity made here is a THROWAWAY TEST IDENTITY (example.test, RFC 2606): the secret keys
# written beside the fixtures are TEST-ONLY and exist so the decryption tests have something to
# decrypt with. Nothing here is, or may ever become, a real key.
#
#   alice  Ed25519 v4 primary (sign) + Curve25519 ECDH subkey (encrypt) — what Proton issues
#   bob    RSA-3072 v4 primary (sign) + RSA-3072 subkey (encrypt)
#   carol  S/MIME: RSA-2048 leaf with rfc822Name, under a test intermediate under a test root
#
# Keys are made with AEAD removed from their preferences (setpref), so gpg writes SEIPD v1 (MDC,
# AES-CFB) as Proton and RFC 4880 clients do; one fixture forces LibrePGP OCB to exercise the
# named refusal. Needs gpg 2.4+ and openssl 3.x. Run from anywhere:
#   bash packages/pgp/test/fixtures/make-fixtures.sh
set -euo pipefail

OUT="$(cd "$(dirname "$0")" && pwd)"
GPG="${GPG:-/opt/homebrew/bin/gpg}"
OPENSSL="${OPENSSL:-/opt/homebrew/bin/openssl}"
WORK="$(mktemp -d /tmp/pst-pgp-fixtures.XXXXXX)"
export GNUPGHOME="$WORK/gnupg"
mkdir -m 700 "$GNUPGHOME"
trap 'gpgconf --kill all >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

g() { "$GPG" --batch --quiet --pinentry-mode loopback --passphrase '' --trust-model always "$@"; }
crlf() { perl -pe 's/\r?\n/\r\n/'; }
fpr() { g --with-colons --list-keys "$1" | awk -F: '/^fpr/{print $10; exit}'; }
noaead() { printf 'setpref AES256 AES192 AES SHA512 SHA384 SHA256 ZLIB ZIP Uncompressed\ny\nsave\n' | g --command-fd 0 --edit-key "$1" >/dev/null 2>&1; }

# ---- OpenPGP identities -------------------------------------------------------------------------
g --quick-gen-key 'Alice Test <alice@example.test>' ed25519 sign never
A="$(fpr alice@example.test)"
g --quick-add-key "$A" cv25519 encr never
noaead "$A"

g --quick-gen-key 'Bob Test <bob@example.test>' rsa3072 sign never
B="$(fpr bob@example.test)"
g --quick-add-key "$B" rsa3072 encr never
noaead "$B"

g --armor --export alice@example.test > "$OUT/alice-ed25519.pub.asc"
g --armor --export-secret-keys alice@example.test > "$OUT/alice-ed25519.TEST-ONLY.sec.asc"
g --armor --export bob@example.test > "$OUT/bob-rsa3072.pub.asc"
g --armor --export-secret-keys bob@example.test > "$OUT/bob-rsa3072.TEST-ONLY.sec.asc"
echo "$A" > "$OUT/alice-ed25519.fpr"
echo "$B" > "$OUT/bob-rsa3072.fpr"

DATE='Sat, 26 Sep 2026 12:00:00 +0000'

# ---- PGP/MIME signed (RFC 3156 §5), Ed25519, Proton-shaped: the signed entity is multipart/mixed
# carrying the sender's public key as an application/pgp-keys attachment.
{
  printf 'Content-Type: multipart/mixed; boundary="inner-1"\n\n'
  printf -- '--inner-1\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\n'
  printf 'Hello Bob,\n\nThis message is signed with an Ed25519 key, the way Proton sends it.\nA line with =3D in it, and trailing space =20\n\n-- \nAlice\n'
  printf -- '--inner-1\nContent-Type: application/pgp-keys; name="publickey-alice@example.test.asc"\n'
  printf 'Content-Disposition: attachment; filename="publickey-alice@example.test.asc"\n\n'
  cat "$OUT/alice-ed25519.pub.asc"
  printf -- '--inner-1--\n'
} | crlf > "$WORK/signed-ed25519.part"
g --local-user "$A" --digest-algo SHA256 --armor --detach-sign -o "$WORK/signed-ed25519.sig" "$WORK/signed-ed25519.part"

pgp_mime_signed() { # $1 part  $2 sig  $3 from  $4 subject
  {
    printf 'From: %s\nTo: Me <me@d3cloud.io>\nSubject: %s\nDate: %s\nMessage-ID: <%s@example.test>\nMIME-Version: 1.0\n' "$3" "$4" "$DATE" "$RANDOM$RANDOM"
    printf 'Content-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="sig-b"\n\n'
    printf 'This is an OpenPGP/MIME signed message (RFC 4880 and 3156)\n'
    printf -- '--sig-b\n'
  } | crlf
  cat "$1"
  {
    printf -- '\n--sig-b\nContent-Type: application/pgp-signature; name="signature.asc"\nContent-Description: OpenPGP digital signature\nContent-Disposition: attachment; filename="signature.asc"\n\n'
    cat "$2"
    printf -- '\n--sig-b--\n'
  } | crlf
}
pgp_mime_signed "$WORK/signed-ed25519.part" "$WORK/signed-ed25519.sig" 'Alice Test <alice@example.test>' 'Signed with Ed25519' > "$OUT/pgp-mime-signed-ed25519.eml"

# ---- PGP/MIME signed, RSA-3072
{
  printf 'Content-Type: text/plain; charset=us-ascii\nContent-Transfer-Encoding: 7bit\n\n'
  printf 'Hi Alice,\n\nThis one is signed with RSA-3072.\n\nBob\n'
} | crlf > "$WORK/signed-rsa.part"
g --local-user "$B" --digest-algo SHA512 --armor --detach-sign -o "$WORK/signed-rsa.sig" "$WORK/signed-rsa.part"
pgp_mime_signed "$WORK/signed-rsa.part" "$WORK/signed-rsa.sig" 'Bob Test <bob@example.test>' 'Signed with RSA' \
  | sed 's/micalg=pgp-sha256/micalg=pgp-sha512/' > "$OUT/pgp-mime-signed-rsa.eml"

# ---- Inline cleartext signature (RFC 9580 §7), with a dash-escaped line and trailing whitespace.
printf 'Hello Bob,\n- this line starts with a dash\nThis line has trailing spaces   \nAlice\n' > "$WORK/clear.txt"
g --local-user "$A" --digest-algo SHA256 --clearsign -o "$WORK/clear.asc" "$WORK/clear.txt"
{
  printf 'From: Alice Test <alice@example.test>\nTo: Me <me@d3cloud.io>\nSubject: Clearsigned\nDate: %s\nMessage-ID: <%s@example.test>\nMIME-Version: 1.0\n' "$DATE" "$RANDOM$RANDOM"
  printf 'Content-Type: text/plain; charset=us-ascii\nContent-Transfer-Encoding: 7bit\n\n'
  cat "$WORK/clear.asc"
} | crlf > "$OUT/pgp-clearsigned.eml"

# ---- PGP/MIME encrypted (RFC 3156 §4)
{
  printf 'Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: 7bit\n\n'
  printf 'This is the secret body.\nOnly the recipient can read it.\n'
} | crlf > "$WORK/secret.part"

pgp_mime_encrypted() { # $1 armored message  $2 from  $3 to  $4 subject
  {
    printf 'From: %s\nTo: %s\nSubject: %s\nDate: %s\nMessage-ID: <%s@example.test>\nMIME-Version: 1.0\n' "$2" "$3" "$4" "$DATE" "$RANDOM$RANDOM"
    printf 'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="enc-b"\n\n'
    printf 'This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)\n'
    printf -- '--enc-b\nContent-Type: application/pgp-encrypted\nContent-Description: PGP/MIME version identification\n\nVersion: 1\n\n'
    printf -- '--enc-b\nContent-Type: application/octet-stream; name="encrypted.asc"\nContent-Description: OpenPGP encrypted message\nContent-Disposition: inline; filename="encrypted.asc"\n\n'
    cat "$1"
    printf -- '\n--enc-b--\n'
  } | crlf
}
g --recipient "$A" --armor --encrypt -o "$WORK/enc-alice.asc" "$WORK/secret.part"
pgp_mime_encrypted "$WORK/enc-alice.asc" 'Bob Test <bob@example.test>' 'Alice Test <alice@example.test>' 'Encrypted to Curve25519' > "$OUT/pgp-mime-encrypted-x25519.eml"

g --recipient "$B" --armor --encrypt -o "$WORK/enc-bob.asc" "$WORK/secret.part"
pgp_mime_encrypted "$WORK/enc-bob.asc" 'Alice Test <alice@example.test>' 'Bob Test <bob@example.test>' 'Encrypted to RSA' > "$OUT/pgp-mime-encrypted-rsa.eml"

# Signed by bob inside the encryption (one-pass signature, RFC 3156 §6.2 combined method).
g --local-user "$B" --recipient "$A" --digest-algo SHA256 --armor --sign --encrypt -o "$WORK/enc-signed.asc" "$WORK/secret.part"
pgp_mime_encrypted "$WORK/enc-signed.asc" 'Bob Test <bob@example.test>' 'Alice Test <alice@example.test>' 'Signed and encrypted' > "$OUT/pgp-mime-signed-encrypted.eml"

# LibrePGP OCB (packet tag 20): refused with a named reason.
g --recipient "$A" --force-ocb --armor --encrypt -o "$WORK/enc-ocb.asc" "$WORK/secret.part"
pgp_mime_encrypted "$WORK/enc-ocb.asc" 'Bob Test <bob@example.test>' 'Alice Test <alice@example.test>' 'Encrypted with OCB' > "$OUT/pgp-mime-encrypted-ocb.eml"

# ---- S/MIME: a test root, a test intermediate, and carol's leaf with an rfc822Name.
cd "$WORK"
cat > ca.cnf <<'EOF'
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[v3_leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = emailProtection
subjectAltName = email:carol@example.test
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -keyout root.key -out root.pem -days 36500 \
  -subj '/O=Postroom Test/CN=Postroom Test Root CA (TEST ONLY)' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null
"$OPENSSL" req -newkey rsa:2048 -nodes -keyout int.key -out int.csr -subj '/O=Postroom Test/CN=Postroom Test Intermediate CA (TEST ONLY)' 2>/dev/null
"$OPENSSL" x509 -req -in int.csr -CA root.pem -CAkey root.key -CAcreateserial -out int.pem -days 36500 -extfile ca.cnf -extensions v3_ca 2>/dev/null
"$OPENSSL" req -newkey rsa:2048 -nodes -keyout carol.key -out carol.csr -subj '/O=Postroom Test/CN=Carol Test/emailAddress=carol@example.test' 2>/dev/null
"$OPENSSL" x509 -req -in carol.csr -CA int.pem -CAkey int.key -CAcreateserial -out carol.pem -days 36500 -extfile ca.cnf -extensions v3_leaf 2>/dev/null
cp root.pem "$OUT/smime-root.pem"
cp int.pem "$OUT/smime-intermediate.pem"
cp carol.pem "$OUT/carol-smime.pem"
"$OPENSSL" pkcs8 -topk8 -nocrypt -in carol.key -out "$OUT/carol-smime.TEST-ONLY.key.pem"

printf 'Content-Type: text/plain; charset=us-ascii\n\nHello from Carol.\nThis message is S/MIME signed.\n' | crlf > smime.part
"$OPENSSL" smime -sign -in smime.part -signer carol.pem -inkey carol.key -certfile int.pem -md sha256 -crlfeol \
  -from 'Carol Test <carol@example.test>' -to 'Me <me@d3cloud.io>' -subject 'S/MIME signed' > "$OUT/smime-signed.eml"
"$OPENSSL" cms -sign -in smime.part -signer carol.pem -inkey carol.key -certfile int.pem -md sha256 -crlfeol \
  -from 'Carol Test <carol@example.test>' -to 'Me <me@d3cloud.io>' -subject 'CMS signed' > "$OUT/smime-cms-signed.eml"
"$OPENSSL" smime -encrypt -aes256 -in smime.part -crlfeol \
  -from 'Dave <dave@example.test>' -to 'Carol Test <carol@example.test>' -subject 'S/MIME encrypted' carol.pem > "$OUT/smime-encrypted.eml"

echo "fixtures written to $OUT"
