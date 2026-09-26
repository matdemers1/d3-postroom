// OpenPGP (RFC 9580/4880) and S/MIME (RFC 8551, CMS RFC 5652): formats parsed here, primitives from node:crypto.
export const PACKAGE = '@postroom/pgp';

export { ArmorError, BerError, CmsError, DerError, NotDerError, PgpError, UnsupportedError } from './errors.js';
export { crc24, decodeArmor, decodeArmors, encodeArmor, parseCleartext, radix64Decode, radix64Encode, type Armored, type ArmorType, type Cleartext } from './armor.js';
export { encodePacket, readPackets, Tag, type Packet } from './packets.js';
export { algorithmName, allMaterials, parseKeys, parsePublicKeyPacket, parseSecretKeyPacket, PublicKeyAlgorithm, userIdAddress, v4Fingerprint, type KeyMaterial, type KeySignature, type OpenPgpKey } from './keys.js';
export { keySignatureData, keyState, revokedAt, type KeyState, type Revocation } from './validity.js';
export { digestFor, hashName, isDocumentSignature, parseSignaturePacket, SignatureType, signatureTrailer, verifyDigest, type SignaturePacket, type Subpacket } from './signature.js';
export { decryptMessage, ecdhKdf, type DecryptionKey, type PgpDecryptResult, type PkeskInfo } from './decrypt.js';
export { children, decodeOid, definiteForm, derSetOf, encodeOid, encodeTlv, MAX_INDEFINITE_DEPTH, octets, readAll, readTlv, TagClass, UTag, type Encoding, type Tlv } from './der.js';
export {
  certificatesFromPem,
  chainOf,
  decryptEnvelopedData,
  parseCertificate,
  parseContentInfo,
  parseEnvelopedData,
  parseSignedData,
  rfc822Names,
  type Certificate,
  type Chain,
  type ChainLink,
  type EnvelopedData,
  type SignedData,
} from './cms.js';
export { delimiterKind, splitLines, walkMultipart, type ByteSource, type Line, type PartSink } from './stream.js';
export {
  analyzeMessage,
  DEFAULT_MAX_ENCRYPTED_BYTES,
  type AnalyzeOptions,
  type CryptoReport,
  type DecryptionStatus,
  type EncryptionReport,
  type KnownKey,
  type RecipientReport,
  type SignatureReport,
  type SignatureStatus,
  type SignerReport,
} from './analyze.js';
// PST-T-12.2: the writing side — key generation, signatures, encryption, CMS, and MIME framing.
export { publicPartLength } from './keys.js';
export { canEncryptTo, encryptionMaterials, signingAuthority, signingMaterials } from './validity.js';
export {
  canonicalText,
  encodeMpi,
  encodeSubpacket,
  encryptMessage,
  generateKey,
  isProtectedSecretBlock,
  literalPacket,
  makeSignature,
  protectSecretKeyBlock,
  publicKeyBlock,
  revocationSignature,
  RevocationReason,
  s2kCount,
  s2kDerive,
  signDetached,
  signDetachedPacket,
  signerOf,
  unlockSecretKeyBlock,
  withKeySignature,
  type DetachedOptions,
  type EncryptedRecipient,
  type EncryptResult,
  type GeneratedKey,
  type GenerateOptions,
  type Signer,
  type SignatureSpec,
} from './write.js';
export { derTime, encryptCmsEnveloped, signCmsDetached, type CmsSignOptions } from './cms-write.js';
export { entityBytes, pgpMimeEncrypt, pgpMimeSign, smimeEncrypt, smimeSign, type MimeEntity, type SmimeSigner } from './mime-write.js';
