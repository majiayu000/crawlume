import { inflateRawSync } from "node:zlib";

import { JSDOM } from "jsdom";

import { ReadError } from "./errors.js";

const RSL_NAMESPACE = "https://rslstandard.org/rsl";
const RSL_NAMESPACE_MARK = "rslstandard.org/rsl";
const XML_TEXT_NAME = /\.(?:opf|xml|xhtml|html)$/i;
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

const mediaTypes = new Set([
  "application/pdf",
  "application/epub+zip",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/tiff",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function startsWith(bytes: Uint8Array, ascii: string): boolean {
  if (bytes.byteLength < ascii.length) return false;
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
}

function asBytes(body: string, bodyBytes: Uint8Array | undefined): Uint8Array {
  return bodyBytes ?? new Uint8Array(Buffer.from(body, "latin1"));
}

function isEpubZip(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || readU32(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0) !== ZIP_LOCAL) {
    return false;
  }
  try {
    const files = unzip(bytes);
    const mime = files.get("mimetype");
    return mime !== undefined && Buffer.from(mime).toString("utf8").trim() === "application/epub+zip";
  } catch {
    return false;
  }
}

export function isMediaContainer(mediaType: string, body: string, bodyBytes?: Uint8Array): boolean {
  if (mediaTypes.has(mediaType)) return true;
  const bytes = asBytes(body, bodyBytes);
  if (startsWith(bytes, "%PDF-")) return true;
  if (mediaType === "application/zip" || mediaType === "application/octet-stream") {
    return isEpubZip(bytes);
  }
  return false;
}

function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 30 <= bytes.byteLength) {
    const signature = readU32(view, offset);
    if (signature === ZIP_CENTRAL || signature === ZIP_EOCD) break;
    if (signature !== ZIP_LOCAL) break;
    const method = readU16(view, offset + 8);
    const flags = readU16(view, offset + 6);
    if ((flags & 0x08) !== 0) {
      throw new ReadError("RSL_INVALID", "An EPUB container uses unsupported ZIP data descriptors.");
    }
    const compressedSize = readU32(view, offset + 18);
    const nameLength = readU16(view, offset + 26);
    const extraLength = readU16(view, offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) {
      throw new ReadError("RSL_INVALID", "An EPUB container is truncated.");
    }
    const name = Buffer.from(bytes.subarray(nameStart, nameEnd)).toString("utf8");
    const compressed = bytes.subarray(dataStart, dataEnd);
    if (method === 0) {
      files.set(name, compressed.slice());
    } else if (method === 8) {
      files.set(name, new Uint8Array(inflateRawSync(compressed)));
    }
    offset = dataEnd;
  }
  return files;
}

function extractTagged(text: string, localName: string): string[] {
  const fragments: string[] = [];
  const opener = new RegExp(`<((?:[A-Za-z_][\\w.-]*):)?${localName}(?=[\\s>/])`, "gi");
  let match = opener.exec(text);
  while (match !== null) {
    const prefix = match[1] ?? "";
    const start = match.index;
    const close = `</${prefix}${localName}`;
    const closeAt = text.indexOf(close, start + match[0].length);
    if (closeAt === -1) {
      match = opener.exec(text);
      continue;
    }
    const end = text.indexOf(">", closeAt);
    if (end === -1) {
      match = opener.exec(text);
      continue;
    }
    fragments.push(text.slice(start, end + 1));
    opener.lastIndex = end + 1;
    match = opener.exec(text);
  }
  return fragments;
}

function extractXpackets(text: string): string[] {
  const packets: string[] = [];
  const opener = /<\?xpacket begin\b/gi;
  let match = opener.exec(text);
  while (match !== null) {
    const closeAt = text.indexOf("<?xpacket end", match.index);
    if (closeAt === -1) break;
    const end = text.indexOf("?>", closeAt);
    if (end === -1) break;
    packets.push(text.slice(match.index, end + 2));
    opener.lastIndex = end + 2;
    match = opener.exec(text);
  }
  return packets;
}

function xmlText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

function encodedAscii(text: string, encoding: "utf16le" | "utf16be"): Buffer {
  const le = Buffer.from(text, "utf16le");
  if (encoding === "utf16le") return le;
  const be = Buffer.alloc(le.length);
  for (let index = 0; index < le.length; index += 2) {
    be[index] = le[index + 1]!;
    be[index + 1] = le[index]!;
  }
  return be;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.byteLength === 0 || from > haystack.byteLength - needle.byteLength) return -1;
  outer: for (let index = from; index <= haystack.byteLength - needle.byteLength; index += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function decodePacket(bytes: Uint8Array, encoding: "utf16le" | "utf16be"): string {
  if (encoding === "utf16le") return Buffer.from(bytes).toString("utf16le");
  const swapped = Buffer.alloc(bytes.byteLength);
  for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
    swapped[index] = bytes[index + 1]!;
    swapped[index + 1] = bytes[index]!;
  }
  return swapped.toString("utf16le");
}

function extractUtf16Xpackets(bytes: Uint8Array): string[] {
  const packets: string[] = [];
  for (const encoding of ["utf16le", "utf16be"] as const) {
    const begin = encodedAscii("<?xpacket begin", encoding);
    const end = encodedAscii("<?xpacket end", encoding);
    const close = encodedAscii("?>", encoding);
    let from = 0;
    while (from < bytes.byteLength) {
      const start = indexOfBytes(bytes, begin, from);
      if (start === -1) break;
      const endAt = indexOfBytes(bytes, end, start + begin.byteLength);
      if (endAt === -1) break;
      const closeAt = indexOfBytes(bytes, close, endAt + end.byteLength);
      if (closeAt === -1) break;
      const packetEnd = closeAt + close.byteLength;
      packets.push(decodePacket(bytes.subarray(start, packetEnd), encoding));
      from = packetEnd;
    }
  }
  return packets;
}

function toCoreDocument(xml: string): string | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new ReadError("RSL_INVALID", "RSL documents must not contain DTD or entity declarations.");
  }
  let document: Document;
  try {
    document = new JSDOM(xml, { contentType: "application/xml" }).window.document;
  } catch {
    return null;
  }
  const root = document.documentElement;
  if (root === null) return null;
  if (root.localName === "rsl" && root.namespaceURI === RSL_NAMESPACE) {
    return xml;
  }
  const contents = Array.from(document.getElementsByTagNameNS(RSL_NAMESPACE, "content"));
  if (contents.length === 0) return null;
  return `<rsl xmlns="${RSL_NAMESPACE}">${contents.map((content) => content.outerHTML).join("")}</rsl>`;
}

function documentsFromText(text: string): string[] {
  if (!text.includes(RSL_NAMESPACE_MARK)) {
    return [];
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new ReadError("RSL_INVALID", "RSL documents must not contain DTD or entity declarations.");
  }
  const trimmed = text.trim();
  const candidates = [
    ...extractTagged(text, "rsl"),
    ...extractXpackets(text).filter((packet) => packet.includes(RSL_NAMESPACE_MARK)),
    ...(trimmed.startsWith("<") ? [trimmed] : []),
  ];
  const documents: string[] = [];
  for (const candidate of candidates) {
    const converted = toCoreDocument(candidate);
    if (converted !== null) documents.push(converted);
  }
  if (documents.length === 0) {
    throw new ReadError("RSL_INVALID", "A media file declared RSL metadata that could not be parsed safely.");
  }
  return [...new Set(documents)];
}

function bomDecodedTexts(bytes: Uint8Array): string[] {
  if (bytes.byteLength < 2) return [];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return [Buffer.from(bytes.subarray(2)).toString("utf16le")];
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return [decodePacket(bytes.subarray(2), "utf16be")];
  }
  return [];
}

function documentsFromBytes(bytes: Uint8Array): string[] {
  const documents: string[] = [];
  for (const text of [xmlText(bytes), ...bomDecodedTexts(bytes), ...extractUtf16Xpackets(bytes)]) {
    if (!text.includes(RSL_NAMESPACE_MARK)) continue;
    documents.push(...documentsFromText(text));
  }
  return [...new Set(documents)];
}

function documentsFromContainer(bytes: Uint8Array): string[] {
  if (bytes.byteLength >= 4 && readU32(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0) === ZIP_LOCAL) {
    const documents: string[] = [];
    for (const [name, data] of unzip(bytes)) {
      if (!XML_TEXT_NAME.test(name)) continue;
      documents.push(...documentsFromBytes(data));
    }
    return [...new Set(documents)];
  }
  return documentsFromBytes(bytes);
}

export function mediaContainerLicenseXml(
  mediaType: string,
  body: string,
  bodyBytes?: Uint8Array,
): string[] {
  if (!isMediaContainer(mediaType, body, bodyBytes)) {
    return [];
  }
  try {
    return documentsFromContainer(asBytes(body, bodyBytes));
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError("RSL_INVALID", "A media file declared RSL metadata that could not be parsed safely.", {
      cause: error,
    });
  }
}
