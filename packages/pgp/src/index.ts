// OpenPGP (RFC 9580/4880) and S/MIME (RFC 8551, CMS RFC 5652): formats parsed here, primitives from node:crypto.
export const PACKAGE = '@postroom/pgp';

export { ArmorError, CmsError, DerError, PgpError, UnsupportedError } from './errors.js';
export { crc24, decodeArmor, decodeArmors, encodeArmor, parseCleartext, radix64Decode, radix64Encode, type Armored, type ArmorType, type Cleartext } from './armor.js';
export { encodePacket, readPackets, Tag, type Packet } from './packets.js';
export { algorithmName, allMaterials, parseKeys, parsePublicKeyPacket, parseSecretKeyPacket, PublicKeyAlgorithm, userIdAddress, v4Fingerprint, type KeyMaterial, type OpenPgpKey } from './keys.js';
export { digestFor, hashName, parseSignaturePacket, signatureTrailer, verifyDigest, type SignaturePacket, type Subpacket } from './signature.js';
export { decryptMessage, ecdhKdf, type DecryptionKey, type PgpDecryptResult, type PkeskInfo } from './decrypt.js';
export { children, decodeOid, encodeOid, encodeTlv, octets, readAll, readTlv, TagClass, UTag, type Tlv } from './der.js';
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
